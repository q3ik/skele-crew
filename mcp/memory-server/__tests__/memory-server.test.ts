/**
 * Acceptance-criteria tests for the hardened MCP memory server.
 *
 * Each describe block maps to exactly one acceptance criterion from the issue:
 *   1. Clean load of valid JSONL
 *   2. Load with corrupt lines — corrupt lines skipped, valid lines preserved
 *   3. Load with duplicate entities — dedup by (type, name) key
 *   4. Atomic write — file content correct after save
 *   5. Concurrent saves — both complete without data loss
 *   6. Pruning — standup older than 7 days removed, lesson preserved
 *   7. Citation tracking — read wrapper updates metric entity
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { KnowledgeGraphManager, CitationTracker, Entity, Relation } from '../index.js';
import { pruneGraph } from '../pruning.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

function tmpPath(): string {
  return path.join(testDir, `ms-test-${randomUUID()}.jsonl`);
}

async function cleanup(...files: string[]): Promise<void> {
  for (const f of files) {
    try { await fs.unlink(f); } catch { /* ignore missing */ }
    try { await fs.unlink(`${f}.tmp`); } catch { /* ignore missing */ }
  }
}

// ---------------------------------------------------------------------------
// 1. Clean load of valid JSONL
// ---------------------------------------------------------------------------

describe('AC1 — clean load of valid JSONL', () => {
  let filePath: string;

  beforeEach(() => { filePath = tmpPath(); });
  afterEach(async () => { await cleanup(filePath); });

  it('loads all entities and relations from a well-formed JSONL file', async () => {
    const lines = [
      JSON.stringify({ type: 'entity', name: 'product:alpha', entityType: 'product', observations: ['status:active'] }),
      JSON.stringify({ type: 'entity', name: 'lesson:test-first', entityType: 'lesson', observations: ['always write tests'] }),
      JSON.stringify({ type: 'relation', from: 'product:alpha', to: 'lesson:test-first', relationType: 'guided-by' }),
    ].join('\n');

    await fs.writeFile(filePath, lines, 'utf-8');

    const manager = new KnowledgeGraphManager(filePath);
    const graph = await manager.readGraph();

    expect(graph.entities).toHaveLength(2);
    expect(graph.relations).toHaveLength(1);

    const names = graph.entities.map(e => e.name);
    expect(names).toContain('product:alpha');
    expect(names).toContain('lesson:test-first');
    expect(graph.entities.find(e => e.name === 'product:alpha')?.observations).toEqual(['status:active']);
    expect(graph.relations[0]).toMatchObject({ from: 'product:alpha', to: 'lesson:test-first', relationType: 'guided-by' });
  });
});

// ---------------------------------------------------------------------------
// 2. Load with corrupt lines — corrupt lines skipped, valid lines preserved
// ---------------------------------------------------------------------------

describe('AC2 — corrupt JSONL lines are skipped; valid lines preserved', () => {
  let filePath: string;

  beforeEach(() => { filePath = tmpPath(); });
  afterEach(async () => { await cleanup(filePath); });

  it('skips corrupt lines and returns only the valid entities', async () => {
    const content = [
      JSON.stringify({ type: 'entity', name: 'valid-first', entityType: 'test', observations: [] }),
      'THIS IS NOT JSON }{',                  // corrupt — must be skipped
      '',                                      // blank — must be skipped
      JSON.stringify({ type: 'entity', name: 'valid-second', entityType: 'test', observations: [] }),
      '{"broken":',                            // truncated JSON — must be skipped
    ].join('\n');

    await fs.writeFile(filePath, content, 'utf-8');

    const manager = new KnowledgeGraphManager(filePath);
    const graph = await manager.readGraph();

    expect(graph.entities).toHaveLength(2);
    const names = graph.entities.map(e => e.name);
    expect(names).toContain('valid-first');
    expect(names).toContain('valid-second');
  });

  it('returns an empty graph when every line is corrupt — no throw', async () => {
    await fs.writeFile(filePath, 'garbage\n{bad json\n', 'utf-8');

    const manager = new KnowledgeGraphManager(filePath);
    await expect(manager.readGraph()).resolves.toEqual({ entities: [], relations: [] });
  });
});

