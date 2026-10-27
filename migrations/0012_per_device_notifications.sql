-- Per-device notification settings. See src/subscribers.ts.
--
-- Until now, notification_settings held ONE set of settings for the whole
-- deployment, and every device got every alert. Each device now carries its
-- own. Existing devices keep exactly what they had: they get a copy of every
-- global row, default_enabled = 0 (so keys without a row stay off, as before),
-- and their "already told you" marks. They were all subscribed in open or gated
-- mode, so they're all admin devices.
--
-- notification_settings is left in place, unused, rather than dropped, so a
-- rollback to the previous release still finds it.

ALTER TABLE push_subscriptions ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 1;
ALTER TABLE push_subscriptions ADD COLUMN default_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS subscription_settings (
  subscription_id INTEGER NOT NULL,
  key TEXT NOT NULL,                            -- service host, 'ddns', or 'gh:{owner}/{repo}/{workflow}'
  enabled INTEGER NOT NULL DEFAULT 0,
  failure_threshold INTEGER NOT NULL DEFAULT 1, -- consecutive failures before notifying
  notify_recovery INTEGER NOT NULL DEFAULT 0,
  urgency TEXT DEFAULT NULL,                    -- 'very-low', 'low', 'normal', 'high'; NULL = smart default
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, key)
);

-- Which outages each device has been told about (services only; one-shot DDNS
-- and build events keep their state per key in notification_state).
CREATE TABLE IF NOT EXISTS subscription_state (
  subscription_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  notified_down INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subscription_id, key)
);

INSERT INTO subscription_settings
  (subscription_id, key, enabled, failure_threshold, notify_recovery, urgency, updated_at)
SELECT s.id, n.key, n.enabled, n.failure_threshold, n.notify_recovery, n.urgency, n.updated_at
FROM push_subscriptions s CROSS JOIN notification_settings n;

-- Carry over "already notified" so an outage in progress isn't announced twice.
INSERT INTO subscription_state (subscription_id, key, notified_down)
SELECT s.id, ns.key, 1
FROM push_subscriptions s CROSS JOIN notification_state ns
WHERE ns.notified_down = 1;
