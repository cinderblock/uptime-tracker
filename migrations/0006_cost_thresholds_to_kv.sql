-- Move cost-monitor thresholds + state from D1 to KV.
-- Thresholds + dedup state now live in KV blobs (`cost:thresholds`,
-- `cost:state`). The `usage_thresholds` table created in 0005 is no longer
-- read; drop it. Any stray notification_state rows with `usage:*` keys are
-- residue from the brief D1 prototype and are no longer consulted; drop them
-- too so `SELECT * FROM notification_state` doesn't lie.
DROP TABLE IF EXISTS usage_thresholds;
DELETE FROM notification_state WHERE key LIKE 'usage:%';
