-- Move check results to a table that costs 2 D1 rows written per insert.
--
-- D1 counts every index entry, and the AUTOINCREMENT counter, as a row
-- written. The old table wrote 7 per check: the row, five indexes
-- (idx_checks_service, _timestamp, _service_timestamp, _type_timestamp,
-- _status_timestamp) and the sqlite_sequence update. Free allows 100k rows
-- written a day; paid bills them past 50M a month. On the ops deployment
-- (~115k checks a day) check inserts were 83% of all D1 writes.
--
-- The new table:
--   - plain INTEGER PRIMARY KEY: no AUTOINCREMENT, so no sqlite_sequence write;
--   - (service, timestamp) for the history popup and per-service /errors;
--   - timestamp for 'down' rows only (a partial index) for /errors. Up rows,
--     nearly all of them, don't pay for it.
-- Everything else time-bounded (retention, the free chart's last 6 h, rollup
-- rebuilds) bounds by id instead: ids rise with time, and the id for a time is
-- found by binary search over the primary key. See src/check-tables.ts.
--
-- Nothing is copied. Copying a week of free-plan history would cost about the
-- whole day's 100k-write allowance. The old table is renamed to checks_legacy,
-- readers query both, and the retention sweep empties it. Its indexes follow
-- the rename, so that sweep stays indexed. A later migration moves any rows
-- still left and drops it.

ALTER TABLE checks RENAME TO checks_legacy;

CREATE TABLE checks (
  id INTEGER PRIMARY KEY,
  service TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL,        -- 'http', 'https' or 'secret'
  status TEXT NOT NULL,      -- 'up' or 'down'
  code INTEGER,
  latency INTEGER NOT NULL,  -- ms
  error TEXT,
  source TEXT NOT NULL,      -- 'edge' or 'browser'
  timestamp INTEGER NOT NULL -- Unix ms
);

CREATE INDEX idx_checks_svc_ts ON checks(service, timestamp DESC);
CREATE INDEX idx_checks_down_ts ON checks(timestamp DESC) WHERE status = 'down';
