import { describe, it, expect } from 'vitest';
import { pruneGraph, parseDateFromName } from '../pruning.js';
import type { Entity, Relation } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Date that is `days` days before `now`. */
function daysAgo(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** Format a Date as YYYY-MM-DD (UTC). */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Format a Date as YYYY-MM (UTC). */
function isoYearMonth(d: Date): string {
  return d.toISOString().slice(0, 7);
}

// ---------------------------------------------------------------------------
// parseDateFromName
// ---------------------------------------------------------------------------

describe('parseDateFromName', () => {
  it('parses a full YYYY-MM-DD date from an entity name', () => {
    const d = parseDateFromName('standup:2026-03-10');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-03-10T00:00:00.000Z');
  });

  it('parses a year-month YYYY-MM date from an entity name', () => {
    const d = parseDateFromName('metric:citation-tracking:2024-12');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2024-12-01T00:00:00.000Z');
  });

  it('returns null when no date is present in the name', () => {
    expect(parseDateFromName('standup:morning')).toBeNull();
    expect(parseDateFromName('product:buzzy-game')).toBeNull();
    expect(parseDateFromName('lesson:always-test-first')).toBeNull();
  });

  it('prefers a full date over a year-month prefix', () => {
    const d = parseDateFromName('standup:2026-03-10:morning');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-03-10T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// pruneGraph — standup pruning
// ---------------------------------------------------------------------------

describe('pruneGraph — standup entities', () => {
  const now = new Date('2026-03-17T12:00:00.000Z');

  it('removes a standup entity whose date is 8 days ago', () => {
    const staleDate = isoDate(daysAgo(8, now));
    const entities: Entity[] = [
      { name: `standup:${staleDate}`, entityType: 'standup', observations: ['All good.'] },
    ];
    const { entities: result } = pruneGraph(entities, [], now);
    expect(result).toHaveLength(0);
  });

  it('keeps a standup entity whose date is today', () => {
    const todayDate = isoDate(now);
    const entities: Entity[] = [
      { name: `standup:${todayDate}`, entityType: 'standup', observations: [] },
    ];
    const { entities: result } = pruneGraph(entities, [], now);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe(`standup:${todayDate}`);
  });

  it('keeps a standup entity whose date is 6 days ago', () => {
    const recentDate = isoDate(daysAgo(6, now));
    const entities: Entity[] = [
      { name: `standup:${recentDate}`, entityType: 'standup', observations: [] },
    ];
    const { entities: result } = pruneGraph(entities, [], now);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe(`standup:${recentDate}`);
  });

  it('removes multiple stale standups and keeps recent ones in one pass', () => {
    const stale1 = isoDate(daysAgo(10, now));
    const stale2 = isoDate(daysAgo(30, now));
    const recent = isoDate(daysAgo(3, now));
    const entities: Entity[] = [
      { name: `standup:${stale1}`, entityType: 'standup', observations: [] },
      { name: `standup:${stale2}`, entityType: 'standup', observations: [] },
      { name: `standup:${recent}`, entityType: 'standup', observations: [] },
    ];
    const { entities: result } = pruneGraph(entities, [], now);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe(`standup:${recent}`);
  });

  it('keeps a standup entity that has no parseable date in its name', () => {
    const entities: Entity[] = [
      { name: 'standup:morning-check', entityType: 'standup', observations: [] },
    ];
    const { entities: result } = pruneGraph(entities, [], now);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// pruneGraph — permanent entity types
// ---------------------------------------------------------------------------

describe('pruneGraph — permanent entity types (lesson, decision, deadline)', () => {
  const now = new Date('2026-03-17T12:00:00.000Z');

  it.each(['lesson', 'decision', 'deadline'] as const)(
    'never removes a %s entity regardless of age',
    (entityType) => {
      const oldDate = isoDate(daysAgo(365, now));
      const entities: Entity[] = [
        { name: `${entityType}:${oldDate}:important`, entityType, observations: ['keep me'] },
      ];
      const { entities: result } = pruneGraph(entities, [], now);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe(`${entityType}:${oldDate}:important`);
    },
  );
});

// ---------------------------------------------------------------------------
// pruneGraph — metric archiving
// ---------------------------------------------------------------------------

describe('pruneGraph — metric entity archiving', () => {
  const now = new Date('2026-03-17T12:00:00.000Z');

  it('archives a metric entity whose date is older than 90 days', () => {
    const oldYM = isoYearMonth(daysAgo(100, now));
    const entities: Entity[] = [
      {
        name: `metric:citation-tracking:${oldYM}`,
        entityType: 'metric',
        observations: [
          'entity:product:buzzy-game:cited:5',
          'sessions_tracked:10',
          'last_updated:2025-12-01T00:00:00.000Z',
        ],
      },
    ];
    const { entities: result } = pruneGraph(entities, [], now);
    expect(result).toHaveLength(1);
    const archived = result[0];
    expect(archived.name).toBe(`metric:archive:metric:citation-tracking:${oldYM}`);
    expect(archived.entityType).toBe('metric');
  });

  it('keeps the summary observations but drops per-entity citation detail', () => {
    const oldYM = isoYearMonth(daysAgo(100, now));
    const entities: Entity[] = [
      {
        name: `metric:citation-tracking:${oldYM}`,
        entityType: 'metric',
        observations: [
          'entity:product:buzzy-game:cited:5',  // detail — should be dropped
          'entity:lesson:stale:cited:0',          // detail — should be dropped
          'sessions_tracked:10',                  // summary — should be kept
          'last_updated:2025-12-01T00:00:00.000Z', // summary — should be kept
        ],
      },
    ];
    const { entities: result } = pruneGraph(entities, [], now);
    const archived = result[0];
    expect(archived.observations).not.toContain('entity:product:buzzy-game:cited:5');
    expect(archived.observations).not.toContain('entity:lesson:stale:cited:0');
    expect(archived.observations).toContain('sessions_tracked:10');
    expect(archived.observations).toContain('last_updated:2025-12-01T00:00:00.000Z');
  });

  it('adds archived_from and archived_at observations to the archive entity', () => {
    const oldYM = isoYearMonth(daysAgo(100, now));
    const originalName = `metric:citation-tracking:${oldYM}`;
    const entities: Entity[] = [
      { name: originalName, entityType: 'metric', observations: ['sessions_tracked:3'] },
    ];
    const { entities: result } = pruneGraph(entities, [], now);
    const archived = result[0];
    expect(archived.observations).toContain(`archived_from:${originalName}`);
    expect(archived.observations.some(o => o.startsWith('archived_at:'))).toBe(true);
  });

  it('keeps a metric entity whose date is within 90 days', () => {
    const recentYM = isoYearMonth(daysAgo(30, now));
    const entities: Entity[] = [
      {
        name: `metric:citation-tracking:${recentYM}`,
        entityType: 'metric',
        observations: ['sessions_tracked:5'],
      },
    ];
    const { entities: result } = pruneGraph(entities, [], now);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe(`metric:citation-tracking:${recentYM}`);
  });

  it('keeps a metric entity that has no parseable date in its name', () => {
    const entities: Entity[] = [
      { name: 'metric:some-undated-counter', entityType: 'metric', observations: ['count:42'] },
    ];
    const { entities: result } = pruneGraph(entities, [], now);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('metric:some-undated-counter');
  });
});

// ---------------------------------------------------------------------------
// pruneGraph — relation handling
// ---------------------------------------------------------------------------

describe('pruneGraph — relation handling', () => {
  const now = new Date('2026-03-17T12:00:00.000Z');
  const staleDate = isoDate(daysAgo(8, now));
  const staleYM = isoYearMonth(daysAgo(100, now));

  it('drops relations where the `from` entity is a removed standup', () => {
    const standupName = `standup:${staleDate}`;
    const entities: Entity[] = [
      { name: standupName, entityType: 'standup', observations: [] },
      { name: 'product:buzzy-game', entityType: 'product', observations: [] },
    ];
    const relations: Relation[] = [
      { from: standupName, to: 'product:buzzy-game', relationType: 'reviewed' },
    ];
    const { relations: result } = pruneGraph(entities, relations, now);
    expect(result).toHaveLength(0);
  });

  it('drops relations where the `to` entity is a removed standup', () => {
    const standupName = `standup:${staleDate}`;
    const entities: Entity[] = [
      { name: 'product:buzzy-game', entityType: 'product', observations: [] },
      { name: standupName, entityType: 'standup', observations: [] },
    ];
    const relations: Relation[] = [
      { from: 'product:buzzy-game', to: standupName, relationType: 'mentioned-in' },
    ];
    const { relations: result } = pruneGraph(entities, relations, now);
    expect(result).toHaveLength(0);
  });

  it('keeps relations between non-removed entities', () => {
    const recentDate = isoDate(daysAgo(3, now));
    const entities: Entity[] = [
      { name: `standup:${recentDate}`, entityType: 'standup', observations: [] },
      { name: 'product:buzzy-game', entityType: 'product', observations: [] },
    ];
    const relations: Relation[] = [
      { from: `standup:${recentDate}`, to: 'product:buzzy-game', relationType: 'reviewed' },
    ];
    const { relations: result } = pruneGraph(entities, relations, now);
    expect(result).toHaveLength(1);
  });

  it('rewrites relations that reference an archived metric entity', () => {
    const metricName = `metric:citation-tracking:${staleYM}`;
    const archiveName = `metric:archive:${metricName}`;
    const entities: Entity[] = [
      { name: metricName, entityType: 'metric', observations: ['sessions_tracked:5'] },
      { name: 'product:buzzy-game', entityType: 'product', observations: [] },
    ];
    const relations: Relation[] = [
      { from: metricName, to: 'product:buzzy-game', relationType: 'tracks' },
      { from: 'product:buzzy-game', to: metricName, relationType: 'tracked-by' },
    ];
    const { relations: result } = pruneGraph(entities, relations, now);
    expect(result).toHaveLength(2);
    expect(result[0].from).toBe(archiveName);
    expect(result[0].to).toBe('product:buzzy-game');
    expect(result[1].from).toBe('product:buzzy-game');
    expect(result[1].to).toBe(archiveName);
  });
});

// ---------------------------------------------------------------------------
// pruneGraph — idempotency and archive collision protection
// ---------------------------------------------------------------------------

describe('pruneGraph — idempotency and archive collision (Bugs 1 & 2)', () => {
  const now = new Date('2026-03-17T12:00:00.000Z');

  it('does not re-archive a metric:archive: entity on a second run (Bug 1 — double-archive)', () => {
    const oldYM = isoYearMonth(daysAgo(100, now));
    const archiveName = `metric:archive:metric:citation-tracking:${oldYM}`;
    // Simulate the state AFTER a first pruning run: only the archive entity exists.
    const entities: Entity[] = [
      {
        name: archiveName,
        entityType: 'metric',
        observations: ['archived_from:metric:citation-tracking:' + oldYM, 'sessions_tracked:5'],
      },
    ];
    const { entities: result } = pruneGraph(entities, [], now);
    // The archive entity must be kept as-is — not re-wrapped with another metric:archive: prefix.
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe(archiveName);
    expect(result[0].name.startsWith('metric:archive:metric:archive:')).toBe(false);
  });

  it('pruneGraph is idempotent — running twice produces the same graph', () => {
    const oldYM = isoYearMonth(daysAgo(100, now));
    const staleDate = isoDate(daysAgo(8, now));
    const entities: Entity[] = [
      { name: `standup:${staleDate}`, entityType: 'standup', observations: [] },
      {
        name: `metric:citation-tracking:${oldYM}`,
        entityType: 'metric',
        observations: ['sessions_tracked:3'],
      },
      { name: 'product:buzzy-game', entityType: 'product', observations: [] },
    ];

    // First run
    const first = pruneGraph(entities, [], now);
    // Second run (uses the output of the first as input)
    const second = pruneGraph(first.entities, first.relations, now);

    expect(second.entities.map(e => e.name).sort()).toEqual(
      first.entities.map(e => e.name).sort(),
    );
    // No additional items removed or archived on the second pass
    expect(second.removedCount).toBe(0);
    expect(second.archivedCount).toBe(0);
  });

  it('replaces a stale archive entity when input contains both the original metric and a prior archive (Bug 2 — collision)', () => {
    const oldYM = isoYearMonth(daysAgo(100, now));
    const originalName = `metric:citation-tracking:${oldYM}`;
    const archiveName = `metric:archive:${originalName}`;

    // Simulate a graph that somehow has BOTH the original metric and a prior archive
    // (e.g. the original was re-added after a previous pruning run).
    const entities: Entity[] = [
      {
        name: archiveName,
        entityType: 'metric',
        observations: ['archived_from:' + originalName, 'sessions_tracked:3', 'last_updated:2025-11-01'],
      },
      {
        name: originalName,
        entityType: 'metric',
        observations: ['sessions_tracked:10', 'last_updated:2025-12-01'],
      },
    ];

    const { entities: result } = pruneGraph(entities, [], now);

    // There must be exactly one archive entity — no duplicates.
    const archives = result.filter(e => e.name === archiveName);
    expect(archives).toHaveLength(1);

    // The archive entity should reflect the freshly-generated summary (from the
    // original metric processed this run), not the stale prior archive.
    expect(archives[0].observations).toContain('sessions_tracked:10');
  });

  it('replaces a stale archive when original metric appears before the prior archive in input', () => {
    // Variant: original entity comes first in array (different processing order).
    const oldYM = isoYearMonth(daysAgo(100, now));
    const originalName = `metric:citation-tracking:${oldYM}`;
    const archiveName = `metric:archive:${originalName}`;

    const entities: Entity[] = [
      {
        name: originalName,
        entityType: 'metric',
        observations: ['sessions_tracked:10'],
      },
      {
        name: archiveName,
        entityType: 'metric',
        observations: ['archived_from:' + originalName, 'sessions_tracked:3'],
      },
    ];

    const { entities: result } = pruneGraph(entities, [], now);
    const archives = result.filter(e => e.name === archiveName);
    expect(archives).toHaveLength(1);
    // Fresh archive must win regardless of input order.
    expect(archives[0].observations).toContain('sessions_tracked:10');
  });
});

// ---------------------------------------------------------------------------
// pruneGraph — PruneResult stats
// ---------------------------------------------------------------------------

describe('pruneGraph — result stats (removedCount, archivedCount)', () => {
  const now = new Date('2026-03-17T12:00:00.000Z');

  it('reports removedCount for stale standups', () => {
    const stale1 = isoDate(daysAgo(10, now));
    const stale2 = isoDate(daysAgo(20, now));
    const recent = isoDate(daysAgo(2, now));
    const entities: Entity[] = [
      { name: `standup:${stale1}`, entityType: 'standup', observations: [] },
      { name: `standup:${stale2}`, entityType: 'standup', observations: [] },
      { name: `standup:${recent}`, entityType: 'standup', observations: [] },
    ];
    const result = pruneGraph(entities, [], now);
    expect(result.removedCount).toBe(2);
    expect(result.archivedCount).toBe(0);
  });

  it('reports archivedCount for old metrics', () => {
    const oldYM1 = isoYearMonth(daysAgo(100, now));
    const oldYM2 = isoYearMonth(daysAgo(200, now));
    const recentYM = isoYearMonth(daysAgo(10, now));
    const entities: Entity[] = [
      { name: `metric:citation-tracking:${oldYM1}`, entityType: 'metric', observations: [] },
      { name: `metric:citation-tracking:${oldYM2}`, entityType: 'metric', observations: [] },
      { name: `metric:citation-tracking:${recentYM}`, entityType: 'metric', observations: [] },
    ];
    const result = pruneGraph(entities, [], now);
    expect(result.archivedCount).toBe(2);
    expect(result.removedCount).toBe(0);
  });

  it('reports zero counts when nothing is pruned', () => {
    const entities: Entity[] = [
      { name: 'product:buzzy-game', entityType: 'product', observations: [] },
      { name: 'lesson:always-test', entityType: 'lesson', observations: [] },
    ];
    const result = pruneGraph(entities, [], now);
    expect(result.removedCount).toBe(0);
    expect(result.archivedCount).toBe(0);
  });
});

describe('pruneGraph — mixed graph', () => {
  const now = new Date('2026-03-17T12:00:00.000Z');

  it('applies all rules in a single pass over a realistic graph', () => {
    const staleStandupDate = isoDate(daysAgo(10, now));
    const recentStandupDate = isoDate(daysAgo(2, now));
    const oldMetricYM = isoYearMonth(daysAgo(120, now));
    const recentMetricYM = isoYearMonth(daysAgo(10, now));

    const entities: Entity[] = [
      // standup — stale → removed
      { name: `standup:${staleStandupDate}`, entityType: 'standup', observations: [] },
      // standup — recent → kept
      { name: `standup:${recentStandupDate}`, entityType: 'standup', observations: [] },
      // lesson — permanent → kept
      { name: 'lesson:always-write-tests', entityType: 'lesson', observations: [] },
      // decision — permanent → kept
      { name: 'decision:use-typescript', entityType: 'decision', observations: [] },
      // deadline — permanent → kept
      { name: `deadline:2025-01-01:tax`, entityType: 'deadline', observations: [] },
      // metric — old → archived
      {
        name: `metric:citation-tracking:${oldMetricYM}`,
        entityType: 'metric',
        observations: ['entity:p:cited:1', 'sessions_tracked:5'],
      },
      // metric — recent → kept
      {
        name: `metric:citation-tracking:${recentMetricYM}`,
        entityType: 'metric',
        observations: ['sessions_tracked:2'],
      },
      // other entity — kept
      { name: 'product:buzzy-game', entityType: 'product', observations: [] },
    ];

    const { entities: result } = pruneGraph(entities, [], now);

    const names = result.map(e => e.name);

    // Removed
    expect(names).not.toContain(`standup:${staleStandupDate}`);
    // Kept unchanged
    expect(names).toContain(`standup:${recentStandupDate}`);
    expect(names).toContain('lesson:always-write-tests');
    expect(names).toContain('decision:use-typescript');
    expect(names).toContain('deadline:2025-01-01:tax');
    expect(names).toContain(`metric:citation-tracking:${recentMetricYM}`);
    expect(names).toContain('product:buzzy-game');
    // Archived (original name removed, archive name present)
    expect(names).not.toContain(`metric:citation-tracking:${oldMetricYM}`);
    expect(names).toContain(`metric:archive:metric:citation-tracking:${oldMetricYM}`);
  });
});
