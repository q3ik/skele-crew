#!/usr/bin/env node
/**
 * Hardened fork of @modelcontextprotocol/server-memory
 *
 * Modifications over the upstream source:
 *   1. Async mutex wraps the full read-modify-write cycle — prevents TOCTOU
 *      races from concurrent agent tool calls.
 *   2. Atomic writes: write to a .tmp file then fs.rename() into place.
 *   3. Auto-repair on load: corrupt/schema-invalid JSONL lines are skipped,
 *      duplicate entities/relations are deduplicated by (type, name|from) key.
 *   4. Default path resolves to <cwd>/memory/knowledge-graph.jsonl so all
 *      agents share the same graph regardless of where the package is installed.
 *   5. Legacy JSON migration properly converts JSON → JSONL instead of blindly
 *      renaming, preventing silent data loss.
 *
 * MCP protocol interfaces are unchanged.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Mutex } from 'async-mutex';
import { pruneGraph } from './pruning.js';

// ---------------------------------------------------------------------------
// Internal Zod schemas for JSONL line validation during load
// (separate from the MCP tool I/O schemas defined later)
// ---------------------------------------------------------------------------

const EntityLineSchema = z.object({
  type: z.literal("entity"),
  name: z.string(),
  entityType: z.string(),
  observations: z.array(z.string()).default([]),
});

const RelationLineSchema = z.object({
  type: z.literal("relation"),
  from: z.string(),
  to: z.string(),
  relationType: z.string(),
});

// ---------------------------------------------------------------------------
// Memory file path helpers
// ---------------------------------------------------------------------------

/**
 * Default memory path is anchored to process.cwd() so every agent process
 * (regardless of where the package is installed) reads/writes the same shared
 * graph at <repo-root>/memory/knowledge-graph.jsonl.
 */
export const defaultMemoryPath = path.resolve(process.cwd(), 'memory', 'knowledge-graph.jsonl');

/**
 * Write `content` to `destPath` atomically via a tmp file + rename.
 */
async function atomicWrite(destPath: string, content: string): Promise<void> {
  const dir = path.dirname(destPath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    throw new Error(`Failed to create directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const tmpPath = `${destPath}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, destPath);
}

/**
 * Migrate a legacy `memory.json` to the new JSONL format at `newPath`.
 *
 * The legacy format was a single JSON object `{ entities: [...], relations: [...] }`.
 * This function reads the file, detects its format, converts properly, and writes
 * atomically.  If the format is unrecognised it throws rather than silently
 * producing a corrupt JSONL file.
 */
export async function migrateLegacyJson(oldPath: string, newPath: string): Promise<void> {
  const content = await fs.readFile(oldPath, 'utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(
      `Legacy file ${oldPath} is not valid JSON; cannot migrate safely. ` +
      'Please manually migrate your data to JSONL format.'
    );
  }

  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    (Array.isArray((parsed as Record<string, unknown>)['entities']) ||
     Array.isArray((parsed as Record<string, unknown>)['relations']))
  ) {
    // Legacy JSON object — validate and convert each entry to a JSONL line.
    // Validation via the same Zod schemas used by loadGraph() ensures that
    // malformed or prototype-polluting data is rejected before writing.
    const obj = parsed as Record<string, unknown>;
    const lines: string[] = [];
    for (const e of (Array.isArray(obj['entities']) ? obj['entities'] : []) as unknown[]) {
      const result = EntityLineSchema.safeParse({ type: 'entity', ...(e as object) });
      if (result.success) {
        lines.push(JSON.stringify(result.data));
      } else {
        console.error('[migration] Skipping invalid entity during legacy migration');
      }
    }
    for (const r of (Array.isArray(obj['relations']) ? obj['relations'] : []) as unknown[]) {
      const result = RelationLineSchema.safeParse({ type: 'relation', ...(r as object) });
      if (result.success) {
        lines.push(JSON.stringify(result.data));
      } else {
        console.error('[migration] Skipping invalid relation during legacy migration');
      }
    }
    await atomicWrite(newPath, lines.join('\n'));
    await fs.unlink(oldPath);
    console.error('[migration] Successfully converted legacy memory.json to JSONL format');
    return;
  }

  throw new Error(
    `Legacy file ${oldPath} has an unexpected structure; cannot migrate safely. ` +
    'Please manually migrate your data to JSONL format.'
  );
}

