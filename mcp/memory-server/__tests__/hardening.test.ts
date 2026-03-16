/**
 * Tests for the three hardening modifications added to the forked MCP memory server:
 *   1. Async mutex — two parallel writes complete without corruption
 *   2. Atomic writes — write to .tmp then fs.rename()
 *   3. Auto-repair on load — corrupt lines skipped, duplicates deduplicated
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { KnowledgeGraphManager, Entity } from '../index.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

function tmpFile(suffix = ''): string {
  return path.join(testDir, `test-hardening-${randomUUID()}${suffix}.jsonl`);
}

async function cleanup(...files: string[]) {
  for (const f of files) {
    try { await fs.unlink(f); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// 1. Async mutex — parallel writes must not corrupt the file
// ---------------------------------------------------------------------------
describe('Hardening #1 — async mutex prevents concurrent write corruption', () => {
  let filePath: string;

  beforeEach(() => { filePath = tmpFile(); });
  afterEach(async () => { await cleanup(filePath, `${filePath}.tmp`); });

  it('two parallel writes complete and the final file contains all entities', async () => {
    const manager = new KnowledgeGraphManager(filePath);

    // Seed a starting entity so the file exists
    await manager.createEntities([
      { name: 'Seed', entityType: 'test', observations: [] },
    ]);

    // Fire two creates concurrently — without a mutex these can race
    const batchA: Entity[] = Array.from({ length: 5 }, (_, i) => ({
      name: `EntityA${i}`,
      entityType: 'test',
      observations: [`obs-a${i}`],
    }));
    const batchB: Entity[] = Array.from({ length: 5 }, (_, i) => ({
      name: `EntityB${i}`,
      entityType: 'test',
      observations: [`obs-b${i}`],
    }));

    await Promise.all([
      manager.createEntities(batchA),
      manager.createEntities(batchB),
    ]);

    const graph = await manager.readGraph();

    // All 11 entities (1 seed + 5 A + 5 B) must be present — no data lost
    expect(graph.entities).toHaveLength(11);

    const names = new Set(graph.entities.map(e => e.name));
    expect(names.has('Seed')).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect(names.has(`EntityA${i}`)).toBe(true);
      expect(names.has(`EntityB${i}`)).toBe(true);
    }
  });

  it('many parallel writes all succeed without throwing', async () => {
    const manager = new KnowledgeGraphManager(filePath);

    const writes = Array.from({ length: 20 }, (_, i) =>
      manager.createEntities([{ name: `Parallel${i}`, entityType: 'test', observations: [] }])
    );

    await expect(Promise.all(writes)).resolves.toBeDefined();

    const graph = await manager.readGraph();
    expect(graph.entities).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// 2. Atomic writes — .tmp file is used and replaced atomically
// ---------------------------------------------------------------------------
describe('Hardening #2 — atomic writes use .tmp then rename', () => {
  let filePath: string;

  beforeEach(() => { filePath = tmpFile(); });
  afterEach(async () => { await cleanup(filePath, `${filePath}.tmp`); });

  it('no stale .tmp file is left behind after a successful save', async () => {
    const manager = new KnowledgeGraphManager(filePath);

    await manager.createEntities([
      { name: 'Alpha', entityType: 'test', observations: [] },
    ]);

    // After a clean save, the .tmp file must not exist
    const tmpExists = await fs.access(`${filePath}.tmp`).then(() => true).catch(() => false);
    expect(tmpExists).toBe(false);
  });

  it('the main file is always valid JSONL after a write (not a tmp mid-state)', async () => {
    const manager = new KnowledgeGraphManager(filePath);

    await manager.createEntities([
      { name: 'Beta', entityType: 'test', observations: ['note1'] },
    ]);

    const raw = await fs.readFile(filePath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    expect(lines.length).toBeGreaterThan(0);

    // Every line must be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Auto-repair on load — corrupt lines skipped, duplicates deduplicated
// ---------------------------------------------------------------------------
describe('Hardening #3a — corrupt JSONL lines are skipped on load', () => {
  let filePath: string;

  beforeEach(() => { filePath = tmpFile(); });
  afterEach(async () => { await cleanup(filePath); });

  it('server loads cleanly when the file contains corrupt lines', async () => {
    const corrupt = [
      '{"type":"entity","name":"Good","entityType":"test","observations":[]}',
      'THIS IS NOT JSON }{',
      '',
      '{"type":"entity","name":"AlsoGood","entityType":"test","observations":[]}',
      '{"broken":',
    ].join('\n');

    await fs.writeFile(filePath, corrupt, 'utf-8');

    const manager = new KnowledgeGraphManager(filePath);
    const graph = await manager.readGraph();

    // The two valid entities should be loaded; corrupt lines silently skipped
    expect(graph.entities).toHaveLength(2);
    const names = graph.entities.map(e => e.name);
    expect(names).toContain('Good');
    expect(names).toContain('AlsoGood');
  });

  it('a file with only corrupt lines yields an empty graph (no throw)', async () => {
    await fs.writeFile(filePath, 'garbage\n{incomplete\n', 'utf-8');

    const manager = new KnowledgeGraphManager(filePath);
    await expect(manager.readGraph()).resolves.toEqual({ entities: [], relations: [] });
  });

  it('a completely empty file yields an empty graph', async () => {
    await fs.writeFile(filePath, '', 'utf-8');

    const manager = new KnowledgeGraphManager(filePath);
    await expect(manager.readGraph()).resolves.toEqual({ entities: [], relations: [] });
  });
});

describe('Hardening #3b — duplicate entries are deduplicated on load', () => {
  let filePath: string;

  beforeEach(() => { filePath = tmpFile(); });
  afterEach(async () => { await cleanup(filePath); });

  it('duplicate entity lines are collapsed to a single entity', async () => {
    const dup = [
      '{"type":"entity","name":"Alice","entityType":"person","observations":["first"]}',
      '{"type":"entity","name":"Alice","entityType":"person","observations":["duplicate"]}',
      '{"type":"entity","name":"Bob","entityType":"person","observations":[]}',
    ].join('\n');

    await fs.writeFile(filePath, dup, 'utf-8');

    const manager = new KnowledgeGraphManager(filePath);
    const graph = await manager.readGraph();

    expect(graph.entities).toHaveLength(2);
    const alice = graph.entities.find(e => e.name === 'Alice');
    // First occurrence wins
    expect(alice?.observations).toEqual(['first']);
  });

  it('duplicate relation lines are collapsed to a single relation', async () => {
    const dup = [
      '{"type":"relation","from":"Alice","to":"Bob","relationType":"knows"}',
      '{"type":"relation","from":"Alice","to":"Bob","relationType":"knows"}',
    ].join('\n');

    await fs.writeFile(filePath, dup, 'utf-8');

    const manager = new KnowledgeGraphManager(filePath);
    const graph = await manager.readGraph();

    expect(graph.relations).toHaveLength(1);
  });

  it('corrupt lines mixed with duplicates are handled correctly', async () => {
    const mixed = [
      '{"type":"entity","name":"Alice","entityType":"person","observations":[]}',
      'NOT JSON',
      '{"type":"entity","name":"Alice","entityType":"person","observations":["dup"]}',
      '{"type":"relation","from":"Alice","to":"Bob","relationType":"knows"}',
      '{"type":"relation","from":"Alice","to":"Bob","relationType":"knows"}',
    ].join('\n');

    await fs.writeFile(filePath, mixed, 'utf-8');

    const manager = new KnowledgeGraphManager(filePath);
    const graph = await manager.readGraph();

    expect(graph.entities).toHaveLength(1);
    expect(graph.relations).toHaveLength(1);
  });
});
