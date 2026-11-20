// Where check results live in D1, and the one place that knows there are two
// tables during the move to the cheaper `checks` table (migration 0013).
//
// `checks_legacy` is the old AUTOINCREMENT table. It gets no new rows; the
// retention sweep empties it. A later migration copies whatever is left into
// `checks` (with negative ids, so ids stay in time order) and drops it; then
// it comes out of CHECK_TABLES. Every reader goes through unionChecks, so
// that is the whole cleanup.
//
// The new `checks` has no index on timestamp for 'up' rows: each index entry
// is a billed row write on every insert. Its ids rise with insertion time
// instead, so a time cutoff becomes an id cutoff, found by binary search over
// the primary key (firstIdAtOrAfter). Retention and every time-bounded read
// that no other index serves use it.

export const CHECK_TABLES = ['checks', 'checks_legacy'] as const;
export type CheckTable = (typeof CHECK_TABLES)[number];

/** One SELECT per check table, joined with UNION ALL. `arm` gets a table name
 *  and returns a complete SELECT (it may carry its own ORDER BY / LIMIT). Use
 *  numbered parameters (?1, ?2, …) inside `arm`, so every arm reuses the same
 *  bindings. */
export function unionChecks(arm: (table: CheckTable) => string): string {
  return CHECK_TABLES.map(t => `SELECT * FROM (${arm(t)})`).join('\nUNION ALL\n');
}

/** SQL scalar: the id boundary for time `param` (a numbered parameter holding
 *  Unix ms). `checks` rows with id >= it are exactly those at or after `param`;
 *  it may fall in a gap between ids. NULL on an empty table, which makes both
 *  `id >= NULL` and `id < NULL` match nothing.
 *
 *  ~log2(rows) primary-key probes. Each reads the first row at or after the
 *  midpoint, so gaps left by deletes don't matter. `lo + (hi - lo) / 2` keeps
 *  the midpoint in [lo, hi) for negative ids too (SQLite's `/` truncates toward
 *  zero). A check's timestamp and its insertion order can disagree by under a
 *  tick, which only moves the cutoff by that much. */
export function firstIdAtOrAfter(param: string): string {
  const probe = `(SELECT timestamp FROM checks WHERE id >= lo + (hi - lo) / 2 ORDER BY id LIMIT 1)`;
  return `(
  WITH RECURSIVE bs(lo, hi) AS (
    SELECT (SELECT MIN(id) FROM checks), (SELECT MAX(id) FROM checks) + 1
    UNION ALL
    SELECT CASE WHEN ${probe} < ${param} THEN lo + (hi - lo) / 2 + 1 ELSE lo END,
           CASE WHEN ${probe} < ${param} THEN hi ELSE lo + (hi - lo) / 2 END
    FROM bs WHERE lo < hi
  )
  SELECT lo FROM bs WHERE lo >= hi
)`;
}

/** WHERE condition: `table`'s rows after `param` (Unix ms). On `checks` it
 *  bounds by id first, so the read is a primary-key range, not a table scan.
 *  `checks_legacy` still has its timestamp index. */
export function checksSince(table: CheckTable, param: string): string {
  return table === 'checks' ? `id >= ${firstIdAtOrAfter(param)} AND timestamp > ${param}` : `timestamp > ${param}`;
}

/** Delete `checks` rows older than ?1 (Unix ms). */
export const DELETE_CHECKS_BEFORE = `DELETE FROM checks WHERE id < ${firstIdAtOrAfter('?1')}`;