export async function ensureMemoryFilePath(): Promise<string> {
  if (process.env.MEMORY_FILE_PATH) {
    // Fix #2: resolve relative paths from process.cwd(), not the package directory
    return path.isAbsolute(process.env.MEMORY_FILE_PATH)
      ? process.env.MEMORY_FILE_PATH
      : path.resolve(process.cwd(), process.env.MEMORY_FILE_PATH);
  }

  const newMemoryPath = defaultMemoryPath;
  // Check for a legacy memory.json in the same directory as the new file
  const oldMemoryPath = path.join(path.dirname(newMemoryPath), 'memory.json');

  try {
    await fs.access(oldMemoryPath);
    try {
      await fs.access(newMemoryPath);
      // Both exist — use the new file; leave the old one for manual review
      return newMemoryPath;
    } catch {
      // Old exists, new does not — migrate
      console.error('[migration] Found legacy memory.json file, migrating to JSONL format');
      await migrateLegacyJson(oldMemoryPath, newMemoryPath);
      return newMemoryPath;
    }
  } catch {
    // No legacy file — use new path
    return newMemoryPath;
  }
}

let MEMORY_FILE_PATH: string;

// ---------------------------------------------------------------------------
// Types (unchanged from upstream)
// ---------------------------------------------------------------------------

export interface Entity {
  name: string;
  entityType: string;
  observations: string[];
}

export interface Relation {
  from: string;
  to: string;
  relationType: string;
}

export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

// ---------------------------------------------------------------------------
// KnowledgeGraphManager — hardened implementation
// ---------------------------------------------------------------------------

export class KnowledgeGraphManager {
  /** Per-instance mutex: one saveGraph() at a time. */
  private readonly writeMutex = new Mutex();

  constructor(private memoryFilePath: string) {}