// ---------------------------------------------------------------------------
// 3. Load with duplicate entities — dedup by (type, name) key
// ---------------------------------------------------------------------------

describe('AC3 — duplicate entities are deduplicated on load', () => {
  let filePath: string;

  beforeEach(() => { filePath = tmpPath(); });
  afterEach(async () => { await cleanup(filePath); });

  it('keeps only the first occurrence of a duplicate entity by name', async () => {
    const content = [
      JSON.stringify({ type: 'entity', name: 'product:buzzy', entityType: 'product', observations: ['v1'] }),
      JSON.stringify({ type: 'entity', name: 'product:buzzy', entityType: 'product', observations: ['v2-duplicate'] }),
      JSON.stringify({ type: 'entity', name: 'lesson:unique', entityType: 'lesson', observations: [] }),
    ].join('\n');

    await fs.writeFile(filePath, content, 'utf-8');

    const manager = new KnowledgeGraphManager(filePath);
    const graph = await manager.readGraph();

    expect(graph.entities).toHaveLength(2);
    // First occurrence wins
    const buzzy = graph.entities.find(e => e.name === 'product:buzzy');
    expect(buzzy?.observations).toEqual(['v1']);
  });

  it('keeps only the first occurrence of a duplicate relation', async () => {
    const content = [
      JSON.stringify({ type: 'relation', from: 'A', to: 'B', relationType: 'knows' }),
      JSON.stringify({ type: 'relation', from: 'A', to: 'B', relationType: 'knows' }),
    ].join('\n');

    await fs.writeFile(filePath, content, 'utf-8');

    const manager = new KnowledgeGraphManager(filePath);
    const graph = await manager.readGraph();

    expect(graph.relations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Atomic write — file content correct after save
// ---------------------------------------------------------------------------

describe('AC4 — atomic write: file content is correct after save', () => {
  let filePath: string;

  beforeEach(() => { filePath = tmpPath(); });
  afterEach(async () => { await cleanup(filePath); });

  it('the written file contains exactly the saved entities and relations as valid JSONL', async () => {
    const manager = new KnowledgeGraphManager(filePath);

    await manager.createEntities([
      { name: 'entity-one', entityType: 'product', observations: ['obs-1'] },
      { name: 'entity-two', entityType: 'lesson', observations: ['obs-2'] },
    ]);
    await manager.createRelations([
      { from: 'entity-one', to: 'entity-two', relationType: 'links-to' },
    ]);

    const raw = await fs.readFile(filePath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());

    // Every line must be parseable JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // Entities and relations are present
    const parsed = lines.map(l => JSON.parse(l));
    const entityLines = parsed.filter((l: { type: string }) => l.type === 'entity');
    const relationLines = parsed.filter((l: { type: string }) => l.type === 'relation');
    expect(entityLines).toHaveLength(2);
    expect(relationLines).toHaveLength(1);

    // No stale .tmp file left behind
    const tmpExists = await fs.access(`${filePath}.tmp`).then(() => true).catch(() => false);
    expect(tmpExists).toBe(false);
  });

  it('a second manager reading the same file sees the same data', async () => {
    const manager1 = new KnowledgeGraphManager(filePath);
    await manager1.createEntities([
      { name: 'shared-entity', entityType: 'product', observations: ['persisted'] },
    ]);

    const manager2 = new KnowledgeGraphManager(filePath);
    const graph = await manager2.readGraph();

    expect(graph.entities).toHaveLength(1);
    expect(graph.entities[0].name).toBe('shared-entity');
    expect(graph.entities[0].observations).toContain('persisted');
  });
});

// ---------------------------------------------------------------------------
// 5. Concurrent saves — both complete without data loss
// ---------------------------------------------------------------------------

describe('AC5 — concurrent saves complete without data loss', () => {
  let filePath: string;

  beforeEach(() => { filePath = tmpPath(); });
  afterEach(async () => { await cleanup(filePath); });

  it('two parallel createEntities calls both persist all their data', async () => {
    const manager = new KnowledgeGraphManager(filePath);

    const batchA: Entity[] = Array.from({ length: 5 }, (_, i) => ({
      name: `concurrent-a-${i}`,
      entityType: 'test',
      observations: [],
    }));
    const batchB: Entity[] = Array.from({ length: 5 }, (_, i) => ({
      name: `concurrent-b-${i}`,
      entityType: 'test',
      observations: [],
    }));

    // Both writes fire at the same time — the mutex must serialise them
    await Promise.all([
      manager.createEntities(batchA),
      manager.createEntities(batchB),
    ]);

    const graph = await manager.readGraph();
    expect(graph.entities).toHaveLength(10);

    const names = new Set(graph.entities.map(e => e.name));
    for (let i = 0; i < 5; i++) {
      expect(names.has(`concurrent-a-${i}`)).toBe(true);
      expect(names.has(`concurrent-b-${i}`)).toBe(true);
    }
  });

  it('many parallel writes (20) all succeed and produce a consistent graph', async () => {
    const manager = new KnowledgeGraphManager(filePath);

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        manager.createEntities([{ name: `parallel-${i}`, entityType: 'test', observations: [] }])
      )
    );

    const graph = await manager.readGraph();
    expect(graph.entities).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// 6. Pruning — standup older than 7 days removed, lesson preserved
// ---------------------------------------------------------------------------

describe('AC6 — pruning: stale standup removed, lesson preserved', () => {
  /** Fixed reference point: 2026-03-17 noon UTC */
  const NOW = new Date('2026-03-17T12:00:00.000Z');

  function daysAgoDate(days: number): string {
    const d = new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }

  it('removes a standup entity whose date is 8 days before now', () => {
    const staleDate = daysAgoDate(8);
    const entities: Entity[] = [
      { name: `standup:${staleDate}`, entityType: 'standup', observations: ['Done.'] },
    ];

    const { entities: result, removedCount } = pruneGraph(entities, [], NOW);

    expect(result).toHaveLength(0);
    expect(removedCount).toBe(1);
  });

  it('preserves a standup entity whose date is 6 days before now', () => {
    const recentDate = daysAgoDate(6);
    const entities: Entity[] = [
      { name: `standup:${recentDate}`, entityType: 'standup', observations: [] },
    ];

    const { entities: result } = pruneGraph(entities, [], NOW);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe(`standup:${recentDate}`);
  });

  it('preserves a lesson entity regardless of how old its date is', () => {
    const veryOldDate = daysAgoDate(365);
    const entities: Entity[] = [
      { name: `lesson:${veryOldDate}:always-write-tests`, entityType: 'lesson', observations: ['important'] },
    ];

    const { entities: result, removedCount } = pruneGraph(entities, [], NOW);

    expect(result).toHaveLength(1);
    expect(result[0].name).toContain('lesson:');
    expect(removedCount).toBe(0);
  });

  it('removes stale standups while preserving lessons in the same graph', () => {
    const staleDate = daysAgoDate(10);
    const entities: Entity[] = [
      { name: `standup:${staleDate}`, entityType: 'standup', observations: [] },
      { name: `standup:${daysAgoDate(2)}`, entityType: 'standup', observations: [] },
      { name: 'lesson:2026-01:be-explicit', entityType: 'lesson', observations: ['keep me'] },
    ];

    const { entities: result, removedCount } = pruneGraph(entities, [], NOW);

    expect(removedCount).toBe(1);
    const remainingNames = result.map(e => e.name);
    expect(remainingNames).not.toContain(`standup:${staleDate}`);
    expect(remainingNames).toContain(`standup:${daysAgoDate(2)}`);
    expect(remainingNames).toContain('lesson:2026-01:be-explicit');
  });

  it('drops relations whose from/to entity was removed by pruning', () => {
    const staleDate = daysAgoDate(9);
    const staleName = `standup:${staleDate}`;
    const entities: Entity[] = [
      { name: staleName, entityType: 'standup', observations: [] },
      { name: 'lesson:always-test', entityType: 'lesson', observations: [] },
    ];
    const relations: Relation[] = [
      { from: staleName, to: 'lesson:always-test', relationType: 'references' },
    ];

    const { entities: resultE, relations: resultR } = pruneGraph(entities, relations, NOW);

    expect(resultE.some(e => e.name === staleName)).toBe(false);
    expect(resultR).toHaveLength(0); // relation referencing removed entity is dropped
  });
});

// ---------------------------------------------------------------------------
// 7. Citation tracking — read wrapper updates metric entity
// ---------------------------------------------------------------------------

describe('AC7 — citation tracking: read wrapper updates metric entity', () => {
  let filePath: string;
  let manager: KnowledgeGraphManager;

  beforeEach(async () => {
    filePath = tmpPath();
    manager = new KnowledgeGraphManager(filePath);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanup(filePath);
  });

  it('flush creates the monthly metric entity with entity citation counts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-17T10:00:00.000Z'));

    await manager.createEntities([
      { name: 'product:buzzy-game', entityType: 'product', observations: [] },
      { name: 'deadline:Q2-hst', entityType: 'deadline', observations: [] },
    ]);

    const tracker = new CitationTracker();
    const graph = await manager.readGraph();

    // Simulate the read_graph MCP tool calling recordRead on returned entities
    tracker.recordRead(graph.entities);

    // Simulate agent response text that mentions one of the entities
    tracker.recordCited('Daily standup: product:buzzy-game is on track. No blockers.');
    // deadline:Q2-hst is NOT mentioned → will have cited:0

    await tracker.flush(manager);

    const updated = await manager.readGraph();
    const metric = updated.entities.find(e => e.name === 'metric:citation-tracking:2026-03');

    expect(metric).toBeDefined();
    expect(metric!.entityType).toBe('metric');
    expect(metric!.observations).toContain('entity:product:buzzy-game:cited:1');
    expect(metric!.observations).toContain('entity:deadline:Q2-hst:cited:0');
    expect(metric!.observations).toContain('sessions_tracked:1');
    expect(metric!.observations).toContain('last_updated:2026-03-17');
  });

  it('metric name uses the current calendar month (controlled via fake timers)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-11-15T08:00:00.000Z'));

    const tracker = new CitationTracker();
    await tracker.flush(manager);

    const graph = await manager.readGraph();
    const metric = graph.entities.find(e => e.name === 'metric:citation-tracking:2025-11');
    expect(metric).toBeDefined();
    expect(metric!.observations).toContain('sessions_tracked:1');
  });

  it('citation counts accumulate across multiple sessions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-17T10:00:00.000Z'));

    await manager.createEntities([
      { name: 'product:buzzy-game', entityType: 'product', observations: [] },
    ]);

    // Session 1
    const t1 = new CitationTracker();
    t1.recordRead([{ name: 'product:buzzy-game', entityType: 'product', observations: [] }]);
    t1.recordCited('product:buzzy-game is active.');
    await t1.flush(manager);

    // Session 2
    const t2 = new CitationTracker();
    t2.recordRead([{ name: 'product:buzzy-game', entityType: 'product', observations: [] }]);
    t2.recordCited('product:buzzy-game reviewed.');
    await t2.flush(manager);

    const graph = await manager.readGraph();
    const metric = graph.entities.find(e => e.name === 'metric:citation-tracking:2026-03');

    expect(metric!.observations).toContain('entity:product:buzzy-game:cited:2');
    expect(metric!.observations).toContain('sessions_tracked:2');
  });
});
