// ============================================
// Configuration Types (from YAML)
// ============================================

/** A label definition with a display name and visual color */
export interface LabelDefinition {
  /** Unique identifier for the label (used in filtering, CSS variables). Use [a-z0-9-] only. */
  id: string;
  /** Display name shown in the UI */
  name: string;
  /** CSS color for the label dot/indicator (hex, hsl, named color) */
  color: string;
}

/** HTTP check - can be a simple path or detailed config */
export type HttpCheckConfig = string | HttpCheckDetails;

export interface HttpCheckDetails {
  url: string;
  /** Expected status code (default: 200) */
  expect?: number;
  /** HTTP method (default: GET) */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'OPTIONS';
  /** Custom headers */
  headers?: Record<string, string>;
  /** Request body (for POST/PUT) */
  body?: string;
  /** Timeout in seconds (overrides service timeout) */
  timeout?: number;
  /** Follow redirects (default: true) */
  follow?: boolean;
  /** Expected redirect location (implies expect: 3xx) */
  redirect?: string;
}

export interface ServiceConfig {
  /** Display name (defaults to host if unset) */
  name?: string;
  /** Host(s) for checks — string for single, array for multiple domains */
  host: string | string[];
  /** Default timeout in seconds */
  timeout?: number;
  /** Known status override */
  status?: 'known-down' | 'known-up';
  /** Reason for status override */
  reason?: string;
  /** If true, checks only run from browser (internal network) */
  internal?: boolean;
  /** HTTP checks (port 80) */
  http?: HttpCheckConfig | HttpCheckConfig[];
  /** HTTPS checks (port 443) */
  https?: HttpCheckConfig | HttpCheckConfig[];
  /** Check www subdomain redirects.
   *  `true`         → expect www→apex (http://www.host → https://host/)
   *  `{ redirect }` → expect a custom redirect target (e.g. apex itself redirects elsewhere)
   */
  www?: boolean | { redirect: string };
  /** Location flag emoji */
  location?: string;
  /** Full location name for tooltip */
  locationTitle?: string;
  /** Hosting provider key (e.g., "hetzner", "digitalocean") */
  provider?: string;
  /** Direct link to server management page (overrides provider URL) */
  link?: string;
  /** Label IDs this service belongs to (references DashboardConfig.labels) */
  labels?: string[];
}

export interface PanelConfig {
  panel: string;
  services: ServiceConfig[];
}

export interface DashboardConfig {
  /** Label definitions for cross-panel service tagging */
  labels?: LabelDefinition[];
  panels: PanelConfig[];
  githubWorkflows?: GitHubWorkflowConfig[];
  /** Hosting providers referenced by `ServiceConfig.provider`, keyed by provider id.
   *  Bring your own — no vendor logos ship with this project. */
  providers?: Record<string, ProviderDefinition>;
  /** Optional markup for `ServiceConfig.location` values, keyed by the location
   *  string (e.g. `{ DE: '<svg …>' }` or `{ SF: '🌉' }`). Locations with no entry
   *  render as plain text. */
  flags?: Record<string, string>;
}

/** A hosting provider badge shown next to a service. */
export interface ProviderDefinition {
  /** Display name, shown on hover */
  name: string;
  /** Console URL, used when a service has no explicit `link` */
  url?: string;
  /** Inline SVG for the badge. Omit to use a generic server glyph.
   *  Note: vendor logos are trademarks — check the vendor's brand guidelines
   *  before redistributing one in a public repo. */
  icon?: string;
  /** CSS color for the badge */
  color?: string;
}

export interface GitHubWorkflowConfig {
  owner: string;
  repo: string;
  /** Workflow filename, e.g. "deploy.yml" */
  workflow: string;
  /** Display name (defaults to workflow filename without extension) */
  displayName?: string;
}

/** A dynamic-DNS hostname we expect to keep checking in via the DDNS worker. */
export interface DdnsClient {
  /** Hostname the gateway updates, e.g. "home.example.com" */
  hostname: string;
  /** Human-friendly label for notifications, e.g. "Home office" */
  label: string;
  /** Whether this client sends regular check-ins (a heartbeat), so a staleness
   *  alert is meaningful. inadyn (UXG) re-sends every ~2 min → true. ddclient
   *  (USG) only contacts the worker when the IP changes → silent by design, so
   *  leave false/unset to skip staleness alerting (IP-change alerts still fire). */
  heartbeat?: boolean;
}

