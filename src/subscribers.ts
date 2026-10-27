/**
 * Per-device notification settings.
 *
 * Each push subscription carries its own settings per notification key (a
 * service host, `ddns`, or `gh:owner/repo/workflow`) and its own "already told
 * you about this outage" state. The per-service failure count stays shared in
 * `notification_state`, since it's a fact about the service, not the device.
 *
 * A device is identified by its push endpoint: an unguessable URL the browser
 * can always recover with `pushManager.getSubscription()`. Knowing it is what
 * authorises changing that device's settings. It must only travel in request
 * bodies and never be logged in full.
 *
 * The dispatch decision is a pure function, `planServiceNotifications`, so the
 * rules can be tested without D1 or a push service.
 */

import type { NotificationSettings, PushUrgency } from './types';

export interface Subscriber {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  /** Subscribed by a logged-in admin (or in open/gated mode). Only admin
   *  devices may receive admin-only alerts: DDNS and cost. */
  is_admin: number;
  /** What a key with no explicit row means for this device. 0 for devices
   *  that predate per-device settings (keeps their old "no row = off"), 1 for
   *  new ones: subscribing means "tell me when things break". */
  default_enabled: number;
}

export type SettingsByKey = Record<string, NotificationSettings>;

const DISABLED: NotificationSettings = { enabled: 0, failure_threshold: 1, notify_recovery: 0, urgency: null };

/** Keys whose alerts reveal admin-only data (home IPs, spend). */
export function isAdminOnlyKey(key: string): boolean {
  return key === 'ddns' || key.startsWith('ddns:') || key.startsWith('usage:');
}

/** Keys that follow the device default when unset. GitHub workflows stay
 *  opt-in: each enabled one costs a GitHub API call per tick. */
function followsDefault(key: string): boolean {
  return !key.startsWith('gh:');
}

/** The settings that apply to `sub` for `key`, explicit row or fallback. */
export function effectiveSettings(
  sub: Subscriber,
  explicit: SettingsByKey | undefined,
  key: string,
): NotificationSettings {
  if (isAdminOnlyKey(key) && !sub.is_admin) return DISABLED;
  const row = explicit?.[key];
  if (row) return row;
  if (sub.default_enabled && followsDefault(key)) {
    return { enabled: 1, failure_threshold: 1, notify_recovery: 1, urgency: null };
  }
  return DISABLED;
}

// ── Pure dispatch planning ───────────────────────────────────────────────────

export interface ServiceObservation {
  key: string;
  name: string;
  down: boolean;
  /** Consecutive down ticks INCLUDING this one (0 when up). */
  consecutiveDown: number;
}

export interface SubscriberPlan {
  sub: Subscriber;
  /** Crossed this device's threshold this tick and not yet notified. */
  newlyDown: { key: string; name: string }[];
  /** Down and already notified, listed so the replacing notification stays complete. */
  alreadyDown: string[];
  /** Back up after this device was told it was down, and it wants recoveries. */
  recovered: { key: string; name: string }[];
  /** Back up after this device was told; its notified flag must be cleared
   *  whether or not a recovery notice is sent. */
  cleared: string[];
  downUrgency: PushUrgency | null;
  recoveryUrgency: PushUrgency | null;
}

const URGENCY_ORDER: PushUrgency[] = ['very-low', 'low', 'normal', 'high'];

function maxUrgency(a: PushUrgency | null, b: PushUrgency | null): PushUrgency | null {
  if (!a) return b;
  if (!b) return a;
  return URGENCY_ORDER.indexOf(b) > URGENCY_ORDER.indexOf(a) ? b : a;
}

/**
 * Decide, for every device, what this tick's service observations mean.
 * Returns only devices with something to send or clear.
 */
export function planServiceNotifications(
  services: ServiceObservation[],
  subscribers: Subscriber[],
  settings: Map<number, SettingsByKey>,
  notified: Map<number, Set<string>>,
): SubscriberPlan[] {
  const plans: SubscriberPlan[] = [];
  for (const sub of subscribers) {
    const mine = settings.get(sub.id);
    const told = notified.get(sub.id) ?? new Set<string>();
    const plan: SubscriberPlan = {
      sub,
      newlyDown: [],
      alreadyDown: [],
      recovered: [],
      cleared: [],
      downUrgency: null,
      recoveryUrgency: null,
    };

    for (const svc of services) {
      const s = effectiveSettings(sub, mine, svc.key);
      if (svc.down) {
        if (told.has(svc.key)) {
          // Still listed even if since disabled: the notification it's in is
          // replaced by tag, and dropping it would claim the service recovered.
          plan.alreadyDown.push(svc.name);
        } else if (s.enabled && svc.consecutiveDown >= s.failure_threshold) {
          plan.newlyDown.push({ key: svc.key, name: svc.name });
          plan.downUrgency = maxUrgency(plan.downUrgency, s.urgency);
        }
      } else if (told.has(svc.key)) {
        plan.cleared.push(svc.key);
        if (s.enabled && s.notify_recovery) {
          plan.recovered.push({ key: svc.key, name: svc.name });
          plan.recoveryUrgency = maxUrgency(plan.recoveryUrgency, s.urgency);
        }
      }
    }

    if (plan.newlyDown.length || plan.recovered.length || plan.cleared.length) plans.push(plan);
  }
  return plans;
}

// ── Storage ──────────────────────────────────────────────────────────────────

/** Look a device up by its push endpoint. */
export async function getSubscriberByEndpoint(
  db: D1Database | undefined,
  endpoint: string,
): Promise<Subscriber | null> {
  if (!db) return null;
  return db
    .prepare(`SELECT id, endpoint, p256dh, auth, is_admin, default_enabled FROM push_subscriptions WHERE endpoint = ?`)
    .bind(endpoint)
    .first<Subscriber>();
}

