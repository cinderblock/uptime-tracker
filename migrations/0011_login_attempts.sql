-- Failed-login counts per client IP, for throttling /login. See auth.ts.
-- Rows are deleted on a successful login and swept once their window lapses.

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL, -- ms epoch the current counting window began
  failures INTEGER NOT NULL      -- failed attempts within that window
);
