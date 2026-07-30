-- Seed the DDNS notification settings row, disabled by default.
--
-- DDNS push alerts are gated on a `notification_settings` row keyed 'ddns'.
-- Without the row, the dashboard's bell toggle has nothing to flip and alerting
-- silently stays off with no way to turn it on. Seed it so the control works.
--
-- Shipped disabled: most deployments have no DDNS updater pointed at this
-- database, and alerting on a client that will never report is just noise.
-- Turn it on with the bell toggle on the DDNS panel once you have a client
-- writing to `ddns_log` (see docs/ddns.md), or flip `enabled` to 1 here.
--
-- INSERT OR IGNORE so re-running never clobbers a choice made in the dashboard.
--
-- failure_threshold is unused for the 'ddns' key (alerting is staleness-based
-- per hostname), so its value is irrelevant; kept at 1 for consistency.

INSERT OR IGNORE INTO notification_settings (key, enabled, failure_threshold, notify_recovery, urgency, updated_at)
VALUES ('ddns', 0, 1, 1, 'high', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