  // -------------------------------------------------------------------------
  // Hardening #3 — auto-repair on load
  //
  // • Invalid JSON lines are skipped.
  // • Schema-invalid lines (valid JSON but missing/wrong-typed fields) are
  //   also skipped via Zod safeParse — prevents downstream crashes in
  //   searchNodes/addObservations when fields are null or wrong type.
  // • Duplicate entries (same type + name/from key) are deduplicated,
  //   keeping only the first occurrence (earliest in file).
  // -------------------------------------------------------------------------
  private async loadGraph(): Promise<KnowledgeGraph> {
    try {
      const data = await fs.readFile(this.memoryFilePath, "utf-8");
      const lines = data.split("\n").filter(line => line.trim() !== "");

      const seen = new Set<string>();
      const graph: KnowledgeGraph = { entities: [], relations: [] };

      for (const line of lines) {
        // Step 1: parse JSON
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          // Hardening #3a — skip corrupt lines; log only byte count to avoid
          // exposing potentially sensitive content.
          console.error(`[memory-server] Skipping corrupt JSONL line (${line.length} bytes)`);
          continue;
        }

        // Step 2: validate schema and deduplicate
        if (raw !== null && typeof raw === 'object' && (raw as Record<string, unknown>)['type'] === 'entity') {
          const parsed = EntityLineSchema.safeParse(raw);
          if (!parsed.success) {
            console.error(`[memory-server] Skipping schema-invalid entity line (${line.length} bytes)`);
            continue;
          }
          const dedupeKey = `entity:${parsed.data.name}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          graph.entities.push({
            name: parsed.data.name,
            entityType: parsed.data.entityType,
            observations: parsed.data.observations,
          });
        } else if (raw !== null && typeof raw === 'object' && (raw as Record<string, unknown>)['type'] === 'relation') {
          const parsed = RelationLineSchema.safeParse(raw);
          if (!parsed.success) {
            console.error(`[memory-server] Skipping schema-invalid relation line (${line.length} bytes)`);
            continue;
          }
          const dedupeKey = `relation:${parsed.data.from}:${parsed.data.to}:${parsed.data.relationType}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          graph.relations.push({
            from: parsed.data.from,
            to: parsed.data.to,
            relationType: parsed.data.relationType,
          });
        }
        // Lines with unknown/missing type are silently ignored
      }

      return graph;
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return { entities: [], relations: [] };
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Hardening #2 — atomic write (used only from within the mutex)
  //
  // The atomic write pattern (write to .tmp → fs.rename) ensures that a
  // crash or process kill mid-write never leaves a partially-written file.
  // -------------------------------------------------------------------------
  private async saveGraphUnsafe(graph: KnowledgeGraph): Promise<void> {
    const lines = [
      ...graph.entities.map(e => JSON.stringify({
        type: "entity",
        name: e.name,
        entityType: e.entityType,
        observations: e.observations,
      })),
      ...graph.relations.map(r => JSON.stringify({
        type: "relation",
        from: r.from,
        to: r.to,
        relationType: r.relationType,
      })),
    ];
    // Delegates to the module-level atomicWrite which also ensures the
    // parent directory exists before writing.
    await atomicWrite(this.memoryFilePath, lines.join("\n"));
  }

  // -------------------------------------------------------------------------
  // Hardening #1 — mutex wrapping the full read-modify-write cycle
  //
  // Serialising only saveGraph() is insufficient because two concurrent
  // operations could both read the same baseline state and then each overwrite
  // the other's changes (TOCTOU race).  The mutex must guard the entire
  // load → modify → save sequence so that concurrent agent tool calls are
  // fully serialised and no writes are lost.
  // -------------------------------------------------------------------------
  private async modifyGraph<T>(fn: (graph: KnowledgeGraph) => T | Promise<T>): Promise<T> {
    return this.writeMutex.runExclusive(async () => {
      const graph = await this.loadGraph();
      const result = await fn(graph);
      await this.saveGraphUnsafe(graph);
      return result;
    });
  }

  // -------------------------------------------------------------------------
  // Public API — unchanged from upstream (backed by modifyGraph)
  // -------------------------------------------------------------------------

  /**
   * Run an arbitrary graph mutation atomically under the write mutex.
   *
   * The callback receives the current graph (already loaded) and may mutate
   * it in-place.  The updated graph is then saved atomically.  This is the
   * same contract as the private `modifyGraph` but exposed publicly so that
   * external code (e.g. CitationTracker) can perform complex read-modify-write
   * operations without TOCTOU races.
   */
  async updateGraph(fn: (graph: KnowledgeGraph) => void | Promise<void>): Promise<void> {
    await this.modifyGraph(fn);
  }

  async createEntities(entities: Entity[]): Promise<Entity[]> {
    return this.modifyGraph(graph => {
      const newEntities = entities.filter(e => !graph.entities.some(existing => existing.name === e.name));
      graph.entities.push(...newEntities);
      return newEntities;
    });
  }

  async createRelations(relations: Relation[]): Promise<Relation[]> {
    return this.modifyGraph(graph => {
      const newRelations = relations.filter(r => !graph.relations.some(existing =>
        existing.from === r.from &&
        existing.to === r.to &&
        existing.relationType === r.relationType
      ));
      graph.relations.push(...newRelations);
      return newRelations;
    });
  }

  async addObservations(observations: { entityName: string; contents: string[] }[]): Promise<{ entityName: string; addedObservations: string[] }[]> {
    return this.modifyGraph(graph => {
      return observations.map(o => {
        const entity = graph.entities.find(e => e.name === o.entityName);
        if (!entity) {
          throw new Error(`Entity with name ${o.entityName} not found`);
        }
        const newObservations = o.contents.filter(content => !entity.observations.includes(content));
        entity.observations.push(...newObservations);
        return { entityName: o.entityName, addedObservations: newObservations };
      });
    });
  }

  async deleteEntities(entityNames: string[]): Promise<void> {
    await this.modifyGraph(graph => {
      graph.entities = graph.entities.filter(e => !entityNames.includes(e.name));
      graph.relations = graph.relations.filter(r => !entityNames.includes(r.from) && !entityNames.includes(r.to));
    });
  }

  async deleteObservations(deletions: { entityName: string; observations: string[] }[]): Promise<void> {
    await this.modifyGraph(graph => {
      deletions.forEach(d => {
        const entity = graph.entities.find(e => e.name === d.entityName);
        if (entity) {
          entity.observations = entity.observations.filter(o => !d.observations.includes(o));
        }
      });
    });
  }

  async deleteRelations(relations: Relation[]): Promise<void> {
    await this.modifyGraph(graph => {
      graph.relations = graph.relations.filter(r => !relations.some(del =>
        r.from === del.from &&
        r.to === del.to &&
        r.relationType === del.relationType
      ));
    });
  }

  // -------------------------------------------------------------------------
  // Hardening #1 addendum — reads also go through the mutex
  //
  // Without this, a concurrent write + read can return a partially-written
  // or stale graph because loadGraph() reads directly from disk.  Wrapping
  // reads in the same exclusive lock serialises them with writes so every
  // read sees a fully-committed state.
  //
  // Trade-off: readers are serialised with writers (no reader/writer split).
  // For the expected low-concurrency agent workload this is the right call;
  // a shared-lock upgrade can be added later if throughput becomes a concern.
  // -------------------------------------------------------------------------

  async readGraph(): Promise<KnowledgeGraph> {
    return this.writeMutex.runExclusive(() => this.loadGraph());
  }

  async searchNodes(query: string): Promise<KnowledgeGraph> {
    return this.writeMutex.runExclusive(async () => {
      const graph = await this.loadGraph();

      const filteredEntities = graph.entities.filter(e =>
        e.name.toLowerCase().includes(query.toLowerCase()) ||
        e.entityType.toLowerCase().includes(query.toLowerCase()) ||
        e.observations.some(o => o.toLowerCase().includes(query.toLowerCase()))
      );

      const filteredEntityNames = new Set(filteredEntities.map(e => e.name));

      const filteredRelations = graph.relations.filter(r =>
        filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to)
      );

      return { entities: filteredEntities, relations: filteredRelations };
    });
  }

