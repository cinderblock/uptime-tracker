-- Cost monitor: hourly usage samples + threshold config.
-- count_units is the raw count (rows, tokens, requests); cost_micros is USD × 10⁻⁶
-- stored as INTEGER to avoid float drift. Source tells us where the row came from.

CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,        -- 'cloudflare', 'gemini', 'openai', ...
  resource TEXT NOT NULL,        -- 'd1.rows_read', 'kv.writes', 'gemini.tokens.input', ...
  model TEXT,                    -- nullable; for AI providers
  source TEXT NOT NULL,          -- 'graphql', 'push', 'cloud-billing'
  tag TEXT,                      -- optional caller-supplied tag (per-app/feature)
  count_units INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,
  hour_bucket INTEGER NOT NULL,  -- floor(timestamp_ms / 3_600_000)
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_hour ON usage_log(hour_bucket);
CREATE INDEX IF NOT EXISTS idx_usage_provider_hour ON usage_log(provider, hour_bucket);

-- Per-threshold config. Keyed by 'provider:window' (e.g. 'cloudflare:hourly',
-- 'gemini:daily', 'total:daily'). threshold_cents avoids float; INTEGER.
CREATE TABLE IF NOT EXISTS usage_thresholds (
  key TEXT PRIMARY KEY,
  threshold_cents INTEGER NOT NULL,    -- $ × 100
  window_seconds INTEGER NOT NULL,     -- 3600 (hourly) or 86400 (daily)
  enabled INTEGER NOT NULL DEFAULT 1,
  urgency TEXT,                        -- nullable; null = default
  updated_at INTEGER NOT NULL
);
