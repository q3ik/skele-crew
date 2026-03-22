import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { KnowledgeGraphManager } from '../index';

describe('Performance Benchmark: deleteEntities', () => {
  it('should measure time to delete entities', async () => {
    const memoryFilePath = path.join(__dirname, 'benchmark-memory.jsonl');

    // Create large graph
    const NUM_ENTITIES = 10000;
    const NUM_RELATIONS = 10000;
    const NUM_TO_DELETE = 1000;

    const manager = new KnowledgeGraphManager(memoryFilePath);

    // Prepare data
    const entities = Array.from({ length: NUM_ENTITIES }, (_, i) => ({
      name: `Entity_${i}`,
      entityType: 'test',
      observations: []
    }));

    const relations = Array.from({ length: NUM_RELATIONS }, (_, i) => ({
      from: `Entity_${i}`,
      to: `Entity_${(i + 1) % NUM_ENTITIES}`,
      relationType: 'test'
    }));

    // Save directly to avoid batching overhead in setup
    const lines = [
      ...entities.map(e => JSON.stringify({ type: 'entity', ...e })),
      ...relations.map(r => JSON.stringify({ type: 'relation', ...r }))
    ];
    await fs.writeFile(memoryFilePath, lines.join('\n'));

    const toDelete = Array.from({ length: NUM_TO_DELETE }, (_, i) => `Entity_${i * 5}`);

    const start = performance.now();
    await manager.deleteEntities(toDelete);
    const end = performance.now();

    const duration = end - start;
    console.log(`\n\n[Benchmark] deleteEntities: Deleted ${NUM_TO_DELETE} entities from a graph of ${NUM_ENTITIES} entities and ${NUM_RELATIONS} relations in ${duration.toFixed(2)}ms\n\n`);

    // Cleanup
    await fs.unlink(memoryFilePath).catch(() => {});

    expect(duration).toBeGreaterThan(0);
  });
});
