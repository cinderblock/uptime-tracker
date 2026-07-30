-- Seed the DDNS ip-change notifier's cursor.
--
-- sendDdnsIpChangeNotifications alerts on every ddns_log `ip_change` row with id
-- greater than notification_state('ddns:ip-change').consecutive_down. Seed that
-- cursor to the current MAX(id) so existing history never triggers a backlog of
-- alerts — only IP changes recorded after this deploy notify. INSERT OR IGNORE
-- so a later re-run never rewinds the cursor.

INSERT OR IGNORE INTO notification_state (key, consecutive_down, notified_down)
SELECT 'ddns:ip-change', COALESCE(MAX(id), 0), 0 FROM ddns_log;