  async listEntitiesByPrefix(prefix: string): Promise<KnowledgeGraph> {
    return this.writeMutex.runExclusive(async () => {
      const graph = await this.loadGraph();

      const filteredEntities = graph.entities.filter(e => e.name.startsWith(prefix));
      const filteredEntityNames = new Set(filteredEntities.map(e => e.name));

      const filteredRelations = graph.relations.filter(r =>
        filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to)
      );

      return { entities: filteredEntities, relations: filteredRelations };
    });
  }

  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    return this.writeMutex.runExclusive(async () => {
      const graph = await this.loadGraph();

      const filteredEntities = graph.entities.filter(e => names.includes(e.name));
      const filteredEntityNames = new Set(filteredEntities.map(e => e.name));

      const filteredRelations = graph.relations.filter(r =>
        filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to)
      );

      return { entities: filteredEntities, relations: filteredRelations };
    });
  }
}

// ---------------------------------------------------------------------------
// Modification #6 — Citation tracking
//
// Records which entities are *cited* in agent responses during a session.
// The workflow per session:
//   1. Each read tool call buffers the returned entity names via recordRead().
//   2. After the agent produces a response, the agent calls the
//      record_citations MCP tool, which invokes recordCited(responseText).
//      recordCited() checks which buffered entity names appear in the text
//      and increments per-session citation counts for those matches only.
//   3. At session end (SIGTERM / SIGINT) flush() atomically merges the
//      per-session counts into the monthly metric entity.
//
// Metric entity format (matches docs/phase2-communication/README.md):
//   "entity:<name>:cited:<count>"        — one per tracked entity
//   "sessions_tracked:<N>"               — total sessions recorded this month
//   "last_updated:<YYYY-MM-DD>"          — date of last flush
//   "flagged_for_review:<name>"          — present after 30 sessions if cited:0
// ---------------------------------------------------------------------------

