-- DDNS Activity Log

CREATE TABLE ddns_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,       -- 'ip_change', 'no_change', 'rejected', 'not_found', 'error'
  hostname TEXT,             -- null for 404s / pre-auth failures
  zone TEXT,                 -- null for 404s / pre-auth failures
  old_ip TEXT,               -- only for ip_change
  new_ip TEXT,               -- only for ip_change / no_change
  source_ip TEXT,            -- requester IP (CF-Connecting-IP)
  path TEXT,                 -- request pathname
  status_code INTEGER NOT NULL, -- HTTP status code returned
  message TEXT,              -- response/error message
  timestamp INTEGER NOT NULL,  -- Unix ms (consistent with checks table)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Index for dashboard queries (recent events, sorted by time)
CREATE INDEX idx_ddns_log_timestamp ON ddns_log(timestamp DESC);

-- Index for filtering by event type
CREATE INDEX idx_ddns_log_event ON ddns_log(event, timestamp DESC);
