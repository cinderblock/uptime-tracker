-- Status Dashboard Schema

-- Check results table
CREATE TABLE checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL,  -- 'http' or 'https'
  status TEXT NOT NULL,  -- 'up' or 'down'
  code INTEGER,
  latency INTEGER NOT NULL,  -- ms
  error TEXT,
  source TEXT NOT NULL,  -- 'edge' or 'browser'
  timestamp INTEGER NOT NULL,  -- Unix ms
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for common queries
CREATE INDEX idx_checks_service ON checks(service);
CREATE INDEX idx_checks_timestamp ON checks(timestamp DESC);
CREATE INDEX idx_checks_service_timestamp ON checks(service, timestamp DESC);
CREATE INDEX idx_checks_type_timestamp ON checks(type, timestamp DESC);

-- Current status cache (optional, for fast dashboard loads)
CREATE TABLE current_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- Single row
  data TEXT NOT NULL,  -- JSON blob
  updated_at INTEGER NOT NULL
);