export class CitationTracker {
  /** Entity names returned by read tools this session — used for citation matching */
  private sessionReadBuffer = new Map<string, Entity>();
  /** Confirmed per-session citation counts: entity name → count */
  private sessionCitations = new Map<string, number>();

  /**
   * Buffer entities returned by a read tool call.
   * Does NOT increment citation counts — only marks entities as candidates
   * for citation matching when recordCited() is later called.
   */
  recordRead(entities: Entity[]): void {
    for (const entity of entities) {
      // Never track the metric entity itself
      if (entity.name.startsWith('metric:citation-tracking:')) continue;
      this.sessionReadBuffer.set(entity.name, entity);
    }
  }

  /**
   * Match buffered entity names against the agent response text and record
   * confirmed citations.  Call once per agent response (via the
   * record_citations MCP tool) after the agent produces output.
   *
   * Returns the number of distinct entity names that were newly matched.
   */
  recordCited(responseText: string): number {
    const lower = responseText.toLowerCase();
    let matched = 0;
    for (const name of this.sessionReadBuffer.keys()) {
      if (lower.includes(name.toLowerCase())) {
        this.sessionCitations.set(name, (this.sessionCitations.get(name) ?? 0) + 1);
        matched++;
      }
    }
    return matched;
  }

  /**
   * Flush per-session citation counts to the monthly metric entity.
   *
   * The entire read-parse-compute-write cycle runs inside a single
   * `manager.updateGraph()` call, which holds the mutex for the full
   * duration.  This prevents TOCTOU races when multiple flushes happen
   * concurrently (e.g. two agents shutting down simultaneously).
   *
   * Call once at end-of-session.
   */
  async flush(manager: KnowledgeGraphManager): Promise<void> {
    // Capture a single timestamp so the month key and the date stamp are
    // always consistent (fixes potential boundary split around midnight).
    const now = new Date();
    const yyyyMM = now.toISOString().slice(0, 7); // e.g. "2026-03"
    const today  = now.toISOString().slice(0, 10); // e.g. "2026-03-17"
    const metricName = `metric:citation-tracking:${yyyyMM}`;

    // Snapshot session citations before entering the lock so that any
    // recordCited() calls racing with flush() don't mutate the map mid-flight.
    const sessionCitationsSnapshot = new Map(this.sessionCitations);

    await manager.updateGraph(graph => {
      // -----------------------------------------------------------------
      // Step 1: Parse existing cumulative counts from the metric entity
      // -----------------------------------------------------------------
      const existing = graph.entities.find(e => e.name === metricName);
      const cumulativeCounts = new Map<string, number>();
      let sessionsTracked = 0;

      if (existing) {
        for (const obs of existing.observations) {
          const entityMatch = obs.match(/^entity:(.+):cited:(\d+)$/);
          if (entityMatch) {
            cumulativeCounts.set(entityMatch[1], parseInt(entityMatch[2], 10));
            continue;
          }
          const sessionMatch = obs.match(/^sessions_tracked:(\d+)$/);
          if (sessionMatch) {
            sessionsTracked = parseInt(sessionMatch[1], 10);
          }
        }
      }

      // -----------------------------------------------------------------
      // Step 2: Merge this session's citations into the cumulative totals
      // -----------------------------------------------------------------
      for (const [name, count] of sessionCitationsSnapshot) {
        cumulativeCounts.set(name, (cumulativeCounts.get(name) ?? 0) + count);
      }

      // -----------------------------------------------------------------
      // Step 3: Ensure every non-metric entity has a cited:0 baseline
      // -----------------------------------------------------------------
      for (const entity of graph.entities) {
        if (entity.name === metricName) continue;
        if (entity.name.startsWith('metric:citation-tracking:')) continue;
        if (!cumulativeCounts.has(entity.name)) {
          cumulativeCounts.set(entity.name, 0);
        }
      }

      sessionsTracked += 1;

      // -----------------------------------------------------------------
      // Step 4: Build observations array
      // -----------------------------------------------------------------
      const observations: string[] = [
        ...Array.from(cumulativeCounts.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, count]) => `entity:${name}:cited:${count}`),
        `sessions_tracked:${sessionsTracked}`,
        `last_updated:${today}`,
      ];

      // Flag entities with zero citations for review after 30 sessions
      if (sessionsTracked >= 30) {
        for (const [name, count] of Array.from(cumulativeCounts.entries()).sort(([a], [b]) => a.localeCompare(b))) {
          if (count === 0) {
            observations.push(`flagged_for_review:${name}`);
          }
        }
      }

      // -----------------------------------------------------------------
      // Step 5: Upsert the metric entity in-place (atomic, no separate
      // deleteEntities + createEntities transactions)
      // -----------------------------------------------------------------
      const metricEntity: Entity = { name: metricName, entityType: 'metric', observations };
      const idx = graph.entities.findIndex(e => e.name === metricName);
      if (idx >= 0) {
        graph.entities[idx] = metricEntity;
      } else {
        graph.entities.push(metricEntity);
      }
    });
  }
}

