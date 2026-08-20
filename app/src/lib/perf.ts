/**
 * Temporary timing instrumentation for diagnosing mobile "Save Team"
 * latency (saveXI in teamStore.ts and the transfer-cap helpers it calls).
 *
 * Usage:
 *   let t = perfStart();
 *   await someCall();
 *   t = perfMark('someCall', t);
 *   // ...
 *   perfMark('TOTAL', overallStart);
 *
 * Logs to console with a `[PERF]` prefix so it's easy to filter in the
 * Metro/device log output. Overhead is a single Date.now() + console.log
 * per mark — negligible next to the network round trips being measured.
 *
 * Safe to leave in past the initial diagnosis; remove once the save path
 * has been sped up and the breakdown is no longer needed.
 */

export function perfStart(): number {
  return Date.now();
}

/** Logs elapsed time since `since` under `label`, returns a fresh timestamp to chain from. */
export function perfMark(label: string, since: number): number {
  const now = Date.now();
  console.log(`[PERF] ${label}: ${now - since}ms`);
  return now;
}
