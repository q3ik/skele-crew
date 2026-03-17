import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { KnowledgeGraphManager, CitationTracker, Entity } from '../index.js';

const makeFilePath = () =>
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    `test-citations-${randomUUID()}.jsonl`,
  );

describe('CitationTracker', () => {
  let manager: KnowledgeGraphManager;
  let tracker: CitationTracker;
  let testFilePath: string;

  beforeEach(async () => {
    testFilePath = makeFilePath();
    manager = new KnowledgeGraphManager(testFilePath);
    tracker = new CitationTracker();
  });

  afterEach(async () => {
    try { await fs.unlink(testFilePath); } catch { /* ignore */ }
    try { await fs.unlink(`${testFilePath}.tmp`); } catch { /* ignore */ }
  });

  describe('recordRead', () => {
    it('accumulates citation counts per entity across multiple calls', async () => {
      const entities: Entity[] = [
        { name: 'product:buzzy-game', entityType: 'product', observations: [] },
        { name: 'deadline:Q2-tax', entityType: 'deadline', observations: [] },
      ];
      tracker.recordRead(entities);
      tracker.recordRead(entities);

      // Flush to an empty graph and verify accumulated counts
      await tracker.flush(manager);
      const graph = await manager.readGraph();
      const yyyyMM = new Date().toISOString().slice(0, 7);
      const metric = graph.entities.find(e => e.name === `metric:citation-tracking:${yyyyMM}`);
      expect(metric!.observations).toContain('entity:product:buzzy-game:cited:2');
      expect(metric!.observations).toContain('entity:deadline:Q2-tax:cited:2');
    });

    it('does not track the citation metric entity itself', async () => {
      const entities: Entity[] = [
        { name: 'metric:citation-tracking:2026-03', entityType: 'metric', observations: [] },
        { name: 'product:real-entity', entityType: 'product', observations: [] },
      ];
      tracker.recordRead(entities);

      // Flush and confirm no self-referential observation was created
      await manager.createEntities([
        { name: 'product:real-entity', entityType: 'product', observations: [] },
      ]);
      await tracker.flush(manager);
      const graph = await manager.readGraph();
      const yyyyMM = new Date().toISOString().slice(0, 7);
      const metric = graph.entities.find(e => e.name === `metric:citation-tracking:${yyyyMM}`);
      expect(metric).toBeDefined();
      const selfRef = metric!.observations.some(o => o.includes('metric:citation-tracking:'));
      expect(selfRef).toBe(false);
      expect(metric!.observations).toContain('entity:product:real-entity:cited:1');
    });
  });

  describe('flush', () => {
    it('creates a metric entity with correct observation format after one session', async () => {
      await manager.createEntities([
        { name: 'product:my-saas', entityType: 'product', observations: [] },
        { name: 'deadline:Q2-tax', entityType: 'deadline', observations: [] },
      ]);

      tracker.recordRead([{ name: 'product:my-saas', entityType: 'product', observations: [] }]);
      // deadline:Q2-tax is never read → should appear as cited:0

      await tracker.flush(manager);

      const graph = await manager.readGraph();
      const yyyyMM = new Date().toISOString().slice(0, 7);
      const metric = graph.entities.find(e => e.name === `metric:citation-tracking:${yyyyMM}`);

      expect(metric).toBeDefined();
      expect(metric!.entityType).toBe('metric');
      expect(metric!.observations).toContain('entity:product:my-saas:cited:1');
      expect(metric!.observations).toContain('entity:deadline:Q2-tax:cited:0');
      expect(metric!.observations).toContain('sessions_tracked:1');
      expect(metric!.observations.some(o => o.startsWith('last_updated:'))).toBe(true);
    });

    it('accumulates citation counts across multiple sessions', async () => {
      await manager.createEntities([
        { name: 'product:my-saas', entityType: 'product', observations: [] },
      ]);

      // Session 1: cite product:my-saas twice
      const tracker1 = new CitationTracker();
      tracker1.recordRead([{ name: 'product:my-saas', entityType: 'product', observations: [] }]);
      tracker1.recordRead([{ name: 'product:my-saas', entityType: 'product', observations: [] }]);
      await tracker1.flush(manager);

      // Session 2: cite product:my-saas once more
      const tracker2 = new CitationTracker();
      tracker2.recordRead([{ name: 'product:my-saas', entityType: 'product', observations: [] }]);
      await tracker2.flush(manager);

      const graph = await manager.readGraph();
      const yyyyMM = new Date().toISOString().slice(0, 7);
      const metric = graph.entities.find(e => e.name === `metric:citation-tracking:${yyyyMM}`);

      expect(metric).toBeDefined();
      // Count should be cumulative: 2 + 1 = 3
      expect(metric!.observations).toContain('entity:product:my-saas:cited:3');
      expect(metric!.observations).toContain('sessions_tracked:2');
    });

    it('entity never cited shows cited:0 after 5 sessions', async () => {
      await manager.createEntities([
        { name: 'product:active', entityType: 'product', observations: [] },
        { name: 'lesson:stale', entityType: 'lesson', observations: [] },
      ]);

      for (let i = 0; i < 5; i++) {
        const t = new CitationTracker();
        // Only 'product:active' is read; 'lesson:stale' is never cited
        t.recordRead([{ name: 'product:active', entityType: 'product', observations: [] }]);
        await t.flush(manager);
      }

      const graph = await manager.readGraph();
      const yyyyMM = new Date().toISOString().slice(0, 7);
      const metric = graph.entities.find(e => e.name === `metric:citation-tracking:${yyyyMM}`);

      expect(metric).toBeDefined();
      expect(metric!.observations).toContain('entity:lesson:stale:cited:0');
      expect(metric!.observations).toContain('entity:product:active:cited:5');
      expect(metric!.observations).toContain('sessions_tracked:5');
    });

    it('does not include the metric entity itself in citation observations', async () => {
      await manager.createEntities([
        { name: 'product:thing', entityType: 'product', observations: [] },
      ]);

      await tracker.flush(manager);

      // Second flush: the metric entity created by the first flush should NOT
      // appear as an 'entity:metric:citation-tracking:...:cited:...' observation
      await tracker.flush(manager);

      const graph = await manager.readGraph();
      const yyyyMM = new Date().toISOString().slice(0, 7);
      const metric = graph.entities.find(e => e.name === `metric:citation-tracking:${yyyyMM}`);

      expect(metric).toBeDefined();
      const selfRef = metric!.observations.some(o =>
        o.includes('metric:citation-tracking:'),
      );
      expect(selfRef).toBe(false);
    });

    it('handles an empty graph (no entities) without error', async () => {
      // No entities in graph
      await tracker.flush(manager);

      const graph = await manager.readGraph();
      const yyyyMM = new Date().toISOString().slice(0, 7);
      const metric = graph.entities.find(e => e.name === `metric:citation-tracking:${yyyyMM}`);

      // Metric entity should still be created (sessions_tracked incremented)
      expect(metric).toBeDefined();
      expect(metric!.observations).toContain('sessions_tracked:1');
    });

    it('overwrites only the monthly metric entity, preserving other entities', async () => {
      await manager.createEntities([
        { name: 'product:alpha', entityType: 'product', observations: ['stable data'] },
      ]);

      await tracker.flush(manager);

      const graph = await manager.readGraph();
      const alpha = graph.entities.find(e => e.name === 'product:alpha');
      expect(alpha).toBeDefined();
      expect(alpha!.observations).toContain('stable data');
    });
  });
});