/** Module-level singleton used by the MCP tool handlers */
const citationTracker = new CitationTracker();

// ---------------------------------------------------------------------------
// MCP server setup (unchanged from upstream)
// ---------------------------------------------------------------------------

let knowledgeGraphManager: KnowledgeGraphManager;

const EntitySchema = z.object({
  name: z.string().describe("The name of the entity"),
  entityType: z.string().describe("The type of the entity"),
  observations: z.array(z.string()).describe("An array of observation contents associated with the entity"),
});

const RelationSchema = z.object({
  from: z.string().describe("The name of the entity where the relation starts"),
  to: z.string().describe("The name of the entity where the relation ends"),
  relationType: z.string().describe("The type of the relation"),
});

const server = new McpServer({
  name: "memory-server",
  version: "0.6.3",
});

server.registerTool(
  "create_entities",
  {
    title: "Create Entities",
    description: "Create multiple new entities in the knowledge graph",
    inputSchema: { entities: z.array(EntitySchema) },
    outputSchema: { entities: z.array(EntitySchema) },
  },
  async ({ entities }) => {
    const result = await knowledgeGraphManager.createEntities(entities);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { entities: result },
    };
  }
);

server.registerTool(
  "create_relations",
  {
    title: "Create Relations",
    description: "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
    inputSchema: { relations: z.array(RelationSchema) },
    outputSchema: { relations: z.array(RelationSchema) },
  },
  async ({ relations }) => {
    const result = await knowledgeGraphManager.createRelations(relations);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { relations: result },
    };
  }
);

server.registerTool(
  "add_observations",
  {
    title: "Add Observations",
    description: "Add new observations to existing entities in the knowledge graph",
    inputSchema: {
      observations: z.array(z.object({
        entityName: z.string().describe("The name of the entity to add the observations to"),
        contents: z.array(z.string()).describe("An array of observation contents to add"),
      })),
    },
    outputSchema: {
      results: z.array(z.object({
        entityName: z.string(),
        addedObservations: z.array(z.string()),
      })),
    },
  },
  async ({ observations }) => {
    const result = await knowledgeGraphManager.addObservations(observations);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { results: result },
    };
  }
);

