/** Cost-monitor dashboard panel: per-provider 24h totals, hourly sparkline,
 *  and threshold gauges. Server-rendered HTML; data is computed once per
 *  dashboard load (cheap — all queries are bounded by hour_bucket). */

import type { ThresholdStatus } from './thresholds';
import type { ProviderTotal, HourSample } from './store';

export interface CostPanelData {
  providers: ProviderTotal[];
  hourly: HourSample[];
  thresholds: ThresholdStatus[];
  /** Total across all providers for the last 24h (matches sum of providers). */
  total24hMicros: bigint;
  /** Per-provider spend since 00:00 UTC on the 1st of the current month. */
  thisBillingPeriod: ProviderTotal[];
  totalBillingPeriodMicros: bigint;
  /** Per-provider spend for the previous calendar month (UTC). */
  lastMonth: ProviderTotal[];
  totalLastMonthMicros: bigint;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fmtUsd(micros: bigint): string {
  const dollars = Number(micros) / 1_000_000;
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  if (dollars >= 0.01) return `$${dollars.toFixed(3)}`;
  if (dollars >= 0.0001) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toExponential(1)}`;
}

function windowLabel(windowSeconds: number): string {
  if (windowSeconds === 3600) return 'hourly';
  if (windowSeconds === 86400) return 'daily';
  return `${Math.round(windowSeconds / 3600)}h`;
}

function scopeLabel(scope: string): string {
  if (scope === 'total') return 'Total';
  return scope.charAt(0).toUpperCase() + scope.slice(1);
}

/** Pick a CSS class based on threshold fraction used. */
function gaugeClass(fraction: number): string {
  if (fraction >= 1) return 'gauge-over';
  if (fraction >= 0.9) return 'gauge-high';
  if (fraction >= 0.7) return 'gauge-mid';
  return 'gauge-low';
}

/** Build a tiny inline SVG sparkline: 24 hourly bars, stacked by provider. */
function renderSparkline(hourly: HourSample[]): string {
  if (hourly.length === 0) {
    return '<div class="cost-sparkline-empty">no data yet</div>';
  }
  // Group by hour_bucket, summing across providers (stack would be nicer but
  // overkill for the v1 panel — keep it readable).
  const totals = new Map<number, bigint>();
  for (const s of hourly) {
    totals.set(s.hourBucket, (totals.get(s.hourBucket) ?? 0n) + s.costMicros);
  }
  const buckets = Array.from(totals.entries()).sort(([a], [b]) => a - b);
  // Render exactly the buckets we have, normalized to the max
  const max = buckets.reduce((m, [, v]) => (v > m ? v : m), 0n);
  if (max === 0n) return '<div class="cost-sparkline-empty">no spend yet</div>';

  const W = 240;
  const H = 32;
  const barW = W / buckets.length;
  const bars = buckets
    .map(([bucket, v], i) => {
      const h = max === 0n ? 0 : Number((v * BigInt(H)) / max);
      const x = (i * barW).toFixed(2);
      const y = H - h;
      const usd = fmtUsd(v);
      const dt = new Date(bucket * 3_600_000).toISOString().slice(11, 16);
      return `<rect x="${x}" y="${y}" width="${(barW - 1).toFixed(2)}" height="${h}" class="cost-bar"><title>${dt} UTC: ${usd}</title></rect>`;
    })
    .join('');
  return `<svg class="cost-sparkline" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">${bars}</svg>`;
}

function renderThresholdRow(t: ThresholdStatus): string {
  const fraction = Math.min(Math.max(t.fractionUsed, 0), 1.5);
  const pct = (fraction * 100).toFixed(0);
  const widthPct = Math.min(fraction * 100, 100).toFixed(1);
  const cls = gaugeClass(t.fractionUsed);
  const limit = (t.thresholdCents / 100).toFixed(2);
  const current = fmtUsd(t.currentCostMicros);
  const label = `${scopeLabel(t.scope)} ${windowLabel(t.windowSeconds)}`;
  return `
    <div class="cost-threshold ${t.enabled ? '' : 'cost-threshold-disabled'}">
      <div class="cost-threshold-label">
        <span>${escapeHtml(label)}</span>
        <span class="cost-threshold-vals">${current} / $${limit} (${pct}%)</span>
      </div>
      <div class="cost-gauge">
        <div class="cost-gauge-fill ${cls}" style="width: ${widthPct}%"></div>
      </div>
    </div>
  `;
}

/** Render a labeled section showing per-provider totals for one time window. */
function renderProviderSection(title: string, total: bigint, providers: ProviderTotal[], emptyMessage: string): string {
  const body =
    providers.length === 0
      ? `<div class="cost-empty">${escapeHtml(emptyMessage)}</div>`
      : `<div class="cost-providers">${providers
          .sort((a, b) => Number(b.costMicros - a.costMicros))
          .map(
            p =>
              `<div class="cost-provider-row"><span>${escapeHtml(scopeLabel(p.provider))}</span><span>${fmtUsd(p.costMicros)}</span></div>`,
          )
          .join('')}</div>`;
  return `
    <div class="cost-section">
      <div class="cost-section-header"><span>${escapeHtml(title)}</span><span>${fmtUsd(total)}</span></div>
      ${body}
    </div>
  `;
}

