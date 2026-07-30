-- Log of every notification event sent (one row per notification, not per subscriber)

CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,              -- service host, 'ddns', or 'gh:{owner}/{repo}/{workflow}'
  type TEXT NOT NULL,             -- 'service-down', 'service-recovery', 'ddns-failure', 'ddns-recovery', 'build-failed', 'build-recovery'
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  urgency TEXT,                   -- RFC 8030 urgency level used
  subscribers_notified INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,  -- 1 = at least one subscriber received it
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_log_timestamp ON notification_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_notification_log_key ON notification_log(key);
CREATE INDEX IF NOT EXISTS idx_notification_log_type ON notification_log(type);