// ============================================
// Check Result Types
// ============================================

export type CheckStatus = 'up' | 'down';

export interface CheckResult {
  /** Service name */
  service: string;
  /** Full URL that was checked */
  url: string;
  /** Check type (http or https) */
  type: 'http' | 'https';
  /** Up or down */
  status: CheckStatus;
  /** HTTP status code (if response received) */
  code?: number;
  /** Response time in milliseconds */
  latency: number;
  /** Error message (if failed) */
  error?: string;
  /** When this check ran (Unix timestamp ms) */
  timestamp: number;
  /** Where the check ran from */
  source: 'edge' | 'browser';
}

export interface ServiceStatus {
  name: string;
  host?: string;
  /** Overall status (worst of all checks) */
  status: CheckStatus;
  /** Known status override from config */
  knownStatus?: 'known-down' | 'known-up';
  /** Reason for known status */
  reason?: string;
  /** Is this an internal-only service */
  internal: boolean;
  /** Individual check results */
  checks: CheckResult[];
  /** WWW redirect check result (if www: true in config) */
  wwwCheck?: CheckResult;
  /** Location flag emoji */
  location?: string;
  /** Full location name for tooltip */
  locationTitle?: string;
  /** Hosting provider key */
  provider?: string;
  /** Direct link to server management page */
  link?: string;
  /** Label IDs this service belongs to */
  labels?: string[];
}

export interface PanelStatus {
  panel: string;
  services: ServiceStatus[];
}

export interface HistoryEntry {
  timestamp: number;
  status: CheckStatus;
  latency: number;
  code?: number;
  error?: string;
}

// ============================================
// Transition Timeline (correlation swimlanes)
// ============================================

/** Which kind of entity a timeline lane represents. */
export type LaneKind = 'service' | 'github' | 'ddns';

/** A single state flip on a lane. `up`: 1 = up/passing/alive, 0 = down/failing/silent. */
export interface Transition {
  ts: number;
  up: 0 | 1;
  /** Optional context for the hover tooltip (HTTP code, GH conclusion, "silent 3h"). */
  detail?: string;
}

/** Per-entity timeline state: the last-known status plus the list of flips. */
export interface LaneState {
  kind: LaneKind;
  /** Display label for the lane row. */
  label: string;
  /** Optional click target (GitHub workflow URL, service host). */
  link?: string;
  /** Last observed state, used to detect flips. */
  current: 0 | 1;
  /** Last time this lane was observed (for staleness / segment end). */
  lastSeen: number;
  /** Flips, sorted ascending by ts. Each entry begins a new colored segment. */
  transitions: Transition[];
}

/** Keyed by stable id: service name, `gh:{owner}/{repo}/{workflow}`, or `ddns:{hostname}`. */
export type TransitionsState = Record<string, LaneState>;

/** One observation of a lane's current state, fed to updateTransitions each cron tick. */
export interface LaneObservation {
  key: string;
  kind: LaneKind;
  label: string;
  up: 0 | 1;
  ts: number;
  link?: string;
  detail?: string;
}

// ============================================
// Notification Settings
// ============================================

/** RFC 8030 §5.3 push message urgency levels */
export type PushUrgency = 'very-low' | 'low' | 'normal' | 'high';

export interface NotificationSettings {
  /** 0 = disabled, 1 = enabled */
  enabled: number;
  /** Number of consecutive failures before sending a notification */
  failure_threshold: number;
  /** 1 = also send a notification when the service recovers */
  notify_recovery: number;
  /** RFC 8030 urgency override. null = use event-type smart default */
  urgency: PushUrgency | null;
}

/** Resolved display options for a single notification send */
export interface NotificationDisplayOptions {
  urgency: PushUrgency;
  silent: boolean;
  requireInteraction: boolean;
}

export interface NotificationState {
  /** For service checks: current consecutive failure count.
   *  For DDNS/GitHub keys: last-seen event/run ID (repurposed as dedup cursor). */
  consecutive_down: number;
  /** 1 = down notification already sent for this outage */
  notified_down: number;
}