/** One labeled total in the panel header (e.g. "24h $1.23"). */
function renderHeaderStat(label: string, tooltip: string, micros: bigint): string {
  return `<span class="cost-header-stat" title="${escapeHtml(tooltip)}"><span class="cost-header-label">${escapeHtml(label)}</span>${fmtUsd(micros)}</span>`;
}

export function renderCostPanelHtml(data: CostPanelData): string {
  const thresholds =
    data.thresholds.length === 0
      ? '<div class="cost-empty">no thresholds configured — seed via SQL (see plans/cost-monitor.md)</div>'
      : data.thresholds.map(renderThresholdRow).join('');

  // No bell button here — the existing notif-settings-modal is keyed to
  // notification_settings (failure_threshold / notify_recovery / urgency),
  // none of which apply to cost thresholds (those live in usage_thresholds
  // and notify any time the window crosses). A dedicated cost-threshold
  // settings modal is deferred to follow-up.
  return `
    <div class="panel cost-panel" data-panel>
      <div class="panel-header">
        <span class="panel-title">Costs</span>
        <span class="panel-count cost-header-totals">
          ${renderHeaderStat('24h', 'Last 24 hours', data.total24hMicros)}
          ${renderHeaderStat('mo', 'This billing period (calendar month UTC)', data.totalBillingPeriodMicros)}
          ${renderHeaderStat('last', 'Last calendar month (UTC)', data.totalLastMonthMicros)}
        </span>
      </div>
      <div class="cost-body">
        ${renderProviderSection('Last 24h', data.total24hMicros, data.providers, 'no usage yet — next CF poll runs at :01 of each hour')}
        ${renderSparkline(data.hourly)}
        ${renderProviderSection('This billing period', data.totalBillingPeriodMicros, data.thisBillingPeriod, 'no usage recorded yet this month')}
        ${renderProviderSection('Last month', data.totalLastMonthMicros, data.lastMonth, 'no usage recorded last month')}
        <div class="cost-thresholds">${thresholds}</div>
      </div>
    </div>
  `;
}

/** CSS injected into the dashboard's <style> block by ui.ts. */
export const COST_PANEL_CSS = `
  .cost-panel .cost-body { padding: 0.75rem; display: flex; flex-direction: column; gap: 0.75rem; }
  .cost-header-totals { display: flex; gap: 0.5rem; flex-wrap: wrap; justify-content: flex-end; align-items: baseline; }
  .cost-header-stat { font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--text); }
  .cost-header-label { font-size: 0.625rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin-right: 0.25rem; }
  .cost-section { display: flex; flex-direction: column; gap: 0.25rem; }
  .cost-section-header { display: flex; justify-content: space-between; font-size: 0.75rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.02em; padding-bottom: 0.125rem; border-bottom: 1px dashed var(--border); }
  .cost-section-header span:last-child { font-variant-numeric: tabular-nums; color: var(--text); font-weight: 600; }
  .cost-providers { display: flex; flex-direction: column; gap: 0.25rem; }
  .cost-provider-row { display: flex; justify-content: space-between; font-size: 0.813rem; padding: 0.25rem 0; }
  .cost-provider-row span:last-child { font-variant-numeric: tabular-nums; color: var(--text-muted); }
  .cost-sparkline { display: block; width: 100%; height: 32px; }
  .cost-sparkline-empty { font-size: 0.75rem; color: var(--text-muted); padding: 0.5rem 0; text-align: center; }
  .cost-bar { fill: var(--text-link); opacity: 0.7; }
  .cost-bar:hover { opacity: 1; }
  .cost-thresholds { display: flex; flex-direction: column; gap: 0.5rem; padding-top: 0.25rem; border-top: 1px dashed var(--border); }
  .cost-threshold-disabled { opacity: 0.4; }
  .cost-threshold-label { display: flex; justify-content: space-between; font-size: 0.75rem; margin-bottom: 0.25rem; }
  .cost-threshold-vals { color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .cost-gauge { height: 6px; background: var(--bg-service); border-radius: 3px; overflow: hidden; border: 1px solid var(--border); }
  .cost-gauge-fill { height: 100%; transition: width 0.3s; }
  .cost-gauge-fill.gauge-low { background: var(--color-up); }
  .cost-gauge-fill.gauge-mid { background: var(--color-warn); }
  .cost-gauge-fill.gauge-high { background: #f0883e; }
  .cost-gauge-fill.gauge-over { background: var(--color-down); }
  .cost-empty { font-size: 0.75rem; color: var(--text-muted); padding: 0.5rem; text-align: center; }
`;
