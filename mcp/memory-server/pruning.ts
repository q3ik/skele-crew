/**
 * Memory graph pruning utilities.
 *
 * Retention rules:
 *   • standup entities whose name contains a date older than 7 days are removed.
 *   • lesson, decision, and deadline entities are never removed.
 *   • metric entities whose name contains a date older than 90 days are archived:
 *     a new entity named `metric:archive:<original-name>` is created with a
 *     compact summary (top-level stats only, per-entity detail dropped).
 *   • All other entities are kept unchanged.
 *   • Relations that reference a removed entity are dropped.
 *   • Relations that reference an archived metric are updated to the new archive name.
 */

import type { Entity, Relation } from './index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Entity types that are never pruned. */
const PERMANENT_TYPES = new Set(['lesson', 'decision', 'deadline']);

/** Standup entities older than this many days are pruned. */
const STANDUP_PRUNE_DAYS = 7;

/** Metric entities older than this many days are archived. */
const METRIC_ARCHIVE_DAYS = 90;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Extract the earliest date found in an entity name.
 *
 * Recognises two formats embedded anywhere in the name string:
 *   • Full date:  YYYY-MM-DD  (e.g. `standup:2026-03-10`)
 *   • Year-month: YYYY-MM     (e.g. `metric:citation-tracking:2024-12`)
 *
 * When only a year-month is found the returned Date is set to the first day of
 * that month (UTC midnight), which gives a conservative cutoff that never
 * incorrectly evicts a recently-created monthly metric.
 *
 * Returns `null` when no date pattern is found in the name.
 */
export function parseDateFromName(name: string): Date | null {
  // Try full ISO date first (more specific match wins)
  const fullDateMatch = name.match(/(\d{4}-\d{2}-\d{2})/);
  if (fullDateMatch) {
    const d = new Date(`${fullDateMatch[1]}T00:00:00.000Z`);
    if (!isNaN(d.getTime())) return d;
  }

  // Fall back to year-month
  const yearMonthMatch = name.match(/(\d{4}-\d{2})(?!\d)/);
  if (yearMonthMatch) {
    const d = new Date(`${yearMonthMatch[1]}-01T00:00:00.000Z`);
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}

/**
 * Returns `true` when `date` is strictly older than `days` days relative to `now`.
 */
function isOlderThan(date: Date, now: Date, days: number): boolean {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return date < cutoff;
}

// ---------------------------------------------------------------------------
// Archive helpers
// ---------------------------------------------------------------------------

/**
 * Build the compact summary observations for an archived metric entity.
 *
 * Per-entity citation detail lines (those starting with `entity:`) are dropped;
 * top-level statistics (e.g. `sessions_tracked:N`, `last_updated:...`) and any
 * other non-detail observations are kept.  An `archived_from:` line is prepended
 * to record the original entity name.
 */
function buildArchiveSummary(originalName: string, observations: string[], archivedAt: Date): string[] {
  const summaryObs = observations.filter(o => !o.startsWith('entity:'));
  return [
    `archived_from:${originalName}`,
    `archived_at:${archivedAt.toISOString()}`,
    ...summaryObs,
  ];
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface PruneResult {
  entities: Entity[];
  relations: Relation[];
}

/**
 * Apply retention rules to a knowledge-graph snapshot and return the pruned graph.
 *
 * The function is **pure** — it does not read or write the graph file; the caller
 * is responsible for persisting the returned result.
 *
 * @param entities  - Current entity array from the knowledge graph.
 * @param relations - Current relation array from the knowledge graph.
 * @param now       - Reference timestamp for age calculations (typically `new Date()`).
 * @returns         A new `{ entities, relations }` object with retention rules applied.
 */
export function pruneGraph(entities: Entity[], relations: Relation[], now: Date): PruneResult {
  /** Names of entities that were completely removed (relations referencing them must be dropped). */
  const removedNames = new Set<string>();

  /** Mapping of old entity name → new archive name for renamed metric entities. */
  const renamedEntities = new Map<string, string>();

  const prunedEntities: Entity[] = [];

  for (const entity of entities) {
    // Permanent types are never removed.
    if (PERMANENT_TYPES.has(entity.entityType)) {
      prunedEntities.push(entity);
      continue;
    }

    if (entity.entityType === 'standup') {
      const date = parseDateFromName(entity.name);
      if (date !== null && isOlderThan(date, now, STANDUP_PRUNE_DAYS)) {
        removedNames.add(entity.name);
        // Entity is pruned — do not push to prunedEntities.
        continue;
      }
      prunedEntities.push(entity);
      continue;
    }

    if (entity.entityType === 'metric') {
      const date = parseDateFromName(entity.name);
      if (date !== null && isOlderThan(date, now, METRIC_ARCHIVE_DAYS)) {
        const archiveName = `metric:archive:${entity.name}`;
        const summaryObs = buildArchiveSummary(entity.name, entity.observations, now);
        prunedEntities.push({
          name: archiveName,
          entityType: 'metric',
          observations: summaryObs,
        });
        renamedEntities.set(entity.name, archiveName);
        continue;
      }
      prunedEntities.push(entity);
      continue;
    }

    // All other entity types are kept as-is.
    prunedEntities.push(entity);
  }

  // Update relations:
  //   • Drop relations that reference a removed entity.
  //   • Rewrite the from/to of relations that reference an archived metric.
  const prunedRelations: Relation[] = relations
    .filter(r => !removedNames.has(r.from) && !removedNames.has(r.to))
    .map(r => ({
      from: renamedEntities.get(r.from) ?? r.from,
      to: renamedEntities.get(r.to) ?? r.to,
      relationType: r.relationType,
    }));

  return { entities: prunedEntities, relations: prunedRelations };
}