// ============================================
// Notification Log
// ============================================

export type NotificationEventType =
  | 'service-down'
  | 'service-recovery'
  | 'build-failed'
  | 'build-recovery'
  | 'ddns-failure'
  | 'ddns-recovery'
  | 'ddns-ip-change'
  | 'usage-threshold'
  | 'usage-reconcile';

export interface NotificationLogEntry {
  id: number;
  /** service host, 'ddns', or 'gh:{owner}/{repo}/{workflow}' */
  key: string;
  type: NotificationEventType;
  title: string;
  body: string;
  urgency: PushUrgency | null;
  /** Number of subscribers that were active at send time */
  subscribers_notified: number;
  /** 1 = at least one subscriber received it */
  delivered: number;
  timestamp: number;
}

// ============================================
// Worker Environment
// ============================================

export interface Env {
  DB?: D1Database; // Optional for local dev without binding
  KV?: KVNamespace; // Hot-path cache for dashboard status + last-checked times
  /** base64url-encoded 65-byte uncompressed P-256 public key for VAPID push notifications (plain var — not sensitive) */
  VAPID_PUBLIC_KEY?: string;
  /** base64url-encoded 32-byte raw P-256 private key scalar for VAPID push notifications (secret — wrangler secret put) */
  VAPID_PRIVATE_KEY?: string;
  /** "mailto:…" or HTTPS URL identifying the push notification sender (plain var — not sensitive) */
  VAPID_SUBJECT?: string;
  /** GitHub Personal Access Token for polling workflow run statuses (secret — wrangler secret put) */
  GITHUB_TOKEN?: string;
  /** Concurrency pool config: "max periodMs start increment" (default "25 10 1 1") */
  CHECK_CONCURRENCY?: string;
  /** Cloudflare API token with Account Analytics:Read for the cost monitor's GraphQL polls (secret) */
  CF_ANALYTICS_TOKEN?: string;
  /** Cloudflare account ID for GraphQL Analytics queries (plain var, not sensitive) */
  CF_ACCOUNT_ID?: string;

  // ── Plan profile ───────────────────────────────────────────────────────────
  /** "free" or "paid" — selects a bundle of budgets and the storage path.
   *  See plan.ts. Defaults to "paid" when unset. */
  PLAN?: string;
  /** Cron interval in minutes, matching [triggers] in wrangler.toml. Used to
   *  derive cache TTLs and per-day budgets. Defaults to the profile's own. */
  CRON_INTERVAL_MINUTES?: string;
  /** Override the profile's per-tick outbound check budget. */
  CHECK_BUDGET?: string;
  /** Days of raw check history to keep. Overrides the profile default (paid 30,
   *  free 7). Lowering this DELETES history past the new window on the next
   *  cleanup tick — set it explicitly before switching plans if you want to keep
   *  more than the target profile's default. */
  HISTORY_RETENTION_DAYS?: string;

  // ── Auth ───────────────────────────────────────────────────────────────────
  /** Shared passphrase gating the dashboard (secret — wrangler secret put).
   *  When unset the dashboard is PUBLIC; see README "Authentication". */
  DASHBOARD_PASSWORD?: string;
  /** Random string used to sign auth cookies (secret — wrangler secret put).
   *  Required whenever DASHBOARD_PASSWORD is set. */
  AUTH_SECRET?: string;
  /** Bearer token for POST /api/usage (secret — wrangler secret put). Unset
   *  disables the endpoint; it is never open, since it writes to the database. */
  USAGE_TOKEN?: string;
  /** "true" turns on the read-only public view: anyone may see status, only a
   *  logged-in admin sees DDNS, cost, errors and the admin pages. Unset keeps
   *  the all-or-nothing behaviour above. See README "Public mode". */
  PUBLIC_DASHBOARD?: string;
}

/** Who is looking at the dashboard, and whether they could log in. */
export interface DashboardAccess {
  /** Sees everything: DDNS, cost, errors, history deletion, admin pages. */
  admin: boolean;
  /** A password is set: offer non-admins an Admin link, and admins Log out. */
  loginAvailable: boolean;
}
