#!/usr/bin/env node
/**
 * Hardened fork of @modelcontextprotocol/server-memory
 *
 * Modifications over the upstream source:
 *   1. Async mutex wraps saveGraph() — prevents concurrent write races.
 *   2. Atomic writes: write to a .tmp file then fs.rename() into place.
 *   3. Auto-repair on load: corrupt JSONL lines are skipped, duplicate
 *      entities/relations are deduplicated by (type, name|from) key.
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

// ---------------------------------------------------------------------------
// Memory file path helpers (unchanged from upstream)
// ---------------------------------------------------------------------------

export const defaultMemoryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory.jsonl');

export async function ensureMemoryFilePath(): Promise<string> {
  if (process.env.MEMORY_FILE_PATH) {
    return path.isAbsolute(process.env.MEMORY_FILE_PATH)
      ? process.env.MEMORY_FILE_PATH
      : path.join(path.dirname(fileURLToPath(import.meta.url)), process.env.MEMORY_FILE_PATH);
  }

  const oldMemoryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory.json');
  const newMemoryPath = defaultMemoryPath;

  try {
    await fs.access(oldMemoryPath);
    try {
      await fs.access(newMemoryPath);
      return newMemoryPath;
    } catch {
      console.error('DETECTED: Found legacy memory.json file, migrating to memory.jsonl for JSONL format compatibility');
      await fs.rename(oldMemoryPath, newMemoryPath);
      console.error('COMPLETED: Successfully migrated memory.json to memory.jsonl');
      return newMemoryPath;
    }
  } catch {
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
  // • Invalid JSON lines are silently skipped instead of throwing.
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
        let item: Record<string, unknown>;
        try {
          item = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // Hardening #3a — skip corrupt lines; log only a length indicator to
          // avoid exposing potentially sensitive content in logs.
          console.error(`[memory-server] Skipping corrupt JSONL line (${line.length} bytes)`);
          continue;
        }

        // Hardening #3b — deduplicate
        let dedupeKey: string | null;
        if (item['type'] === 'entity') {
          dedupeKey = `entity:${item['name']}`;
        } else if (item['type'] === 'relation') {
          dedupeKey = `relation:${item['from']}:${item['to']}:${item['relationType']}`;
        } else {
          dedupeKey = null;
        }

        if (dedupeKey !== null) {
          if (seen.has(dedupeKey)) {
            continue;
          }
          seen.add(dedupeKey);
        }

        if (item['type'] === "entity") {
          graph.entities.push({
            name: item['name'] as string,
            entityType: item['entityType'] as string,
            observations: item['observations'] as string[],
          });
        } else if (item['type'] === "relation") {
          graph.relations.push({
            from: item['from'] as string,
            to: item['to'] as string,
            relationType: item['relationType'] as string,
          });
        }
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
    // Hardening #2 — atomic write via tmp file + rename
    const tmpPath = `${this.memoryFilePath}.tmp`;
    await fs.writeFile(tmpPath, lines.join("\n"), "utf-8");
    await fs.rename(tmpPath, this.memoryFilePath);
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

  async readGraph(): Promise<KnowledgeGraph> {
    return this.loadGraph();
  }

  async searchNodes(query: string): Promise<KnowledgeGraph> {
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
  }

  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();

    const filteredEntities = graph.entities.filter(e => names.includes(e.name));
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));

    const filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to)
    );

    return { entities: filteredEntities, relations: filteredRelations };
  }
}

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
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph },
    };
  }
);

async function main() {
  MEMORY_FILE_PATH = await ensureMemoryFilePath();
  knowledgeGraphManager = new KnowledgeGraphManager(MEMORY_FILE_PATH);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