server.registerTool(
  "delete_entities",
  {
    title: "Delete Entities",
    description: "Delete multiple entities and their associated relations from the knowledge graph",
    inputSchema: { entityNames: z.array(z.string()).describe("An array of entity names to delete") },
    outputSchema: { success: z.boolean(), message: z.string() },
  },
  async ({ entityNames }) => {
    await knowledgeGraphManager.deleteEntities(entityNames);
    return {
      content: [{ type: "text" as const, text: "Entities deleted successfully" }],
      structuredContent: { success: true, message: "Entities deleted successfully" },
    };
  }
);

server.registerTool(
  "delete_observations",
  {
    title: "Delete Observations",
    description: "Delete specific observations from entities in the knowledge graph",
    inputSchema: {
      deletions: z.array(z.object({
        entityName: z.string().describe("The name of the entity containing the observations"),
        observations: z.array(z.string()).describe("An array of observations to delete"),
      })),
    },
    outputSchema: { success: z.boolean(), message: z.string() },
  },
  async ({ deletions }) => {
    await knowledgeGraphManager.deleteObservations(deletions);
    return {
      content: [{ type: "text" as const, text: "Observations deleted successfully" }],
      structuredContent: { success: true, message: "Observations deleted successfully" },
    };
  }
);

server.registerTool(
  "delete_relations",
  {
    title: "Delete Relations",
    description: "Delete multiple relations from the knowledge graph",
    inputSchema: { relations: z.array(RelationSchema).describe("An array of relations to delete") },
    outputSchema: { success: z.boolean(), message: z.string() },
  },
  async ({ relations }) => {
    await knowledgeGraphManager.deleteRelations(relations);
    return {
      content: [{ type: "text" as const, text: "Relations deleted successfully" }],
      structuredContent: { success: true, message: "Relations deleted successfully" },
    };
  }
);

server.registerTool(
  "read_graph",
  {
    title: "Read Graph",
    description: "Read the entire knowledge graph",
    inputSchema: {},
    outputSchema: { entities: z.array(EntitySchema), relations: z.array(RelationSchema) },
  },
  async () => {
    const graph = await knowledgeGraphManager.readGraph();
    citationTracker.recordRead(graph.entities);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph },
    };
  }
);

server.registerTool(
  "search_nodes",
  {
    title: "Search Nodes",
    description: "Search for nodes in the knowledge graph based on a query",
    inputSchema: { query: z.string().describe("The search query to match against entity names, types, and observation content") },
    outputSchema: { entities: z.array(EntitySchema), relations: z.array(RelationSchema) },
  },
  async ({ query }) => {
    const graph = await knowledgeGraphManager.searchNodes(query);
    citationTracker.recordRead(graph.entities);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph },
    };
  }
);

server.registerTool(
  "list_entities_by_prefix",
  {
    title: "List Entities By Prefix",
    description: "Return all entities whose name starts with the given namespace prefix (e.g. 'product:buzzy-game'). Unlike search_nodes, this matches only entity names and never observation text, so results are strictly scoped to the requested namespace.",
    inputSchema: { prefix: z.string().describe("The namespace prefix to filter by, e.g. 'product:buzzy-game'") },
    outputSchema: { entities: z.array(EntitySchema), relations: z.array(RelationSchema) },
  },
  async ({ prefix }) => {
    const graph = await knowledgeGraphManager.listEntitiesByPrefix(prefix);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph },
    };
  }
);

