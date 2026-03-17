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

  describe('recordRead + recordCited', () => {
    it('accumulates citation counts per entity when entity name appears in response text', async () => {
      const entities: Entity[] = [
        { name: 'product:buzzy-game', entityType: 'product', observations: [] },
        { name: 'deadline:Q2-tax', entityType: 'deadline', observations: [] },
      ];
      tracker.recordRead(entities);
      // Two separate responses both mention these entities
      tracker.recordCited('Status: product:buzzy-game active, deadline:Q2-tax due soon.');
      tracker.recordCited('Reminder: check product:buzzy-game and deadline:Q2-tax.');

      await tracker.flush(manager);
      const graph = await manager.readGraph();
      const yyyyMM = new Date().toISOString().slice(0, 7);
      const metric = graph.entities.find(e => e.name === `metric:citation-tracking:${yyyyMM}`);
      expect(metric!.observations).toContain('entity:product:buzzy-game:cited:2');
      expect(metric!.observations).toContain('entity:deadline:Q2-tax:cited:2');
    });

    it('only counts entities whose names appear in the response text', async () => {
      // Entities must exist in the graph (real read tools always return graph entities)
      await manager.createEntities([
        { name: 'product:cited', entityType: 'product', observations: [] },
        { name: 'product:uncited', entityType: 'product', observations: [] },
      ]);
      const entities: Entity[] = [
        { name: 'product:cited', entityType: 'product', observations: [] },
        { name: 'product:uncited', entityType: 'product', observations: [] },
      ];
      tracker.recordRead(entities);
      // Response only mentions product:cited
      tracker.recordCited('The product:cited entity is relevant here.');

      await tracker.flush(manager);
      const graph = await manager.readGraph();
      const yyyyMM = new Date().toISOString().slice(0, 7);
      const metric = graph.entities.find(e => e.name === `metric:citation-tracking:${yyyyMM}`);
      expect(metric!.observations).toContain('entity:product:cited:cited:1');
      expect(metric!.observations).toContain('entity:product:uncited:cited:0');
    });

    it('does not buffer or cite the citation metric entity itself', async () => {
      const entities: Entity[] = [
        { name: 'metric:citation-tracking:2026-03', entityType: 'metric', observations: [] },
        { name: 'product:real-entity', entityType: 'product', observations: [] },
      ];
      tracker.recordRead(entities);
      await manager.createEntities([
        { name: 'product:real-entity', entityType: 'product', observations: [] },
      ]);
      // Response mentions both names; metric entity should still not be tracked
      tracker.recordCited('Updated metric:citation-tracking:2026-03 and product:real-entity.');
      await tracker.flush(manager);

      const graph = await manager.readGraph();
      const yyyyMM = new Date().toISOString().slice(0, 7);
      const metric = graph.entities.find(e => e.name === `metric:citation-tracking:${yyyyMM}`);
      expect(metric).toBeDefined();
      const selfRef = metric!.observations.some(o => o.includes('metric:citation-tracking:'));
      expect(selfRef).toBe(false);
      expect(metric!.observations).toContain('entity:product:real-entity:cited:1');
    });

    it('recordCited returns the number of distinct entities matched', () => {
      const entities: Entity[] = [
        { name: 'product:a', entityType: 'product', observations: [] },
        { name: 'product:b', entityType: 'product', observations: [] },
        { name: 'product:c', entityType: 'product', observations: [] },
      ];
      tracker.recordRead(entities);
      // Only a and b appear in the response
      const count = tracker.recordCited('See product:a and product:b for details.');
      expect(count).toBe(2);
    });
  });

  describe('flush', () => {
    it('creates a metric entity with correct observation format after one session', async () => {
      await manager.createEntities([
        { name: 'product:my-saas', entityType: 'product', observations: [] },
        { name: 'deadline:Q2-tax', entityType: 'deadline', observations: [] },
      ]);

      tracker.recordRead([{ name: 'product:my-saas', entityType: 'product', observations: [] }]);
      // Only product:my-saas is cited; deadline:Q2-tax is in graph but never cited
      tracker.recordCited('This session product:my-saas was discussed.');

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

      // Session 1: product:my-saas cited in two separate responses
      const tracker1 = new CitationTracker();
      tracker1.recordRead([{ name: 'product:my-saas', entityType: 'product', observations: [] }]);
      tracker1.recordCited('product:my-saas is the main product.');
      tracker1.recordCited('Discussed product:my-saas status.');
      await tracker1.flush(manager);

      // Session 2: product:my-saas cited once more
      const tracker2 = new CitationTracker();
      tracker2.recordRead([{ name: 'product:my-saas', entityType: 'product', observations: [] }]);
      tracker2.recordCited('product:my-saas reviewed.');
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
        t.recordRead([
          { name: 'product:active', entityType: 'product', observations: [] },
          { name: 'lesson:stale', entityType: 'lesson', observations: [] },
        ]);
        // Only product:active is cited each session; lesson:stale never is
        t.recordCited('product:active is doing well.');
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
      // Second flush: metric entity created by the first should NOT appear as
      // an 'entity:metric:citation-tracking:...:cited:...' observation
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
      await tracker.flush(manager);

      const graph = await manager.readGraph();
      const yyyyMM = new Date().toISOString().slice(0, 7);
      const metric = graph.entities.find(e => e.name === `metric:citation-tracking:${yyyyMM}`);

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

    it('flags zero-cited entities for review after 30 sessions', async () => {
      await manager.createEntities([
        { name: 'product:popular', entityType: 'product', observations: [] },
        { name: 'lesson:stale', entityType: 'lesson', observations: [] },
      ]);

      // Run 30 sessions: product:popular cited every session, lesson:stale never
      for (let i = 0; i < 30; i++) {
        const t = new CitationTracker();
        t.recordRead([
          { name: 'product:popular', entityType: 'product', observations: [] },
          { name: 'lesson:stale', entityType: 'lesson', observations: [] },
        ]);
        t.recordCited('product:popular update for session.');
        await t.flush(manager);
      }

      const graph = await manager.readGraph();
      const yyyyMM = new Date().toISOString().slice(0, 7);
      const metric = graph.entities.find(e => e.name === `metric:citation-tracking:${yyyyMM}`);

      expect(metric).toBeDefined();
      expect(metric!.observations).toContain('sessions_tracked:30');
      // lesson:stale has cited:0 and sessions_tracked >= 30 → flagged
      expect(metric!.observations).toContain('flagged_for_review:lesson:stale');
      // product:popular is cited every session → must NOT be flagged
      expect(metric!.observations).not.toContain('flagged_for_review:product:popular');
    });

    it('does not add flagged_for_review before 30 sessions', async () => {
      await manager.createEntities([
        { name: 'lesson:stale', entityType: 'lesson', observations: [] },
      ]);

      // Run only 29 sessions with no citations
      for (let i = 0; i < 29; i++) {
        const t = new CitationTracker();
        await t.flush(manager);
      }

      const graph = await manager.readGraph();
      const yyyyMM = new Date().toISOString().slice(0, 7);
      const metric = graph.entities.find(e => e.name === `metric:citation-tracking:${yyyyMM}`);

      expect(metric).toBeDefined();
      expect(metric!.observations).toContain('sessions_tracked:29');
      // Not yet at 30 — no flags
      const hasFlag = metric!.observations.some(o => o.startsWith('flagged_for_review:'));
      expect(hasFlag).toBe(false);
    });

    it('simulates a standup run and updates the citation metric entity', async () => {
      // Seed a graph that looks like what a real standup session would see
      await manager.createEntities([
        { name: 'product:buzzy-game', entityType: 'product', observations: ['status: active'] },
        { name: 'deadline:2026-Q2:hst-filing', entityType: 'deadline', observations: ['due: 2026-04-30'] },
        { name: 'lesson:2026-03:start-with-three-agents', entityType: 'lesson', observations: [] },
      ]);

      // Standup reads the full graph (simulates the read_graph tool call)
      const graph = await manager.readGraph();
      tracker.recordRead(graph.entities);

      // Standup agent generates its response — mentions two of the three entities
      const standupResponse =
        'Daily standup: product:buzzy-game is on track. ' +
        'Reminder: deadline:2026-Q2:hst-filing is due 2026-04-30. ' +
        'No blockers today.';
      tracker.recordCited(standupResponse);
      // lesson:2026-03:start-with-three-agents is NOT mentioned → cited:0

      // Session ends — flush citation data
      await tracker.flush(manager);

      const updatedGraph = await manager.readGraph();
      const yyyyMM = new Date().toISOString().slice(0, 7);
      const metric = updatedGraph.entities.find(e => e.name === `metric:citation-tracking:${yyyyMM}`);

      expect(metric).toBeDefined();
      expect(metric!.entityType).toBe('metric');
      expect(metric!.observations).toContain('entity:product:buzzy-game:cited:1');
      expect(metric!.observations).toContain('entity:deadline:2026-Q2:hst-filing:cited:1');
      expect(metric!.observations).toContain('entity:lesson:2026-03:start-with-three-agents:cited:0');
      expect(metric!.observations).toContain('sessions_tracked:1');
      expect(metric!.observations.some(o => o.startsWith('last_updated:'))).toBe(true);
    });
  });
});
