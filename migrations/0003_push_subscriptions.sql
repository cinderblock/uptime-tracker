-- Push notification subscriptions for PWA push notifications

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_notified INTEGER
);

-- Per-service/DDNS/build notification settings (user preferences)

CREATE TABLE IF NOT EXISTS notification_settings (
  key TEXT PRIMARY KEY,               -- service host, 'ddns', or 'gh:{owner}/{repo}/{workflow}'
  enabled INTEGER NOT NULL DEFAULT 0, -- 0 = disabled, 1 = enabled
  failure_threshold INTEGER NOT NULL DEFAULT 1, -- consecutive failures before notifying
  notify_recovery INTEGER NOT NULL DEFAULT 0,   -- 1 = also notify when service recovers
  urgency TEXT DEFAULT NULL,          -- RFC 8030 §5.3: 'very-low', 'low', 'normal', 'high'; NULL = smart default
  updated_at INTEGER NOT NULL
);

-- Runtime notification state (managed by scheduler, separate from user preferences)

CREATE TABLE IF NOT EXISTS notification_state (
  key TEXT PRIMARY KEY,
  consecutive_down INTEGER NOT NULL DEFAULT 0, -- current consecutive failure count
  notified_down INTEGER NOT NULL DEFAULT 0     -- 1 = down notification already sent for this outage
);