server.registerTool(
  "open_nodes",
  {
    title: "Open Nodes",
    description: "Open specific nodes in the knowledge graph by their names",
    inputSchema: { names: z.array(z.string()).describe("An array of entity names to retrieve") },
    outputSchema: { entities: z.array(EntitySchema), relations: z.array(RelationSchema) },
  },
  async ({ names }) => {
    const graph = await knowledgeGraphManager.openNodes(names);
    citationTracker.recordRead(graph.entities);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph },
    };
  }
);

server.registerTool(
  "record_citations",
  {
    title: "Record Citations",
    description:
      "Record which knowledge-graph entities appear in an agent response. " +
      "Call once per agent response, passing the full response text. " +
      "Only entity names that were returned by a prior read_graph / search_nodes / " +
      "open_nodes call this session are eligible for citation matching.",
    inputSchema: {
      responseText: z.string().describe("The agent's full response text"),
    },
    outputSchema: { citedCount: z.number() },
  },
  async ({ responseText }) => {
    const citedCount = citationTracker.recordCited(responseText);
    return {
      content: [{ type: "text" as const, text: `Recorded ${citedCount} citation(s) from response text` }],
      structuredContent: { citedCount },
    };
  }
);

server.registerTool(
  "prune_graph",
  {
    title: "Prune Graph",
    description:
      "Apply retention rules to the knowledge graph: remove standup entities older than 7 days, " +
      "archive metric entities older than 90 days (summary kept, per-entity detail dropped), " +
      "and preserve lesson/decision/deadline entities permanently. " +
      "Run weekly as part of the COO review.",
    inputSchema: {},
    outputSchema: {
      removedCount: z.number().describe("Number of standup entities removed"),
      archivedCount: z.number().describe("Number of metric entities archived"),
      totalBefore: z.number().describe("Total entity count before pruning"),
      totalAfter: z.number().describe("Total entity count after pruning"),
    },
  },
  async () => {
    let removedCount = 0;
    let archivedCount = 0;
    let totalBefore = 0;
    let totalAfter = 0;

    await knowledgeGraphManager.updateGraph(graph => {
      totalBefore = graph.entities.length;
      const result = pruneGraph(graph.entities, graph.relations, new Date());
      removedCount = result.removedCount;
      archivedCount = result.archivedCount;
      graph.entities = result.entities;
      graph.relations = result.relations;
      totalAfter = graph.entities.length;
    });

    const summary =
      `Pruned graph: ${removedCount} standup(s) removed, ${archivedCount} metric(s) archived. ` +
      `Entities: ${totalBefore} → ${totalAfter}.`;
    return {
      content: [{ type: "text" as const, text: summary }],
      structuredContent: { removedCount, archivedCount, totalBefore, totalAfter },
    };
  }
);

async function main() {
  MEMORY_FILE_PATH = await ensureMemoryFilePath();
  knowledgeGraphManager = new KnowledgeGraphManager(MEMORY_FILE_PATH);

  // Flush citation counts when the server is shut down gracefully.
  // A guard prevents a double-flush if both SIGTERM and SIGINT arrive together.
  let shuttingDown = false;
  async function flushCitationsAndExit(signalName: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[citation-tracking] ${signalName} received; flushing citation counts`);
    try {
      await citationTracker.flush(knowledgeGraphManager);
      console.error('[citation-tracking] Flush complete');
    } catch (err) {
      console.error('[citation-tracking] Flush failed:', err instanceof Error ? err.message : String(err));
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => { void flushCitationsAndExit('SIGTERM'); });
  process.on('SIGINT',  () => { void flushCitationsAndExit('SIGINT'); });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}

// Issue #1 fix: only start the stdio server when this module is executed
// directly as a CLI entry point (process.argv[1] points at this file).
// Importing KnowledgeGraphManager in tests or other modules does NOT start
// the server.
//
// Both paths are normalised before comparison to handle Windows path separator
// and casing differences.
const isMain =
  process.argv[1] !== undefined &&
  path.normalize(path.resolve(process.argv[1])) ===
    path.normalize(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
  });
}