export async function countSubscribers(db: D1Database | undefined): Promise<number> {
  if (!db) return 0;
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Insert a device, or refresh the keys of one already known. Admin status only
 * ever ratchets up: the endpoint is the device's credential, so a later
 * anonymous re-subscribe is the same device, not a demotion. An admin removes
 * a device from /subscriptions.
 */
export async function upsertSubscriber(
  db: D1Database | undefined,
  s: { endpoint: string; p256dh: string; auth: string; isAdmin: boolean },
): Promise<void> {
  if (!db) return;
  await db
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, is_admin, default_enabled)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         is_admin = MAX(is_admin, excluded.is_admin)`,
    )
    .bind(s.endpoint, s.p256dh, s.auth, Date.now(), s.isAdmin ? 1 : 0)
    .run();
}

/** Remove a device and everything hanging off it. Explicit rather than relying
 *  on ON DELETE CASCADE, which needs foreign keys switched on. */
export async function deleteSubscriber(db: D1Database | undefined, id: number): Promise<boolean> {
  if (!db) return false;
  const [, , result] = await db.batch([
    db.prepare(`DELETE FROM subscription_settings WHERE subscription_id = ?`).bind(id),
    db.prepare(`DELETE FROM subscription_state WHERE subscription_id = ?`).bind(id),
    db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).bind(id),
  ]);
  return ((result as D1Result).meta?.changes ?? 0) > 0;
}

export async function deleteSubscriberByEndpoint(db: D1Database | undefined, endpoint: string): Promise<void> {
  const sub = await getSubscriberByEndpoint(db, endpoint);
  if (sub) await deleteSubscriber(db, sub.id);
}

/** Every key this device has set explicitly. */
export async function getSubscriberSettings(db: D1Database | undefined, id: number): Promise<SettingsByKey> {
  if (!db) return {};
  const { results } = await db
    .prepare(
      `SELECT key, enabled, failure_threshold, notify_recovery, urgency
       FROM subscription_settings WHERE subscription_id = ?`,
    )
    .bind(id)
    .all<NotificationSettings & { key: string }>();
  const out: SettingsByKey = {};
  for (const { key, ...rest } of results) out[key] = rest;
  return out;
}

/** Set one key for one device, and forget whether it was told about a current
 *  outage, so a settings change never fires a stale notification. */
export async function setSubscriberSetting(
  db: D1Database | undefined,
  id: number,
  key: string,
  s: NotificationSettings,
): Promise<void> {
  if (!db) return;
  await db.batch([
    db
      .prepare(
        `INSERT INTO subscription_settings
           (subscription_id, key, enabled, failure_threshold, notify_recovery, urgency, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(subscription_id, key) DO UPDATE SET
           enabled = excluded.enabled,
           failure_threshold = excluded.failure_threshold,
           notify_recovery = excluded.notify_recovery,
           urgency = excluded.urgency,
           updated_at = excluded.updated_at`,
      )
      .bind(id, key, s.enabled, s.failure_threshold, s.notify_recovery, s.urgency, Date.now()),
    db.prepare(`DELETE FROM subscription_state WHERE subscription_id = ? AND key = ?`).bind(id, key),
  ]);
}

/** Everything dispatch needs, in three queries regardless of device count. */
export async function loadDispatchView(db: D1Database | undefined): Promise<{
  subscribers: Subscriber[];
  settings: Map<number, SettingsByKey>;
  notified: Map<number, Set<string>>;
}> {
  const settings = new Map<number, SettingsByKey>();
  const notified = new Map<number, Set<string>>();
  if (!db) return { subscribers: [], settings, notified };

  const [subs, rows, state] = await Promise.all([
    db
      .prepare(`SELECT id, endpoint, p256dh, auth, is_admin, default_enabled FROM push_subscriptions`)
      .all<Subscriber>(),
    db
      .prepare(
        `SELECT subscription_id, key, enabled, failure_threshold, notify_recovery, urgency FROM subscription_settings`,
      )
      .all<NotificationSettings & { subscription_id: number; key: string }>(),
    db
      .prepare(`SELECT subscription_id, key FROM subscription_state WHERE notified_down = 1`)
      .all<{ subscription_id: number; key: string }>(),
  ]);

  for (const { subscription_id, key, ...rest } of rows.results) {
    let m = settings.get(subscription_id);
    if (!m) settings.set(subscription_id, (m = {}));
    m[key] = rest;
  }
  for (const { subscription_id, key } of state.results) {
    let s = notified.get(subscription_id);
    if (!s) notified.set(subscription_id, (s = new Set()));
    s.add(key);
  }
  return { subscribers: subs.results, settings, notified };
}

/** Record which outages each device has now been told about, or cleared. */
export async function applyNotifiedChanges(
  db: D1Database | undefined,
  set: { id: number; key: string }[],
  clear: { id: number; key: string }[],
): Promise<void> {
  if (!db || (set.length === 0 && clear.length === 0)) return;
  await db.batch([
    ...set.map(({ id, key }) =>
      db
        .prepare(
          `INSERT INTO subscription_state (subscription_id, key, notified_down) VALUES (?, ?, 1)
           ON CONFLICT(subscription_id, key) DO UPDATE SET notified_down = 1`,
        )
        .bind(id, key),
    ),
    ...clear.map(({ id, key }) =>
      db.prepare(`DELETE FROM subscription_state WHERE subscription_id = ? AND key = ?`).bind(id, key),
    ),
  ]);
}

export type DispatchView = Awaited<ReturnType<typeof loadDispatchView>>;
