/**
 * Reuse expensive dashboard reads until the cron writes new data.
 *
 * Chart and uptime data are rebuilt from storage on every page view: on the
 * free profile that's the hourly rollup scanned twice plus six hours of raw
 * checks, about 1.5–2k D1 rows for three services. They only change when a
 * scheduled tick runs, and every tick ends by saving the status blob with a new
 * `lastUpdate`. So `lastUpdate` works as a generation number: a warm isolate
 * keeps each result until it changes, and a page view then costs one
 * single-row status read.
 *
 * The rollups and history are written before the status blob, so a new
 * generation never points at old data. The transition timeline is written after
 * it, so it isn't memoized here (it's a single-row read anyway).
 */

interface Entry {
  generation: number;
  value: Promise<unknown>;
}

export type GenerationMemo = <T>(
  name: string,
  generation: number | null | undefined,
  load: () => Promise<T>,
) => Promise<T>;

/** One memo per worker instance. `createWorker` holds it, so separate workers
 *  (and tests) never share entries. */
export function createGenerationMemo(): GenerationMemo {
  const entries = new Map<string, Entry>();
  return <T>(name: string, generation: number | null | undefined, load: () => Promise<T>): Promise<T> => {
    // No data yet: nothing to key on, so don't remember the empty result.
    if (!generation) return load();
    const hit = entries.get(name);
    if (hit && hit.generation === generation) return hit.value as Promise<T>;
    // Store the promise, not the result, so concurrent views share one load.
    const value = load();
    entries.set(name, { generation, value });
    value.catch(() => {
      if (entries.get(name)?.value === value) entries.delete(name);
    });
    return value;
  };
}
