/**
 * `produces:` parsing (package B, pure): numbers from a run's stripped output.
 *
 * Contract: docs/plans/2026-09-25-copilot-v2-contracts.md §7.6.
 */

import type { OperationProduces, OperationReading } from '../../shared/cockpit';
import { compileProducesRegex } from './ops-config';

/** For each entry, the first group of the LAST match, as a number; NaN and non-matches are skipped. */
export function parseReadings(output: string, produces: OperationProduces[] | undefined): OperationReading[] {
  const out: OperationReading[] = [];
  for (const p of produces ?? []) {
    const re = compileProducesRegex(p.parse);
    if (!re) continue;
    let last: string | undefined;
    for (const m of output.matchAll(re)) last = m[1];
    if (last === undefined) continue;
    const value = Number(last.trim());
    if (last.trim() === '' || Number.isNaN(value)) continue;
    out.push({ metric: p.metric, value, unit: p.unit ?? null });
  }
  return out;
}

/** "cold_start_ms 1412 (last 1590)" */
export function readingLabel(r: OperationReading, previous: number | null): string {
  return `${r.metric} ${r.value}${previous != null ? ` (last ${previous})` : ''}`;
}
