import type {
  DashboardAccess,
  DashboardConfig,
  GitHubWorkflowConfig,
  LabelDefinition,
  PanelStatus,
  ServiceStatus,
} from './types';
import { chartIntervals, type PlanProfile } from './plan';
import type { ChartData, DdnsLogEntry, UptimeByPeriod } from './storage';
import { renderCostPanelHtml, COST_PANEL_CSS, type CostPanelData } from './cost/ui';

/** Format latency for display */
function formatLatency(ms: number, error?: string): string {
  if (error === 'Timeout') return 'timeout';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Format timestamp for display */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/** Escape HTML */
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Render the GitHub Actions badges panel */
function renderGitHubPanel(workflows: GitHubWorkflowConfig[], showBells: boolean): string {
  if (workflows.length === 0) return '';

  // Group by repo
  const byRepo = new Map<string, GitHubWorkflowConfig[]>();
  for (const w of workflows) {
    const key = `${w.owner}/${w.repo}`;
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key)!.push(w);
  }

  const rows = Array.from(byRepo.entries())
    .map(
      ([fullName, repoWorkflows]) => `
      <div class="gh-group">
        <div class="gh-repo-name"><a href="https://github.com/${escapeHtml(fullName)}" target="_blank" rel="noopener">${escapeHtml(fullName.split('/')[1])}</a></div>
        <div class="gh-badges">
          ${repoWorkflows
            .map(w => {
              const badgeUrl = `https://github.com/${w.owner}/${w.repo}/actions/workflows/${w.workflow}/badge.svg`;
              const linkUrl = `https://github.com/${w.owner}/${w.repo}/actions/workflows/${w.workflow}`;
              const notifyKey = `gh:${w.owner}/${w.repo}/${w.workflow}`;
              const notifyLabel = `${w.repo} / ${w.displayName ?? w.workflow}`;
              const bellHtml = showBells
                ? `<button class="bell-btn gh-badge-bell" data-notify-key="${escapeHtml(notifyKey)}" data-notify-label="${escapeHtml(notifyLabel)}" title="Notification settings for ${escapeHtml(notifyLabel)}" aria-label="Notification settings for ${escapeHtml(notifyLabel)}">🔔</button>`
                : '';
              return `<div class="gh-badge-wrap">${bellHtml}<a class="gh-badge" href="${escapeHtml(linkUrl)}" target="_blank" rel="noopener" title="${escapeHtml(w.displayName ?? w.workflow)}"><img src="${escapeHtml(badgeUrl)}" alt="${escapeHtml(w.displayName ?? w.workflow)}" loading="lazy"></a></div>`;
            })
            .join('')}
        </div>
      </div>`,
    )
    .join('');

  return `
  <div class="gh-section">
    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">GitHub Actions</span>
        <span class="panel-count">${byRepo.size} repos</span>
      </div>
      <div class="gh-groups">
        ${rows}
      </div>
    </div>
  </div>`;
}

/** Render the dashboard */
export function renderDashboard(
  plan: PlanProfile,
  config: DashboardConfig,
  status: { panels: PanelStatus[]; lastUpdate: number | null },
  ddnsLog: DdnsLogEntry[] = [],
  vapidPublicKey?: string,
  uptime?: Record<string, UptimeByPeriod>,
  charts?: ChartData,
  cost?: CostPanelData,
  // Defaults to admin: callers that predate public mode keep the full view.
  access: DashboardAccess = { admin: true, loginAvailable: false },
): string {
  const panels = status?.panels ?? [];
  const lastUpdate = status?.lastUpdate;
  const allServices = panels.flatMap(p => p.services);
  const totalDown = allServices.filter(s => s.status === 'down' && s.knownStatus !== 'known-down').length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Uptime Monitor</title>
  <link rel="manifest" href="/manifest.json">
  <link rel="apple-touch-icon" href="/icon-180.png">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Uptime">
  <meta name="theme-color" content="#161b22">
  <script>
    // Set theme immediately to prevent flash
    (function() {
      const stored = localStorage.getItem('theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = stored || (prefersDark ? 'dark' : 'light');
      document.documentElement.setAttribute('data-theme', theme);
    })();
  </script>
  <style>
    :root {
      --bg-body: #0d1117;
      --bg-panel: #161b22;
      --bg-panel-header: #21262d;
      --bg-service: #0d1117;
      --bg-service-hover: #1c2128;
      --bg-button: #21262d;
      --bg-button-hover: #30363d;
      --border: #30363d;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --text-link: #58a6ff;
      --color-up: #3fb950;
      --color-down: #f85149;
      --color-warn: #d29922;
      --chart-line: #3fb950;
      --chart-3xx: #7ee787;
      --chart-4xx: #d29922;
      --chart-5xx: #f85149;
      --chart-area-start: rgba(63, 185, 80, 0.6);
      --chart-area-end: rgba(63, 185, 80, 0.1);
      --chart-no-data: rgba(139, 148, 158, 0.15);
      --chart-timeout: rgba(248, 81, 73, 0.18);
    }

    [data-theme="light"] {
      --bg-body: #f6f8fa;
      --bg-panel: #ffffff;
      --bg-panel-header: #f6f8fa;
      --bg-service: #ffffff;
      --bg-service-hover: #f6f8fa;
      --bg-button: #f6f8fa;
      --bg-button-hover: #e1e4e8;
      --border: #d0d7de;
      --text: #1f2328;
      --text-muted: #656d76;
      --text-link: #0969da;
      --color-up: #1a7f37;
      --color-down: #cf222e;
      --color-warn: #9a6700;
      --chart-line: #1a7f37;
      --chart-3xx: #4ac26b;
      --chart-4xx: #9a6700;
      --chart-5xx: #cf222e;
      --chart-area-start: rgba(26, 127, 55, 0.5);
      --chart-area-end: rgba(26, 127, 55, 0.05);
      --chart-no-data: rgba(101, 109, 118, 0.15);
      --chart-timeout: rgba(207, 34, 46, 0.15);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'SF Mono', 'Consolas', 'Monaco', monospace; background: var(--bg-body); color: var(--text); min-height: 100vh; padding: 1.5rem; transition: background-color 0.2s, color 0.2s; }

    .header { max-width: 1400px; margin: 0 auto 1.5rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; }
    .header h1 { font-size: 1rem; font-weight: 400; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .header-right { display: flex; align-items: center; gap: 0.75rem; }

    .pill { display: inline-flex; align-items: center; padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-size: 0.688rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.03em; }
    .pill-up { background: rgba(63, 185, 80, 0.15); color: var(--color-up); border: 1px solid rgba(63, 185, 80, 0.3); }
    .pill-down { background: rgba(248, 81, 73, 0.15); color: var(--color-down); border: 1px solid rgba(248, 81, 73, 0.3); }
    .pill-known-down { background: rgba(210, 153, 34, 0.15); color: var(--color-warn); border: 1px solid rgba(210, 153, 34, 0.3); }
    .pill-pending { background: rgba(139, 148, 158, 0.1); color: var(--text-muted); border: 1px solid rgba(139, 148, 158, 0.2); }
    .pill-large { font-size: 0.75rem; padding: 0.25rem 0.75rem; }
    .pill-clickable { cursor: pointer; transition: transform 0.1s, box-shadow 0.1s; }
    .pill-clickable:hover { transform: scale(1.02); }
    .pill-clickable.active { box-shadow: 0 0 0 2px var(--bg-body), 0 0 0 4px currentColor; }

    .btn { background: var(--bg-button); border: 1px solid var(--border); color: var(--text); padding: 0.25rem 0.75rem; border-radius: 0.25rem; cursor: pointer; font-family: inherit; font-size: 0.75rem; transition: background-color 0.15s; }
    .btn:hover { background: var(--bg-button-hover); }
    .btn-icon { padding: 0.25rem 0.5rem; font-size: 1rem; line-height: 1; }

    .dashboard { max-width: 1400px; margin: 0 auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 500px), 1fr)); gap: 1.5rem; }

    .panel { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 0.5rem; transition: background-color 0.2s, border-color 0.2s; }
    .panel-header { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); background: var(--bg-panel-header); border-radius: calc(0.5rem - 1px) calc(0.5rem - 1px) 0 0; transition: background-color 0.2s, border-color 0.2s; }
    .panel-title { font-size: 0.813rem; font-weight: 500; color: var(--text); }
    .panel-count { font-size: 0.75rem; color: var(--text-muted); }
    .panel-count .up { color: var(--color-up); }
    .panel-count .down { color: var(--color-down); }
    .panel-header a { color: var(--text-link); text-decoration: none; font-size: 0.75rem; }
    .panel-header a:hover { text-decoration: underline; }

    .services { padding: 0.25rem; }

    .service { padding: 0.75rem; padding-left: calc(0.75rem + 4px); border-radius: 0.375rem; margin-bottom: 0.5rem; background: var(--bg-service); border: 1px solid var(--border); transition: background-color 0.15s, max-height 0.3s ease, opacity 0.2s ease, padding 0.3s ease, margin 0.3s ease, border-width 0.3s ease; max-height: 200px; overflow-x: clip; position: relative; }
    .service::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; border-radius: 0.375rem 0 0 0.375rem; background: var(--label-stripe, transparent); }
    .service:last-child { margin-bottom: 0; }
    .service:hover { background: var(--bg-service-hover); }
    .service.collapsed { max-height: 0; opacity: 0; padding-top: 0; padding-bottom: 0; margin-bottom: 0; border-width: 0; overflow: hidden; }

    .service-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.75rem; }
    .service-top { display: flex; align-items: center; gap: 0.75rem; flex: 1 1 auto; min-width: 0; }
    .service-main { display: flex; align-items: center; gap: 0.5rem; flex: 1; min-width: 0; }
    .service-name { font-weight: 500; font-size: 0.875rem; white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .service-name a { color: var(--text-link); text-decoration: none; }
    .service-name a:hover { text-decoration: underline; }

    .service-location { cursor: help; line-height: 1; display: inline-flex; align-items: center; }
    .service-location svg { display: block; border-radius: 2px; box-shadow: 0 0 0 1px rgba(128,128,128,0.3); }

    .service-provider { display: inline-flex; align-items: center; text-decoration: none; color: var(--provider-color); opacity: 0.6; transition: opacity 0.15s; }
    .service-provider:hover { opacity: 1; }
    .service-provider svg { display: block; }

    .service-pills { display: flex; gap: 0.375rem; flex-shrink: 0; flex-wrap: wrap; align-items: center; }
    .pill-status { font-variant-numeric: tabular-nums; }

    .stat-value { font-size: 0.75rem; font-variant-numeric: tabular-nums; font-family: ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', 'Segoe UI Mono', 'Roboto Mono', Menlo, monospace; }
    .stat-value.fast { color: var(--color-up); }
    .stat-value.slow { color: var(--color-warn); }

    .chart-uptime { position: absolute; bottom: -16px; display: flex; align-items: center; gap: 3px; font-size: 0.625rem; font-variant-numeric: tabular-nums; font-family: ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', 'Segoe UI Mono', 'Roboto Mono', Menlo, monospace; pointer-events: none; white-space: nowrap; }
    .chart-uptime .arrow { color: var(--text-muted); opacity: 0.5; font-size: 0.625rem; }
    .chart-latency { position: absolute; bottom: -16px; right: 0; font-size: 0.625rem; font-variant-numeric: tabular-nums; font-family: ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', 'Segoe UI Mono', 'Roboto Mono', Menlo, monospace; pointer-events: none; white-space: nowrap; }

    .updated { font-size: 0.75rem; color: var(--text-muted); }

    .chart-container { margin-top: 0.5rem; height: 40px; margin-bottom: 18px; position: relative; cursor: pointer; }
    .chart { width: 100%; height: 100%; overflow: visible; }
    .chart-line { fill: none; stroke: var(--chart-line); stroke-width: 1.5; }
    .chart-area { fill: url(#chart-gradient); }
    .chart-no-data { fill: url(#no-data-pattern); }
    .no-data-stripe { stroke: var(--chart-no-data); stroke-width: 2; }
    .chart-timeout { fill: url(#timeout-pattern); }
    .timeout-stripe { stroke: var(--chart-timeout); stroke-width: 2; }
    .chart-midnight { stroke: var(--text-muted); stroke-width: 0.5; opacity: 0.3; }
    .chart-midnight.landmark { stroke-width: 1.5; opacity: 0.4; }
    .chart-midnight-label { fill: var(--text-muted); font-size: 8px; opacity: 0.5; user-select: none; }
    .chart-midnight-label.landmark { font-weight: bold; opacity: 0.65; font-size: 9px; }
    .chart-label { position: absolute; top: 0; right: 2px; font-size: 0.625rem; color: var(--text-muted); pointer-events: none; }
    .chart-tooltip { position: absolute; background: var(--bg-panel-header); border: 1px solid var(--border); border-radius: 0.25rem; padding: 0.25rem 0.5rem; font-size: 0.625rem; pointer-events: none; opacity: 0; transition: opacity 0.1s; white-space: nowrap; z-index: 10; }
    .chart-loading { color: var(--text-muted); font-size: 0.625rem; display: flex; align-items: center; height: 100%; }
    .chart-cursor { stroke: var(--text-muted); stroke-width: 1; stroke-dasharray: 2,2; opacity: 0; transition: opacity 0.1s; }
    .chart-highlight { fill: var(--chart-line); stroke: var(--bg-panel); stroke-width: 1.5; opacity: 0; transition: opacity 0.1s; }
    .chart-clear { position: absolute; top: 0; left: 2px; font-size: 0.625rem; color: var(--text-muted); cursor: pointer; opacity: 0; transition: opacity 0.15s; background: none; border: none; font-family: inherit; padding: 0 0.25rem; z-index: 5; }
    .chart-clear:hover { color: var(--color-down); opacity: 1; }
    .chart-container:hover .chart-clear { opacity: 0.7; }
    /* Public viewers can't delete history or open the errors page. */
    .viewer-public .chart-clear { display: none; }
    .viewer-public .chart-container { cursor: default; }

    .modal-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; z-index: 100; opacity: 0; pointer-events: none; transition: opacity 0.15s; }
    .modal-overlay.visible { opacity: 1; pointer-events: auto; }
    .modal { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1.5rem; max-width: 340px; width: 90%; }
    .modal-title { font-size: 0.875rem; font-weight: 500; margin-bottom: 0.75rem; }
    .modal-text { font-size: 0.813rem; color: var(--text-muted); margin-bottom: 1.25rem; line-height: 1.5; }
    .modal-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
    .btn-danger { background: rgba(248, 81, 73, 0.15); border: 1px solid rgba(248, 81, 73, 0.3); color: var(--color-down); padding: 0.375rem 0.75rem; border-radius: 0.25rem; cursor: pointer; font-family: inherit; font-size: 0.75rem; font-weight: 500; }
    .btn-danger:hover { background: rgba(248, 81, 73, 0.25); }

    .notif-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; font-size: 0.813rem; }
    .notif-row label { color: var(--text); }
    .notif-row input[type="number"] { width: 4rem; padding: 0.25rem 0.5rem; background: var(--bg-body); border: 1px solid var(--border); border-radius: 0.25rem; color: var(--text); font-family: inherit; font-size: 0.813rem; text-align: right; }
    .notif-row input[type="number"]:focus { outline: none; border-color: var(--text-link); }
    .notif-select { padding: 0.25rem 0.5rem; background: var(--bg-body); border: 1px solid var(--border); border-radius: 0.25rem; color: var(--text); font-family: inherit; font-size: 0.813rem; }
    .notif-select:focus { outline: none; border-color: var(--text-link); }
    .notif-toggle { position: relative; width: 2.5rem; height: 1.25rem; }
    .notif-toggle input { opacity: 0; width: 0; height: 0; }
    .notif-toggle-track { position: absolute; inset: 0; background: var(--border); border-radius: 1rem; cursor: pointer; transition: background 0.2s; }
    .notif-toggle input:checked ~ .notif-toggle-track { background: var(--color-up); }
    .notif-toggle-track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 0.875rem; height: 0.875rem; background: #fff; border-radius: 50%; transition: transform 0.2s; }
    .notif-toggle input:checked ~ .notif-toggle-track::after { transform: translateX(1.25rem); }

    .online-indicator { font-size: 0.688rem; padding: 0.125rem 0.5rem; border-radius: 1rem; font-weight: 500; transition: all 0.3s; }
    .online-indicator.online { background: rgba(63, 185, 80, 0.15); color: var(--color-up); border: 1px solid rgba(63, 185, 80, 0.3); }
    .online-indicator.offline { background: rgba(248, 81, 73, 0.15); color: var(--color-down); border: 1px solid rgba(248, 81, 73, 0.3); }

    .bell-btn { background: none; border: none; cursor: pointer; padding: 0 0.25rem; font-size: 0.875rem; line-height: 1; opacity: 0.4; transition: opacity 0.15s; flex-shrink: 0; }
    .bell-btn:hover { opacity: 1; }
    .bell-btn.notif-on { opacity: 0.8; }
    .bell-btn.notif-off { opacity: 0.3; }
    @keyframes notif-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.9; } }
    .notif-saving { animation: notif-pulse 1s ease-in-out infinite; }
    .btn-icon.notif-saving { animation: notif-pulse 1s ease-in-out infinite; }

    .stat-value.good { color: var(--color-up); }
    .stat-value.warn { color: var(--color-warn); }
    .stat-value.bad { color: var(--color-down); }

    [data-tip] { position: relative; }
    [data-tip]::after {
      content: attr(data-tip);
      position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
      background: var(--bg-panel-header); color: var(--text); border: 1px solid var(--border);
      border-radius: 0.25rem; padding: 0.25rem 0.5rem; font-size: 0.625rem; font-weight: 400;
      white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity 0.15s;
      z-index: 20; text-transform: none; letter-spacing: normal;
    }
    [data-tip]:hover::after { opacity: 1; }

    .ddns-section { max-width: 1400px; margin: 1.5rem auto 0; }
    .ddns-events { padding: 0.5rem; }
    .ddns-event { display: flex; align-items: center; gap: 1rem; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); font-size: 0.813rem; }
    .ddns-event:last-child { border-bottom: none; }
    .ddns-event-time { flex-shrink: 0; min-width: 4.5rem; color: var(--text-muted); font-size: 0.75rem; cursor: help; }
    .ddns-event-type { flex-shrink: 0; min-width: 5.5rem; }
    .ddns-event-host { flex-shrink: 0; font-weight: 500; color: var(--text-link); min-width: 12rem; }
    .ddns-event-change { display: flex; align-items: center; gap: 0.5rem; font-family: ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', monospace; font-size: 0.75rem; flex: 1; }
    .ddns-ip.old { color: var(--text-muted); text-decoration: line-through; opacity: 0.7; }
    .ddns-arrow { color: var(--text-muted); }
    .ddns-ip.new { color: var(--color-up); font-weight: 500; }
    .ddns-message { color: var(--text-muted); font-size: 0.75rem; flex: 1; }
    .ddns-source { color: var(--text-muted); font-size: 0.688rem; font-family: ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', monospace; flex-shrink: 0; }
    .pill-no-change { background: rgba(139, 148, 158, 0.1); color: var(--text-muted); border: 1px solid rgba(139, 148, 158, 0.2); }
    .pill-ip-change { background: rgba(63, 185, 80, 0.15); color: var(--color-up); border: 1px solid rgba(63, 185, 80, 0.3); }
    .pill-rejected { background: rgba(248, 81, 73, 0.15); color: var(--color-down); border: 1px solid rgba(248, 81, 73, 0.3); }
    .pill-not-found { background: rgba(210, 153, 34, 0.15); color: var(--color-warn); border: 1px solid rgba(210, 153, 34, 0.3); }
    .pill-error { background: rgba(248, 81, 73, 0.15); color: var(--color-down); border: 1px solid rgba(248, 81, 73, 0.3); }

    .gh-section { max-width: 1400px; margin: 1.5rem auto 0; }
    .gh-groups { padding: 0.5rem; }
    .gh-group { display: flex; flex-direction: column; gap: 0.375rem; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); }
    .gh-group:last-child { border-bottom: none; }
    .gh-repo-name { font-size: 0.813rem; font-weight: 500; }
    .gh-repo-name a { color: var(--text-link); text-decoration: none; }
    .gh-repo-name a:hover { text-decoration: underline; }
    .gh-badges { display: flex; flex-direction: column; gap: 0.375rem; }
    .gh-badge { display: inline-block; line-height: 0; }
    .gh-badge img { height: 20px; display: block; }
    .gh-badge-wrap { display: flex; align-items: center; gap: 0.25rem; }
    .gh-badge-bell { font-size: 0.688rem; }

    /* Event timeline (correlation swimlanes) */
    /* 1.5rem top matches .ddns-section/.gh-section and the .dashboard grid gap,
       so this sits the same distance below whatever precedes it. Without it the
       timeline butts straight against the grid, which has no bottom margin. */
    .timeline-section { max-width: 1400px; margin: 1.5rem auto 1rem; }
    .timeline { padding: 0.5rem 0.25rem 0.25rem; overflow: hidden; }
    .timeline svg { display: block; width: 100%; }
    .timeline .chart-loading { padding: 1rem; text-align: center; color: var(--text-muted); font-size: 0.75rem; }
    .tl-label { font-size: 0.7rem; fill: var(--text); }
    .tl-label a { cursor: pointer; }
    .tl-group { font-size: 0.625rem; fill: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
    .tl-seg-up { fill: var(--color-up); opacity: 0.32; }
    .tl-seg-down { fill: var(--color-down); opacity: 0.95; }
    .tl-rowline { stroke: var(--border); stroke-width: 1; opacity: 0.4; }
    .tl-cursor { stroke: var(--text-muted); stroke-width: 1; stroke-dasharray: 2 2; pointer-events: none; opacity: 0; }
    .tl-cursor-time { font-size: 0.625rem; fill: var(--text-muted); pointer-events: none; opacity: 0; }

    /* Label filter bar */
    .label-bar { max-width: 1400px; margin: 0 auto 1rem; display: flex; flex-wrap: wrap; gap: 0.375rem; align-items: center; }
    .label-filter { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.2rem 0.5rem; border-radius: 1rem; font-size: 0.688rem; font-weight: 500; cursor: pointer; border: 1px solid var(--border); background: transparent; color: var(--text-muted); transition: all 0.15s; font-family: inherit; }
    .label-filter:hover { border-color: var(--text); color: var(--text); }
    .label-filter.active { border-color: var(--label-color); color: var(--label-color); background: color-mix(in srgb, var(--label-color) 12%, transparent); }
    .label-filter .label-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--label-color); flex-shrink: 0; }


    @media (max-width: 768px) {
      body { padding: 1rem; }
      .header { flex-direction: column; align-items: stretch; gap: 0.75rem; }
      .header-right { justify-content: space-between; flex-wrap: wrap; }
      .ddns-event { flex-wrap: wrap; gap: 0.5rem; }
      .ddns-event-time { min-width: auto; }
      .ddns-event-type { min-width: auto; }
      .ddns-event-host { min-width: auto; }
      .gh-group { flex-direction: column; align-items: stretch; gap: 0.5rem; }
      .gh-repo-name { min-width: auto; margin-bottom: 0.25rem; }
    }
    ${COST_PANEL_CSS}
  </style>
</head>
<body${access.admin ? '' : ' class="viewer-public"'}>
  <div class="header">
    <h1>Uptime Monitor</h1>
    <div class="header-right">
      <span class="pill pill-large pill-clickable ${totalDown === 0 ? 'pill-up' : 'pill-down'}" id="status-filter" title="Click to filter">${totalDown === 0 ? 'All Systems Operational' : `${totalDown} Issue${totalDown > 1 ? 's' : ''}`}</span>
      ${
        access.admin
          ? `<a href="/errors" class="btn" title="View recent check errors">Errors</a>
      <a href="/ddns" class="btn" title="View DDNS log">DDNS</a>`
          : ''
      }
      ${!access.admin && access.loginAvailable ? `<a href="/login" class="btn" title="Log in as an admin">Admin</a>` : ''}
      ${access.admin && access.loginAvailable ? `<a href="/logout" class="btn" title="Log out">Log out</a>` : ''}
      ${lastUpdate ? `<span class="updated">${formatTime(lastUpdate)}</span>` : ''}
      <span class="online-indicator online" id="online-indicator">online</span>
      ${vapidPublicKey ? `<button class="btn btn-icon" id="notif-btn" title="Enable push notifications" aria-label="Toggle notifications">🔕</button>` : ''}
      <button class="btn btn-icon" id="theme-toggle" title="Toggle theme">
        <span class="theme-icon"></span>
      </button>
    </div>
  </div>
  ${(() => {
    const labelDefs = config.labels ?? [];
    const usedLabels = new Set(panels.flatMap(p => p.services.flatMap(s => s.labels ?? [])));
    const activeLabelDefs = labelDefs.filter(l => usedLabels.has(l.id));
    if (activeLabelDefs.length === 0) return '';
    return `
  <div class="label-bar" id="label-bar">
    <button class="label-filter active" data-label="all" style="--label-color: var(--text-muted)"><span class="label-dot"></span> All</button>
    ${activeLabelDefs.map(l => `<button class="label-filter" data-label="${escapeHtml(l.id)}" style="--label-color: ${l.color}"><span class="label-dot"></span> ${escapeHtml(l.name)}</button>`).join('')}
  </div>`;
  })()}
  <div class="dashboard">
    ${(() => {
      const labelMap = new Map((config.labels ?? []).map(l => [l.id, l]));
      return panels
        .map(panel => {
          const upCount = panel.services.filter(s => s.status === 'up').length;
          const downCount = panel.services.length - upCount;
          return `
        <div class="panel" data-panel>
          <div class="panel-header">
            <span class="panel-title">${escapeHtml(panel.panel)}</span>
            <span class="panel-count"><span class="up">${upCount}</span>${downCount > 0 ? ` / <span class="down">${downCount}</span>` : ''} services</span>
          </div>
          <div class="services">
            ${panel.services.map(s => renderService(config, s, !!vapidPublicKey, uptime, labelMap)).join('')}
          </div>
        </div>
      `;
        })
        .join('');
    })()}
    ${cost ? renderCostPanelHtml(cost) : ''}
  </div>

  ${
    ddnsLog.length > 0
      ? `
  <div class="ddns-section">
    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">${vapidPublicKey ? `<button class="bell-btn" data-notify-key="ddns" data-notify-label="DDNS Failures" title="Notification settings for DDNS failures" aria-label="Notification settings for DDNS failures">🔔</button> ` : ''}DDNS Activity</span>
        <span class="panel-count">${ddnsLog.length} recent</span>
        <a href="/ddns">View all</a>
      </div>
      <div class="ddns-events" id="ddns-events">
        ${ddnsLog.map(renderDdnsEvent).join('')}
      </div>
    </div>
  </div>
  `
      : ''
  }

  ${renderGitHubPanel(config.githubWorkflows ?? [], !!vapidPublicKey)}

  <div class="timeline-section">
    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">Event Timeline</span>
        <span class="panel-count">state changes · 30d</span>
      </div>
      <div class="timeline" id="timeline">
        <div class="chart-loading">No timeline data yet</div>
      </div>
    </div>
  </div>

  <svg style="position:absolute;width:0;height:0">
    <defs>
      <linearGradient id="chart-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" class="chart-gradient-start" />
        <stop offset="100%" class="chart-gradient-end" />
      </linearGradient>
      <pattern id="no-data-pattern" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" class="no-data-stripe" />
      </pattern>
      <pattern id="timeout-pattern" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(-45)">
        <line x1="0" y1="0" x2="0" y2="6" class="timeout-stripe" />
      </pattern>
    </defs>
  </svg>

  <div class="modal-overlay" id="confirm-modal">
    <div class="modal">
      <div class="modal-title">Clear History</div>
      <div class="modal-text" id="confirm-modal-text"></div>
      <div class="modal-actions">
        <button class="btn" id="confirm-cancel">Cancel</button>
        <button class="btn-danger" id="confirm-ok">Clear</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="notif-settings-modal">
    <div class="modal">
      <div class="modal-title" id="notif-settings-title">🔔 Notification Settings</div>
      <div class="notif-row">
        <label for="notif-enabled">Enabled</label>
        <label class="notif-toggle">
          <input type="checkbox" id="notif-enabled">
          <span class="notif-toggle-track"></span>
        </label>
      </div>
      <div class="notif-row">
        <label for="notif-threshold">Failures before notifying</label>
        <input type="number" id="notif-threshold" min="1" max="99" value="1">
      </div>
      <div class="notif-row">
        <label for="notif-recovery">Notify on recovery</label>
        <label class="notif-toggle">
          <input type="checkbox" id="notif-recovery">
          <span class="notif-toggle-track"></span>
        </label>
      </div>
      <div class="notif-row" id="notif-urgency-row">
        <label for="notif-urgency">Urgency</label>
        <select id="notif-urgency" class="notif-select">
          <option value="">Default</option>
          <option value="very-low">Very Low</option>
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn" id="notif-cancel">Cancel</button>
        <button class="btn" id="notif-save" style="background:var(--color-up);color:#fff;border-color:var(--color-up)">Save</button>
      </div>
    </div>
  </div>

  <script>
    const IS_ADMIN = ${access.admin ? 'true' : 'false'};

    // Theme toggle
    const themeToggle = document.getElementById('theme-toggle');
    const themeIcon = themeToggle.querySelector('.theme-icon');

    function updateThemeIcon() {
      const theme = document.documentElement.getAttribute('data-theme');
      themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
    }

    function updateChartGradient() {
      const style = getComputedStyle(document.documentElement);
      const startColor = style.getPropertyValue('--chart-area-start').trim();
      const endColor = style.getPropertyValue('--chart-area-end').trim();
      document.querySelector('.chart-gradient-start')?.setAttribute('style', 'stop-color:' + startColor);
      document.querySelector('.chart-gradient-end')?.setAttribute('style', 'stop-color:' + endColor);
    }

    themeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      updateThemeIcon();
      updateChartGradient();
    });

    updateThemeIcon();
    updateChartGradient();

    // Online/offline indicator
    (function () {
      const indicator = document.getElementById('online-indicator');
      if (!indicator) return;
      function update() {
        if (navigator.onLine) {
          indicator.textContent = 'online';
          indicator.className = 'online-indicator online';
        } else {
          indicator.textContent = 'offline';
          indicator.className = 'online-indicator offline';
        }
      }
      window.addEventListener('online', update);
      window.addEventListener('offline', update);
      update();
    })();

    // Chart state
    const chartMeta = new Map();
    let globalMinTime = 0;
    let globalMaxTime = 0;
    let globalTimeRange = 1;
    const CHART_EXPONENT = 0.35;
    let chartAnimFrameId = 0;

    // Build SVG path d-strings from a segment's point data and a given xScale
    function buildSegmentPaths(points, xs, ys, btm) {
      let linePath = '';
      let areaPath = '';
      for (let i = 0; i < points.length; i++) {
        const x = xs(points[i].timestamp);
        const y = ys(points[i].latency);
        if (i === 0) {
          linePath = 'M ' + x + ' ' + y;
          areaPath = 'M ' + x + ' ' + btm + ' L ' + x + ' ' + y;
        } else {
          linePath += ' L ' + x + ' ' + y;
          areaPath += ' L ' + x + ' ' + y;
        }
      }
      const lastX = xs(points[points.length - 1].timestamp);
      areaPath += ' L ' + lastX + ' ' + btm + ' Z';
      return { linePath, areaPath };
    }

    // Chart data may arrive via streaming (appended as a <script> after initial HTML)
    const inlineCharts = ${charts ? JSON.stringify(charts) : 'null'};

    // Helper functions
    const formatLatency = (ms, error) => error === 'Timeout' ? 'timeout' : (ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(2) + 's');
    const formatUptime = (val) => val === null ? '-' : val.toFixed(2) + '%';
    const uptimeClass = (val) => {
      if (val === null) return '';
      if (val >= 99.9) return 'good';
      if (val >= 99) return 'warn';
      return 'bad';
    };
    const latencyClass = (ms, error) => error === 'Timeout' ? 'slow' : (ms < 200 ? 'fast' : (ms > 1000 ? 'slow' : ''));

    // Unpack compact array point [ts, lat, up, code?, error?] into named object
    function unpackPoint(p) {
      return { timestamp: p[0], latency: p[1], status: p[2] ? 'up' : 'down', code: p[3] || 0, error: p[4] || null };
    }

    function renderCharts(charts) {
      if (!charts) return;
      const renderTime = Date.now();
      const prevMaxTime = globalMaxTime;

      // Cancel any running chart animation
      if (chartAnimFrameId) {
        cancelAnimationFrame(chartAnimFrameId);
        chartAnimFrameId = 0;
      }
      // Set globalMaxTime to the latest data point across all services
      // so the most recent point sits at the right edge of the chart
      let maxTs = 0;
      for (const key in charts) {
        const raw = charts[key];
        if (raw && raw.length > 0) {
          const lastTs = raw[raw.length - 1][0];
          if (lastTs > maxTs) maxTs = lastTs;
        }
      }
      globalMaxTime = maxTs || renderTime;
      globalMinTime = globalMaxTime - 30 * 24 * 60 * 60 * 1000;
      globalTimeRange = 30 * 24 * 60 * 60 * 1000;

      const animationTargets = [];
      const shouldAnimate = prevMaxTime > 0 && prevMaxTime !== globalMaxTime;

      document.querySelectorAll('.chart-container').forEach(container => {
        const service = container.dataset.service;
        const raw = charts[service];

        if (!raw || raw.length < 2) {
          container.innerHTML = '<div class="chart-loading">No history yet</div>';
          chartMeta.delete(container);
          return;
        }

        const sampled = raw.map(unpackPoint);

        const width = container.clientWidth;
        const height = 40;
        const padding = { top: 4, right: 4, bottom: 4, left: 4 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;

        const latencies = sampled.map(p => p.latency);
        const minLat = Math.min(...latencies);
        const maxLat = Math.max(...latencies);
        const logMin = Math.log(Math.max(minLat, 1));
        const logMax = Math.log(Math.max(maxLat, 1));
        const logRange = logMax - logMin || 1;

        const makeXScale = (maxTime) => (ts) => {
          const age = Math.max(maxTime - ts, 0);
          return padding.left + (1 - Math.pow(age / globalTimeRange, CHART_EXPONENT)) * chartWidth;
        };
        const xScale = makeXScale(globalMaxTime);
        const yScale = (lat) => padding.top + chartHeight - ((Math.log(Math.max(lat, 1)) - logMin) / logRange) * chartHeight;

        const gaps = [];
        const timeouts = [];
        const bottom = height - padding.bottom;

        // Color by status and HTTP response code
        const pointColor = (p) => {
          if (p.status === 'up') return 'var(--chart-line)';
          if (!p.code || p.code < 300) return 'var(--chart-line)';
          if (p.code < 400) return 'var(--chart-3xx)';
          if (p.code < 500) return 'var(--chart-4xx)';
          return 'var(--chart-5xx)';
        };

        // Build color-segmented data (one segment per continuous run of same color)
        // Stores point arrays for animation re-rendering with different xScales
        const colorSegments = [];
        let curSeg = null;

        // Expected data interval by age tier, derived from this deployment's
        // actual cron cadence and storage tier rather than assumed. A gap is
        // declared at 3x this and ends the line segment, so a hardcoded 1-minute
        // assumption breaks the line on every cron slower than 3 minutes.
        const CHART_INTERVALS = ${JSON.stringify(chartIntervals(plan))};
        const expectedInterval = (ts) => {
          const age = globalMaxTime - ts;
          for (const tier of CHART_INTERVALS.tiers) if (age < tier[0]) return tier[1];
          return CHART_INTERVALS.fallback;
        };

        sampled.forEach((p, i) => {
          const isTimeout = p.error === 'Timeout';
          const isGap = i > 0 && (p.timestamp - sampled[i - 1].timestamp) > expectedInterval(p.timestamp) * 3;
          const prev = i > 0 ? sampled[i - 1] : null;
          const prevWasTimeout = prev && prev.error === 'Timeout';

          if (isTimeout) {
            if (curSeg) curSeg = null;
            const regionStartTs = prev && !isGap ? prev.timestamp : p.timestamp;
            timeouts.push({ ts1: regionStartTs, ts2: p.timestamp });
            return;
          }

          const color = pointColor(p);

          if (i === 0 || isGap || prevWasTimeout) {
            if (curSeg && isGap) {
              gaps.push({ ts1: prev.timestamp, ts2: p.timestamp });
            }
            curSeg = { color, points: [p] };
            colorSegments.push(curSeg);
          } else if (color !== curSeg.color) {
            // Color change: start new segment from prev point for continuity
            curSeg = { color, points: [prev, p] };
            colorSegments.push(curSeg);
          } else {
            curSeg.points.push(p);
          }
        });

        // Build content group with all visual chart elements
        const contentGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        contentGroup.setAttribute('class', 'chart-content');

        // Midnight markers (rendered first so they appear behind data)
        {
          const midnight = new Date(globalMaxTime);
          midnight.setHours(0, 0, 0, 0);
          let prevLabelX = Infinity;
          for (let day = 0; day <= 31; day++) {
            const ts = midnight.getTime();
            if (ts < globalMinTime - 24 * 60 * 60 * 1000) break;
            const mx = xScale(ts);
            if (mx < padding.left - 1 || mx > width - padding.right) { midnight.setDate(midnight.getDate() - 1); continue; }

            const isLandmark = day === 1 || day === 7 || day === 30;
            const mline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            mline.setAttribute('class', 'chart-midnight' + (isLandmark ? ' landmark' : ''));
            mline.setAttribute('x1', String(mx));
            mline.setAttribute('x2', String(mx));
            mline.setAttribute('y1', String(padding.top));
            mline.setAttribute('y2', String(isLandmark ? height + 4 : height - padding.bottom));
            contentGroup.appendChild(mline);

            // Labels: only landmarks (1d, 7d) and the month boundary
            const prevDay = new Date(midnight);
            prevDay.setDate(prevDay.getDate() - 1);
            const isMonthBoundary = midnight.getMonth() !== prevDay.getMonth();
            if (isLandmark || isMonthBoundary) {
              const mlabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
              mlabel.setAttribute('class', 'chart-midnight-label' + (isLandmark ? ' landmark' : ''));
              mlabel.setAttribute('x', String(mx + 2));
              mlabel.setAttribute('y', String(padding.top + 7));
              mlabel.textContent = isLandmark
                ? (day === 1 ? '1d' : day === 7 ? '7d' : '30d')
                : midnight.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
              contentGroup.appendChild(mlabel);
            }
            midnight.setDate(midnight.getDate() - 1);
          }
        }

        const firstDataX = xScale(sampled[0].timestamp);
        if (firstDataX > padding.left + 2) {
          const noDataRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          noDataRect.setAttribute('class', 'chart-no-data');
          noDataRect.setAttribute('x', String(padding.left));
          noDataRect.setAttribute('y', String(padding.top));
          noDataRect.setAttribute('width', String(firstDataX - padding.left));
          noDataRect.setAttribute('height', String(chartHeight));
          contentGroup.appendChild(noDataRect);
        }

        gaps.forEach(gap => {
          const x1 = xScale(gap.ts1);
          const x2 = xScale(gap.ts2);
          const noDataRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          noDataRect.setAttribute('class', 'chart-no-data');
          noDataRect.setAttribute('x', String(x1));
          noDataRect.setAttribute('y', String(padding.top));
          noDataRect.setAttribute('width', String(x2 - x1));
          noDataRect.setAttribute('height', String(chartHeight));
          contentGroup.appendChild(noDataRect);
        });

        // Merge adjacent timeout regions and render
        const mergedTimeouts = [];
        for (const t of timeouts) {
          const last = mergedTimeouts[mergedTimeouts.length - 1];
          if (last && t.ts1 <= last.ts2) {
            last.ts2 = Math.max(last.ts2, t.ts2);
          } else {
            mergedTimeouts.push({ ts1: t.ts1, ts2: t.ts2 });
          }
        }
        mergedTimeouts.forEach(t => {
          const x1 = xScale(t.ts1);
          const x2 = xScale(t.ts2);
          const w = Math.max(x2 - x1, 4);
          const toRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          toRect.setAttribute('class', 'chart-timeout');
          toRect.setAttribute('x', String(x1));
          toRect.setAttribute('y', String(padding.top));
          toRect.setAttribute('width', String(w));
          toRect.setAttribute('height', String(chartHeight));
          contentGroup.appendChild(toRect);
        });

        // Render color-segmented areas (behind) then lines (on top)
        // Store element references on segments for animation
        colorSegments.forEach(seg => {
          const { areaPath } = buildSegmentPaths(seg.points, xScale, yScale, bottom);
          const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          area.setAttribute('d', areaPath);
          area.setAttribute('fill', seg.color);
          area.setAttribute('fill-opacity', '0.2');
          contentGroup.appendChild(area);
          seg.areaEl = area;
        });
        colorSegments.forEach(seg => {
          const { linePath } = buildSegmentPaths(seg.points, xScale, yScale, bottom);
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          line.setAttribute('d', linePath);
          line.setAttribute('fill', 'none');
          line.setAttribute('stroke', seg.color);
          line.setAttribute('stroke-width', '1.5');
          contentGroup.appendChild(line);
          seg.lineEl = line;
        });

        const existing = chartMeta.get(container);

        if (existing && existing.svg.parentNode === container) {
          // --- Animated update: replace content, animate data points via rAF ---
          const svg = existing.svg;
          svg.setAttribute('viewBox', \`0 0 \${width} \${height}\`);

          const oldContent = svg.querySelector('.chart-content');
          if (oldContent) oldContent.remove();
          svg.insertBefore(contentGroup, existing.cursor);

          // Update max label
          const maxLabel = container.querySelector('.chart-label');
          if (maxLabel) maxLabel.textContent = maxLat < 1000 ? Math.round(maxLat) + 'ms' : (maxLat / 1000).toFixed(1) + 's';

          chartMeta.set(container, { svg, cursor: existing.cursor, highlight: existing.highlight, tooltip: existing.tooltip, sampled, width, padding, chartWidth, xScale, yScale, renderTime });

          if (shouldAnimate) {
            animationTargets.push({ colorSegments, makeXScale, yScale, bottom, container, width });
          }
        } else {
          // --- First render: create everything from scratch ---
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('class', 'chart');
          svg.setAttribute('viewBox', \`0 0 \${width} \${height}\`);
          svg.setAttribute('preserveAspectRatio', 'none');

          svg.appendChild(contentGroup);

          const cursor = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          cursor.setAttribute('class', 'chart-cursor');
          cursor.setAttribute('y1', String(padding.top));
          cursor.setAttribute('y2', String(height - padding.bottom));
          svg.appendChild(cursor);

          const highlight = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          highlight.setAttribute('class', 'chart-highlight');
          highlight.setAttribute('r', '3');
          svg.appendChild(highlight);

          container.innerHTML = '';
          container.appendChild(svg);

          const maxLabel = document.createElement('div');
          maxLabel.className = 'chart-label';
          maxLabel.textContent = maxLat < 1000 ? Math.round(maxLat) + 'ms' : (maxLat / 1000).toFixed(1) + 's';
          container.appendChild(maxLabel);

          const tooltip = document.createElement('div');
          tooltip.className = 'chart-tooltip';
          container.appendChild(tooltip);

          chartMeta.set(container, { svg, cursor, highlight, tooltip, sampled, width, padding, chartWidth, xScale, yScale, renderTime });
        }

        // Position uptime stats below chart at landmark positions
        renderChartUptime(container, xScale, width);
      });

      // Animate data points sliding from old to new positions
      if (animationTargets.length > 0) {
        // Set all paths to their old-xScale positions initially
        animationTargets.forEach(t => {
          const oldXS = t.makeXScale(prevMaxTime);
          t.colorSegments.forEach(seg => {
            const { linePath, areaPath } = buildSegmentPaths(seg.points, oldXS, t.yScale, t.bottom);
            seg.areaEl.setAttribute('d', areaPath);
            seg.lineEl.setAttribute('d', linePath);
          });
        });

        const animStart = performance.now();
        const animDuration = 600;
        const tick = (now) => {
          const elapsed = Math.min((now - animStart) / animDuration, 1);
          const ease = 1 - Math.pow(1 - elapsed, 3); // ease-out cubic
          const interpMaxTime = prevMaxTime + (globalMaxTime - prevMaxTime) * ease;

          animationTargets.forEach(t => {
            const xs = t.makeXScale(interpMaxTime);
            t.colorSegments.forEach(seg => {
              const { linePath, areaPath } = buildSegmentPaths(seg.points, xs, t.yScale, t.bottom);
              seg.areaEl.setAttribute('d', areaPath);
              seg.lineEl.setAttribute('d', linePath);
            });
            // Update chartMeta.xScale so hover works during animation
            const meta = chartMeta.get(t.container);
            if (meta) meta.xScale = xs;
          });

          if (elapsed < 1) {
            chartAnimFrameId = requestAnimationFrame(tick);
          } else {
            chartAnimFrameId = 0;
          }
        };
        chartAnimFrameId = requestAnimationFrame(tick);
      }
    }

    function renderChartUptime(container, xScale, viewBoxWidth) {
      // Remove old uptime/latency elements
      container.querySelectorAll('.chart-uptime, .chart-latency').forEach(el => el.remove());

      // Compute landmark midnight positions to align with the midnight marker lines
      const todayMidnight = new Date(globalMaxTime);
      todayMidnight.setHours(0, 0, 0, 0);
      const d1 = new Date(todayMidnight); d1.setDate(d1.getDate() - 1);
      const d7 = new Date(todayMidnight); d7.setDate(d7.getDate() - 7);
      const d30 = new Date(todayMidnight); d30.setDate(d30.getDate() - 30);

      const periods = [
        { key: '30d', ts: d30.getTime() },
        { key: '7d', ts: d7.getTime() },
        { key: '24h', ts: d1.getTime() },
      ];

      periods.forEach(({ key, ts }) => {
        const val = container.getAttribute('data-uptime-' + key);
        const cls = container.getAttribute('data-uptime-' + key + '-class') || '';
        if (!val) return;

        const x = xScale(ts);
        const el = document.createElement('div');
        el.className = 'chart-uptime uptime-' + key;
        el.style.left = (x / viewBoxWidth * 100) + '%';
        el.innerHTML = '<span class="stat-value ' + cls + '">' + val + '</span><span class="arrow">\u2192 now</span>';
        container.appendChild(el);
      });

      // Latency — right-aligned
      const latVal = container.getAttribute('data-latency');
      if (latVal) {
        const latCls = container.getAttribute('data-latency-class') || '';
        const el = document.createElement('div');
        el.className = 'chart-latency';
        el.innerHTML = '<span class="stat-value ' + latCls + '">' + latVal + '</span>';
        container.appendChild(el);
      }
    }

    // Poll for updates. Lightweight polls fetch status + ddns only (~50KB).
    // Full polls also include uptime + log-decimated charts (30d) and run every 5 minutes.
    let lastFullPoll = inlineCharts ? Date.now() : 0;
    // How often a poll also refreshes charts. On free this is the dominant
    // read cost — a full poll is the ~6,000-row dashboard query, a light one
    // is a single blob row — so it comes from the plan profile.
    const FULL_POLL_INTERVAL = ${plan.clientFullPollMs};

    function poll() {
      const needsFull = Date.now() - lastFullPoll >= FULL_POLL_INTERVAL;
      const url = needsFull ? '/api/poll?full=true' : '/api/poll';
      return fetch(url)
        .then(r => r.json())
        .then(data => {
          if (!data.panels) return false;

          // --- Update status ---
          const allServices = data.panels.flatMap(p => p.services);
          const totalDown = allServices.filter(s => s.status === 'down' && s.knownStatus !== 'known-down').length;
          const headerPill = document.querySelector('.header .pill-large');
          if (headerPill) {
            headerPill.className = 'pill pill-large pill-clickable ' + (showOnlyDown ? 'active ' : '') + (totalDown === 0 ? 'pill-up' : 'pill-down');
            headerPill.textContent = totalDown === 0 ? 'All Systems Operational' : \`\${totalDown} Issue\${totalDown > 1 ? 's' : ''}\`;
          }

          const updated = document.querySelector('.header .updated');
          if (updated && data.lastUpdate) {
            updated.textContent = new Date(data.lastUpdate).toLocaleTimeString();
          }

          data.panels.forEach(panel => {
            panel.services.forEach(s => {
              const key = s.host || s.name;
              const chartContainer = document.querySelector(\`.chart-container[data-service="\${key}"]\`);
              if (!chartContainer) return;

              const serviceEl = chartContainer.closest('.service');
              if (!serviceEl) return;

              const mainStatus = s.status === 'up' ? 'up' : (s.knownStatus === 'known-down' ? 'known-down' : 'down');
              serviceEl.dataset.status = mainStatus;

              // Pills
              const pillsContainer = serviceEl.querySelector('.service-pills');
              if (pillsContainer) {
                const httpsChecks = s.checks.filter(c => c.type === 'https');
                const uniqueHosts = [...new Set(httpsChecks.map(c => { try { return new URL(c.url).hostname; } catch { return c.url; } }))];
                let pillsHtml = '';

                if (uniqueHosts.length <= 1) {
                  // Single host: show type label (HTTPS/HTTP)
                  const primaryCheck = httpsChecks[0] || s.checks[0];
                  if (primaryCheck) {
                    const tip = primaryCheck.type.toUpperCase() + ' endpoint is ' + (primaryCheck.status === 'up' ? 'reachable' : 'unreachable');
                    pillsHtml += \`<span class="pill pill-\${mainStatus}" data-tip="\${tip}">\${primaryCheck.type.toUpperCase()}</span>\`;
                  }
                } else {
                  // Multiple hosts: show pill per host
                  for (const host of uniqueHosts) {
                    const hostChecks = httpsChecks.filter(c => { try { return new URL(c.url).hostname === host; } catch { return false; } });
                    const allUp = hostChecks.every(c => c.status === 'up');
                    const knownDown = s.knownStatus === 'known-down';
                    const status = knownDown ? 'known-down' : (allUp ? 'up' : 'down');
                    const tip = host + ' is ' + (allUp ? 'reachable' : 'unreachable');
                    pillsHtml += \`<span class="pill pill-\${status}" data-tip="\${tip}">\${host}</span>\`;
                  }
                }

                const httpCheck = s.checks.find(c => c.type === 'http');
                if (httpCheck) {
                  const tip = httpCheck.status === 'up' ? 'HTTP correctly redirects to HTTPS' : 'HTTP is not redirecting to HTTPS';
                  pillsHtml += \`<span class="pill pill-\${httpCheck.status === 'up' ? 'up' : 'down'}" data-tip="\${tip}">HTTP\u2192HTTPS</span>\`;
                }
                if (s.wwwCheck) {
                  const tip = s.wwwCheck.status === 'up' ? 'www subdomain correctly redirects to apex' : 'www subdomain is not redirecting to apex';
                  pillsHtml += \`<span class="pill pill-\${s.wwwCheck.status === 'up' ? 'up' : 'down'}" data-tip="\${tip}">WWW</span>\`;
                }

                // Status code pill
                const pCheck = httpsChecks[0] || s.checks[0];
                pillsHtml += \`<span class="pill pill-status pill-\${mainStatus}" data-tip="HTTP status code">\${pCheck?.code || '-'}</span>\`;

                pillsContainer.innerHTML = pillsHtml;
              }

              // Latency — update data attrs on chart-container
              const primaryCheck = s.checks.find(c => c.type === 'https') || s.checks[0];
              if (primaryCheck) {
                chartContainer.setAttribute('data-latency', formatLatency(primaryCheck.latency, primaryCheck.error));
                chartContainer.setAttribute('data-latency-class', latencyClass(primaryCheck.latency, primaryCheck.error));
              }

              // Uptime (only present on full polls) — update data attrs and re-render below chart
              if (data.uptime) {
                const uptimeStats = data.uptime[key];
                chartContainer.setAttribute('data-uptime-30d', formatUptime(uptimeStats?.uptime30d ?? null));
                chartContainer.setAttribute('data-uptime-30d-class', uptimeClass(uptimeStats?.uptime30d ?? null));
                chartContainer.setAttribute('data-uptime-7d', formatUptime(uptimeStats?.uptime7d ?? null));
                chartContainer.setAttribute('data-uptime-7d-class', uptimeClass(uptimeStats?.uptime7d ?? null));
                chartContainer.setAttribute('data-uptime-24h', formatUptime(uptimeStats?.uptime24h ?? null));
                chartContainer.setAttribute('data-uptime-24h-class', uptimeClass(uptimeStats?.uptime24h ?? null));
              }

              // Re-render uptime + latency below chart
              const meta = chartMeta.get(chartContainer);
              if (meta) renderChartUptime(chartContainer, meta.xScale, meta.width);
            });
          });

          // --- Update DDNS log ---
          if (data.ddnsLog) {
            const container = document.getElementById('ddns-events');
            if (container) {
              container.innerHTML = data.ddnsLog.map(e => {
                const time = new Date(e.timestamp);
                const diff = Date.now() - e.timestamp;
                const minutes = Math.floor(diff / 60000);
                let relative;
                if (minutes < 1) relative = 'just now';
                else if (minutes < 60) relative = minutes + 'm ago';
                else {
                  const hours = Math.floor(minutes / 60);
                  if (hours < 24) relative = hours + 'h ago';
                  else {
                    const days = Math.floor(hours / 24);
                    if (days < 30) relative = days + 'd ago';
                    else relative = time.toLocaleDateString();
                  }
                }
                const pillClass = 'pill pill-' + e.event.replace('_', '-');
                let changeContent = '';
                if (e.event === 'ip_change') {
                  changeContent = '<span class="ddns-ip old">' + (e.old_ip ?? '') + '</span>' +
                    '<span class="ddns-arrow">&rarr;</span>' +
                    '<span class="ddns-ip new">' + (e.new_ip ?? '') + '</span>';
                } else if (e.event === 'no_change') {
                  changeContent = '<span class="ddns-ip new">' + (e.new_ip ?? '') + '</span>';
                } else {
                  changeContent = '<span class="ddns-message">' + e.message + '</span>';
                }
                return '<div class="ddns-event">' +
                  '<div class="ddns-event-time" data-tip="' + time.toLocaleString() + '">' + relative + '</div>' +
                  '<div class="ddns-event-type"><span class="' + pillClass + '">' + e.event.replace('_', ' ').toUpperCase() + '</span></div>' +
                  (e.hostname ? '<div class="ddns-event-host">' + e.hostname + '</div>' : '<div class="ddns-event-host"></div>') +
                  '<div class="ddns-event-change">' + changeContent + '</div>' +
                  (e.source_ip ? '<div class="ddns-source">' + e.source_ip + '</div>' : '') +
                  '</div>';
              }).join('');
            } else if (data.ddnsLog.length > 0) {
              // Section didn't exist on initial render but now we have events
              location.reload();
            }
          }

          // --- Update charts + timeline (only present on full polls) ---
          if (data.charts) {
            renderCharts(data.charts);
            lastFullPoll = Date.now();
          }
          if (data.transitions) {
            renderTimeline(data.transitions);
          }

          return !!data.lastUpdate;
        })
        .catch(err => {
          console.error('Failed to poll:', err);
          return false;
        });
    }

    // Chart hover handling
    function findClosestPoint(sampled, ts) {
      let closest = sampled[0];
      let minDiff = Math.abs(sampled[0].timestamp - ts);
      for (const p of sampled) {
        const diff = Math.abs(p.timestamp - ts);
        if (diff < minDiff) {
          minDiff = diff;
          closest = p;
        }
      }
      return closest;
    }

    function showCursorsAtTime(hoverTime, hoveredContainer) {
      chartMeta.forEach((meta, container) => {
        const { cursor, highlight, tooltip, sampled, width, padding, chartWidth, xScale, yScale } = meta;
        const p = findClosestPoint(sampled, hoverTime);
        const snapX = xScale(p ? p.timestamp : hoverTime);

        if (snapX >= padding.left && snapX <= width - padding.right) {
          cursor.setAttribute('x1', String(snapX));
          cursor.setAttribute('x2', String(snapX));
          cursor.style.opacity = '1';

          if (p) {
            highlight.setAttribute('cx', String(snapX));
            highlight.setAttribute('cy', String(yScale(p.latency)));
            highlight.style.opacity = '1';
            highlight.style.fill = p.status === 'up' ? 'var(--chart-line)' : 'var(--color-down)';
          } else {
            highlight.style.opacity = '0';
          }

          if (container === hoveredContainer) {
            const hoverTs = p ? p.timestamp : hoverTime;
            const hoverAge = globalMaxTime - hoverTs;
            const time = hoverAge > 86400000
              ? new Date(hoverTs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
              : new Date(hoverTs).toLocaleTimeString();
            if (p) {
              const lat = p.error === 'Timeout' ? 'timeout' : (p.latency < 1000 ? Math.round(p.latency) + 'ms' : (p.latency / 1000).toFixed(2) + 's');
              const code = p.code ? ' [' + p.code + ']' : '';
              tooltip.textContent = time + ': ' + lat + code + (p.status === 'down' && p.error !== 'Timeout' ? ' (down)' : '');
            } else {
              tooltip.textContent = time;
            }
            // Convert viewBox coords to screen pixels for tooltip positioning
            const rect = meta.svg.getBoundingClientRect();
            const scale = rect.width / width;
            const screenX = snapX * scale;
            tooltip.style.left = Math.min(screenX, rect.width - tooltip.offsetWidth - 8) + 'px';
            tooltip.style.top = '-20px';
            tooltip.style.opacity = '1';
          } else {
            tooltip.style.opacity = '0';
            highlight.style.opacity = '0';
          }
        } else {
          cursor.style.opacity = '0';
          tooltip.style.opacity = '0';
          highlight.style.opacity = '0';
        }
      });
    }

    function hideCursors() {
      chartMeta.forEach((meta) => {
        meta.cursor.style.opacity = '0';
        meta.tooltip.style.opacity = '0';
        meta.highlight.style.opacity = '0';
      });
    }

    // Setup panel hover listeners
    function setupHoverListeners() {
      document.querySelectorAll('.panel').forEach(panel => {
        let hovering = false;
        let rafId = 0;
        let lastEvent = null;

        panel.addEventListener('mousemove', (e) => {
          lastEvent = e;
          hovering = true;
          if (!rafId) {
            rafId = requestAnimationFrame(() => {
              rafId = 0;
              if (!hovering || !lastEvent) return;
              const ev = lastEvent;

              const chartContainer = ev.target.closest('.chart-container');
              if (!chartContainer) {
                hideCursors();
                return;
              }

              const firstChart = panel.querySelector('.chart-container');
              if (!firstChart || !chartMeta.has(firstChart)) return;

              const meta = chartMeta.get(firstChart);
              const { svg, padding, chartWidth } = meta;
              const rect = svg.getBoundingClientRect();
              // Convert screen pixels to viewBox coordinates
              const x = (ev.clientX - rect.left) * (meta.width / rect.width);

              const frac = (x - padding.left) / chartWidth;
              const hoverTime = globalMaxTime - Math.pow(Math.max(1 - frac, 0), 1 / CHART_EXPONENT) * globalTimeRange;

              showCursorsAtTime(hoverTime, chartContainer);
            });
          }
        });

        panel.addEventListener('mouseleave', () => {
          hovering = false;
          lastEvent = null;
          hideCursors();
        });
      });
    }

    // Click chart to see errors for that service (but not when clicking clear button).
    // The errors page is admin-only, so public viewers get no click-through.
    document.addEventListener('click', (e) => {
      if (!IS_ADMIN) return;
      if (e.target.closest('.chart-clear')) return;
      const chart = e.target.closest('.chart-container');
      if (!chart) return;
      const service = chart.dataset.service;
      if (service) window.location.href = '/errors?service=' + encodeURIComponent(service);
    });

    // Clear history confirm modal
    const confirmModal = document.getElementById('confirm-modal');
    const confirmText = document.getElementById('confirm-modal-text');
    const confirmCancel = document.getElementById('confirm-cancel');
    const confirmOk = document.getElementById('confirm-ok');
    let pendingClearService = null;

    function showConfirmModal(service) {
      pendingClearService = service;
      confirmText.textContent = 'Delete all check history for ' + service + '? This cannot be undone.';
      confirmModal.classList.add('visible');
    }

    function hideConfirmModal() {
      confirmModal.classList.remove('visible');
      pendingClearService = null;
    }

    confirmCancel.addEventListener('click', hideConfirmModal);
    confirmModal.addEventListener('click', (e) => {
      if (e.target === confirmModal) hideConfirmModal();
    });

    confirmOk.addEventListener('click', () => {
      if (!pendingClearService) return;
      const service = pendingClearService;
      hideConfirmModal();
      fetch('/api/history?service=' + encodeURIComponent(service), { method: 'DELETE' })
        .then(r => r.json())
        .then(data => {
          // Clear the chart immediately
          const container = document.querySelector(\`.chart-container[data-service="\${service}"]\`);
          if (container) {
            chartMeta.delete(container);
            container.querySelector('.chart')?.remove();
            container.querySelector('.chart-label')?.remove();
            container.querySelector('.chart-tooltip')?.remove();
            const loading = container.querySelector('.chart-loading');
            if (!loading) {
              const el = document.createElement('div');
              el.className = 'chart-loading';
              el.textContent = 'No history yet';
              container.appendChild(el);
            } else {
              loading.textContent = 'No history yet';
            }
          }
          // Clear uptime + latency below chart
          if (container) {
            container.querySelectorAll('.chart-uptime, .chart-latency').forEach(el => el.remove());
            ['data-uptime-30d', 'data-uptime-30d-class', 'data-uptime-7d', 'data-uptime-7d-class', 'data-uptime-24h', 'data-uptime-24h-class', 'data-latency', 'data-latency-class'].forEach(a => container.removeAttribute(a));
          }
        });
    });

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.chart-clear');
      if (!btn) return;
      e.stopPropagation();
      const service = btn.dataset.clearService;
      if (service) showConfirmModal(service);
    });

    // Filter state
    let showOnlyDown = false;
    let activeLabel = 'all';

    function applyFilter() {
      const filterBtn = document.getElementById('status-filter');
      document.querySelectorAll('.service').forEach(service => {
        const status = service.dataset.status;
        const labels = (service.dataset.labels || '').split(' ').filter(Boolean);
        const matchesStatus = !showOnlyDown || status !== 'up';
        const matchesLabel = activeLabel === 'all' || labels.includes(activeLabel);
        if (matchesStatus && matchesLabel) {
          service.classList.remove('collapsed');
        } else {
          service.classList.add('collapsed');
        }
      });
      if (filterBtn) {
        filterBtn.classList.toggle('active', showOnlyDown);
      }
      // Hide panels where all services are collapsed
      document.querySelectorAll('[data-panel]').forEach(panel => {
        const services = panel.querySelector('.services');
        if (!services) return;
        const visible = services.querySelectorAll('.service:not(.collapsed)');
        panel.style.display = visible.length === 0 ? 'none' : '';
      });
      // Update active label button
      document.querySelectorAll('.label-filter').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.label === activeLabel);
      });
    }

    // Status filter toggle
    document.getElementById('status-filter')?.addEventListener('click', () => {
      showOnlyDown = !showOnlyDown;
      applyFilter();
    });

    // Label filter bar
    document.getElementById('label-bar')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.label-filter');
      if (!btn) return;
      const label = btn.dataset.label;
      activeLabel = activeLabel === label ? 'all' : label;
      applyFilter();
    });

    // Setup hover listeners early — they safely no-op if charts aren't rendered yet
    setupHoverListeners();

    // Render inline chart data immediately if available
    if (inlineCharts) {
      renderCharts(inlineCharts);
    }

    // --- Event timeline (correlation swimlanes) ---
    let lastTransitions = null;
    let tlResizeBound = false;
    const TL_GROUP_ORDER = { service: 0, github: 1, ddns: 2 };
    const TL_GROUP_NAME = { service: 'Services', github: 'GitHub', ddns: 'DDNS' };

    function tlEscape(s) {
      return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function tlTime(t) { return new Date(t).toLocaleString(); }
    function tlDur(ms) {
      const m = Math.round(ms / 60000);
      if (m < 60) return m + 'm';
      const h = Math.floor(m / 60);
      if (h < 24) return (m % 60) ? h + 'h ' + (m % 60) + 'm' : h + 'h';
      const d = Math.floor(h / 24);
      return (h % 24) ? d + 'd ' + (h % 24) + 'h' : d + 'd';
    }
    function tlTrunc(s) { return s.length > 24 ? s.slice(0, 23) + '…' : s; }

    function renderTimeline(transitions) {
      if (transitions) lastTransitions = transitions;
      const data = lastTransitions;
      const container = document.getElementById('timeline');
      if (!container || !data) return;
      const keys = Object.keys(data);
      if (keys.length === 0) {
        container.innerHTML = '<div class="chart-loading">No timeline data yet</div>';
        return;
      }

      const lanes = keys.map(k => Object.assign({ key: k }, data[k]));
      lanes.sort((a, b) =>
        ((TL_GROUP_ORDER[a.kind] ?? 9) - (TL_GROUP_ORDER[b.kind] ?? 9)) || a.label.localeCompare(b.label));

      // Align the time axis with the latency charts when they've rendered.
      const now = Date.now();
      const maxTime = globalMaxTime > 0 ? globalMaxTime : now;
      const range = globalTimeRange > 1 ? globalTimeRange : 30 * 24 * 60 * 60 * 1000;
      const minTime = maxTime - range;

      const width = container.clientWidth || 800;
      const LABEL_W = 150, rightPad = 8;
      const trackW = Math.max(width - LABEL_W - rightPad, 50);
      const rowH = 18, barH = 11, groupH = 16, topPad = 6;

      const xScale = (ts) => {
        const age = Math.max(maxTime - ts, 0);
        return LABEL_W + (1 - Math.pow(Math.min(age / range, 1), CHART_EXPONENT)) * trackW;
      };
      const invX = (x) => {
        const frac = Math.min(Math.max((x - LABEL_W) / trackW, 0), 1);
        return maxTime - Math.pow(Math.max(1 - frac, 0), 1 / CHART_EXPONENT) * range;
      };

      const rows = [];
      let curKind = null, y = topPad;
      for (const lane of lanes) {
        if (lane.kind !== curKind) { rows.push({ group: TL_GROUP_NAME[lane.kind] || lane.kind, y }); y += groupH; curKind = lane.kind; }
        rows.push({ lane, y }); y += rowH;
      }
      const height = y + 4;

      const p = [];
      p.push('<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" height="' + height + '">');
      for (const row of rows) {
        if (row.group) {
          p.push('<text class="tl-group" x="2" y="' + (row.y + 11) + '">' + tlEscape(row.group) + '</text>');
          continue;
        }
        const lane = row.lane;
        const cy = row.y + rowH / 2;
        p.push('<line class="tl-rowline" x1="' + LABEL_W + '" y1="' + cy + '" x2="' + (LABEL_W + trackW) + '" y2="' + cy + '"/>');
        const lbl = tlEscape(tlTrunc(lane.label));
        const txt = '<text class="tl-label" x="2" y="' + (cy + 3.5) + '">' + lbl + '</text>';
        p.push(lane.link ? '<a href="' + tlEscape(lane.link) + '" target="_blank" rel="noopener">' + txt + '</a>' : txt);

        const ts = lane.transitions || [];
        for (let i = 0; i < ts.length; i++) {
          const start = ts[i].ts;
          const end = (i + 1 < ts.length) ? ts[i + 1].ts : maxTime;
          if (end < minTime) continue; // entirely before the visible window
          const x1 = xScale(Math.max(start, minTime));
          let x2 = xScale(Math.min(end, maxTime));
          if (x2 - x1 < 0.75) x2 = x1 + 0.75; // keep instantaneous blips visible
          const up = ts[i].up;
          const rh = up ? Math.max(barH - 4, 3) : barH;
          const ry = cy - rh / 2;
          const title = lane.label + ' — ' + (up ? 'up' : 'down') +
            (ts[i].detail ? ' (' + ts[i].detail + ')' : '') + ' · ' + tlTime(start) + ' for ' + tlDur(end - start);
          p.push('<rect class="' + (up ? 'tl-seg-up' : 'tl-seg-down') + '" x="' + x1.toFixed(1) + '" y="' +
            ry.toFixed(1) + '" width="' + (x2 - x1).toFixed(1) + '" height="' + rh + '"><title>' + tlEscape(title) + '</title></rect>');
        }
      }
      p.push('<line class="tl-cursor" id="tl-cursor" x1="0" y1="' + topPad + '" x2="0" y2="' + (height - 4) + '"/>');
      p.push('<text class="tl-cursor-time" id="tl-cursor-time" x="0" y="11"></text>');
      p.push('</svg>');
      container.innerHTML = p.join('');

      const svg = container.querySelector('svg');
      const cursor = container.querySelector('#tl-cursor');
      const ctime = container.querySelector('#tl-cursor-time');
      svg.addEventListener('mousemove', (e) => {
        const rect = svg.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width * width;
        if (px < LABEL_W) { cursor.style.opacity = 0; ctime.style.opacity = 0; return; }
        cursor.setAttribute('x1', px); cursor.setAttribute('x2', px);
        cursor.style.opacity = 1;
        ctime.textContent = tlTime(invX(px));
        ctime.setAttribute('x', px > width - 130 ? px - 128 : px + 4);
        ctime.style.opacity = 1;
      });
      svg.addEventListener('mouseleave', () => { cursor.style.opacity = 0; ctime.style.opacity = 0; });

      if (!tlResizeBound) {
        tlResizeBound = true;
        let rt;
        window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => renderTimeline(null), 150); });
      }
    }

    // Callback for streamed chart data (appended as <script> at end of HTML stream)
    window.__onChartsReady = function(charts) {
      renderCharts(charts);
      lastFullPoll = Date.now();
    };

    // Callback for streamed timeline data (appended as <script> at end of HTML stream)
    window.__onTransitionsReady = function(transitions) {
      renderTimeline(transitions);
    };

    // Adaptive polling: 5s until data arrives, then the plan's steady interval.
    const POLL_INTERVAL = ${plan.clientPollMs};
    let hasData = ${lastUpdate !== null};
    let pollTimer = null;

    function startPolling(interval) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        poll().then(gotData => {
          applyFilter();
          if (!hasData && gotData) {
            hasData = true;
            startPolling(POLL_INTERVAL);
          }
        });
      }, interval);
    }

    // Steady interval once we have data, 5s rapid-poll until the first arrives.
    // Chart data arrives via stream or inline — no need for an initial full poll.
    if (hasData) {
      startPolling(POLL_INTERVAL);
    } else {
      poll().then(gotData => {
        hasData = gotData;
        startPolling(hasData ? POLL_INTERVAL : 5000);
      });
    }

    // Auto-refresh GitHub Actions badges every 5 minutes
    setInterval(() => {
      const badges = document.querySelectorAll('.gh-badge img');
      const bust = '_t=' + Date.now();
      badges.forEach(img => {
        const src = img.getAttribute('src');
        if (!src) return;
        const base = src.split('?')[0];
        img.setAttribute('src', base + '?' + bust);
      });
    }, 5 * 60 * 1000);

    // Service Worker & Push Notifications
    (function () {
      if (!('serviceWorker' in navigator)) return;
      const vapidPublicKey = ${vapidPublicKey ? JSON.stringify(vapidPublicKey) : 'null'};

      navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function (reg) {
        function updateNotifBtn() {
          const btn = document.getElementById('notif-btn');
          if (!btn || !('PushManager' in window)) return;
          if (Notification.permission === 'denied') {
            btn.textContent = '🔕';
            btn.title = 'Notifications blocked — allow them in browser settings';
            btn.dataset.state = 'denied';
            return;
          }
          reg.pushManager.getSubscription().then(function (sub) {
            if (sub) {
              btn.textContent = '🔔';
              btn.title = 'Notifications enabled — click to unsubscribe';
              btn.dataset.state = 'on';
            } else {
              btn.textContent = '🔕';
              btn.title = 'Click to enable push notifications';
              btn.dataset.state = 'off';
            }
          });
        }

        if (vapidPublicKey) updateNotifBtn();

        const notifBtn = document.getElementById('notif-btn');
        if (!notifBtn || !vapidPublicKey) return;

        notifBtn.addEventListener('click', async function () {
          const state = notifBtn.dataset.state;
          if (state === 'denied') {
            alert('Notifications are blocked. Enable them in your browser / OS settings, then reload.');
            return;
          }
          if (state === 'on') {
            // Optimistic: update UI immediately with saving indicator
            notifBtn.textContent = '🔕';
            notifBtn.title = 'Click to enable push notifications';
            notifBtn.dataset.state = 'off';
            notifBtn.classList.add('notif-saving');
            const sub = await reg.pushManager.getSubscription();
            if (sub) {
              const endpoint = sub.endpoint;
              await sub.unsubscribe();
              fetch('/api/unsubscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint }),
              }).then(() => {
                notifBtn.classList.remove('notif-saving');
              }).catch(err => {
                notifBtn.classList.remove('notif-saving');
                console.error('Unsubscribe server cleanup failed:', err);
              });
            } else {
              notifBtn.classList.remove('notif-saving');
            }
            return;
          }
          // Request permission and subscribe
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') { updateNotifBtn(); return; }
          try {
            // Convert base64url to Uint8Array for applicationServerKey
            const p = '='.repeat((4 - vapidPublicKey.length % 4) % 4);
            const b64 = (vapidPublicKey + p).replace(/-/g, '+').replace(/_/g, '/');
            const appKey = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
            const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
            // Optimistic: update UI before server round-trip
            notifBtn.textContent = '🔔';
            notifBtn.title = 'Notifications enabled — click to unsubscribe';
            notifBtn.dataset.state = 'on';
            notifBtn.classList.add('notif-saving');
            const j = sub.toJSON();
            fetch('/api/subscribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }),
            }).then(res => {
              notifBtn.classList.remove('notif-saving');
              if (!res.ok) {
                sub.unsubscribe();
                updateNotifBtn();
                console.error('Server rejected subscription:', res.status);
              }
            }).catch(err => {
              notifBtn.classList.remove('notif-saving');
              sub.unsubscribe();
              updateNotifBtn();
              console.error('Subscribe server save failed:', err);
            });
          } catch (err) {
            console.error('Push subscription failed:', err);
            updateNotifBtn();
          }
        });
      }).catch(function (err) {
        console.warn('Service worker registration failed:', err);
      });
    })();

    // Notification settings modal
    (function () {
      const modal = document.getElementById('notif-settings-modal');
      const titleEl = document.getElementById('notif-settings-title');
      const enabledEl = document.getElementById('notif-enabled');
      const thresholdEl = document.getElementById('notif-threshold');
      const recoveryEl = document.getElementById('notif-recovery');
      const urgencyEl = document.getElementById('notif-urgency');
      const cancelBtn = document.getElementById('notif-cancel');
      const saveBtn = document.getElementById('notif-save');
      let currentKey = null;
      let allSettings = {}; // cached bulk settings

      // Update bell icon from cached settings
      function applyBellState(btn) {
        const key = btn.dataset.notifyKey;
        if (!key) return;
        const s = allSettings[key];
        if (s && s.enabled) {
          btn.textContent = '🔔';
          btn.classList.add('notif-on');
          btn.classList.remove('notif-off');
        } else {
          btn.textContent = '🔕';
          btn.classList.add('notif-off');
          btn.classList.remove('notif-on');
        }
      }

      // Bulk-fetch all notification settings in one request, then update all bells
      async function loadAllBellStates() {
        try {
          const res = await fetch('/api/notification-settings');
          allSettings = await res.json();
        } catch { allSettings = {}; }
        document.querySelectorAll('.bell-btn').forEach(applyBellState);
      }

      // Initialize: single bulk fetch
      loadAllBellStates();

      // Attach click handlers to all bell buttons
      document.querySelectorAll('.bell-btn').forEach(btn => {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          currentKey = btn.dataset.notifyKey;
          const label = btn.dataset.notifyLabel || currentKey;
          if (titleEl) titleEl.textContent = '🔔 Notifications: ' + label;
          // Populate modal from cached settings
          const s = allSettings[currentKey] || {};
          if (enabledEl) enabledEl.checked = !!s.enabled;
          if (thresholdEl) thresholdEl.value = String(s.failure_threshold || 1);
          if (recoveryEl) recoveryEl.checked = !!s.notify_recovery;
          if (urgencyEl) urgencyEl.value = s.urgency || '';
          // Hide threshold for DDNS/GitHub (threshold only applies to service checks)
          const thresholdRow = thresholdEl ? thresholdEl.closest('.notif-row') : null;
          if (thresholdRow) thresholdRow.style.display = (currentKey === 'ddns' || currentKey.startsWith('gh:')) ? 'none' : '';
          modal.classList.add('visible');
        });
      });

      function hideModal() {
        modal.classList.remove('visible');
        currentKey = null;
      }

      cancelBtn.addEventListener('click', hideModal);
      modal.addEventListener('click', (e) => { if (e.target === modal) hideModal(); });

      saveBtn.addEventListener('click', function () {
        if (!currentKey) return;
        const body = {
          key: currentKey,
          enabled: enabledEl.checked ? 1 : 0,
          failure_threshold: Math.max(1, parseInt(thresholdEl.value) || 1),
          notify_recovery: recoveryEl.checked ? 1 : 0,
          urgency: urgencyEl.value || null,
        };
        // Optimistic: update cache, bells, and close modal immediately
        const savedKey = currentKey;
        const prevSettings = allSettings[savedKey];
        allSettings[savedKey] = { enabled: body.enabled, failure_threshold: body.failure_threshold, notify_recovery: body.notify_recovery, urgency: body.urgency };
        const affectedBells = document.querySelectorAll('.bell-btn[data-notify-key="' + CSS.escape(savedKey) + '"]');
        affectedBells.forEach(b => { applyBellState(b); b.classList.add('notif-saving'); });
        hideModal();
        // Fire-and-forget with rollback on failure
        fetch('/api/notification-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(res => {
          if (!res.ok) throw new Error('Server returned ' + res.status);
          affectedBells.forEach(b => b.classList.remove('notif-saving'));
        }).catch(err => {
          console.error('Failed to save notification settings:', err);
          // Rollback
          if (prevSettings) { allSettings[savedKey] = prevSettings; } else { delete allSettings[savedKey]; }
          affectedBells.forEach(b => { applyBellState(b); b.classList.remove('notif-saving'); });
        });
      });
    })();
  </script>
</body>
</html>`;
}

/** Fallback badge for providers that don't supply their own icon. */
const GENERIC_PROVIDER_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="6" cy="18" r="1" fill="currentColor" stroke="none"/></svg>';
const GENERIC_PROVIDER_COLOR = '#8B949E';

/** Extract hostname from a full URL */
function getHostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatUptime(val: number | null): string {
  return val === null ? '-' : `${val.toFixed(2)}%`;
}

function uptimeClass(val: number | null): string {
  if (val === null) return '';
  if (val >= 99.9) return 'good';
  if (val >= 99) return 'warn';
  return 'bad';
}

function renderService(
  config: DashboardConfig,
  s: ServiceStatus,
  showBells = false,
  uptime?: Record<string, UptimeByPeriod>,
  labelDefs?: Map<string, LabelDefinition>,
): string {
  // Get the primary check (first https check, or first check)
  const primaryCheck = s.checks.find(c => c.type === 'https') ?? s.checks[0];
  const primaryUrl = primaryCheck?.url ?? '';

  // Determine main status pill
  const mainStatus = s.status === 'up' ? 'up' : s.knownStatus === 'known-down' ? 'known-down' : 'down';
  const mainPillClass = `pill-${mainStatus}`;

  // Get latency from primary check
  const latency = primaryCheck?.latency ?? 0;
  const isTimeout = primaryCheck?.error === 'Timeout';
  const latencyClass = isTimeout ? 'slow' : latency < 200 ? 'fast' : latency > 1000 ? 'slow' : '';

  // Build pills array
  const pills: string[] = [];

  if (s.checks.length === 0) {
    // No data yet — show pending pill to keep layout aligned
    pills.push('<span class="pill pill-pending">Pending</span>');
  } else {
    // Group HTTPS checks by host
    const httpsChecks = s.checks.filter(c => c.type === 'https');
    const uniqueHosts = [...new Set(httpsChecks.map(c => getHostFromUrl(c.url)))];

    if (uniqueHosts.length <= 1) {
      // Single host: show "HTTPS" pill as before
      if (primaryCheck) {
        const label = primaryCheck.type.toUpperCase();
        const tip = `${label} endpoint is ${primaryCheck.status === 'up' ? 'reachable' : 'unreachable'}`;
        pills.push(`<span class="pill ${mainPillClass}" data-tip="${tip}">${label}</span>`);
      }
    } else {
      // Multiple hosts: show one pill per host
      for (const host of uniqueHosts) {
        const hostChecks = httpsChecks.filter(c => getHostFromUrl(c.url) === host);
        const allUp = hostChecks.every(c => c.status === 'up');
        const status = s.knownStatus === 'known-down' ? 'known-down' : allUp ? 'up' : 'down';
        const tip = `${host} is ${allUp ? 'reachable' : 'unreachable'}`;
        pills.push(`<span class="pill pill-${status}" data-tip="${tip}">${escapeHtml(host)}</span>`);
      }
    }

    // HTTP redirect pill (if there's an http check)
    const httpCheck = s.checks.find(c => c.type === 'http');
    if (httpCheck) {
      const httpStatus = httpCheck.status === 'up' ? 'pill-up' : 'pill-down';
      const tip = httpCheck.status === 'up' ? 'HTTP correctly redirects to HTTPS' : 'HTTP is not redirecting to HTTPS';
      pills.push(`<span class="pill ${httpStatus}" data-tip="${tip}">HTTP\u2192HTTPS</span>`);
    }

    // WWW redirect pill
    if (s.wwwCheck) {
      const wwwStatus = s.wwwCheck.status === 'up' ? 'pill-up' : 'pill-down';
      const tip =
        s.wwwCheck.status === 'up'
          ? 'www subdomain correctly redirects to apex'
          : 'www subdomain is not redirecting to apex';
      pills.push(`<span class="pill ${wwwStatus}" data-tip="${tip}">WWW</span>`);
    }
  }

  // Location badge (config-supplied markup for known locations, text otherwise)
  const flag = s.location ? config.flags?.[s.location] : undefined;
  const locationHtml = s.location
    ? `<span class="service-location" data-tip="${escapeHtml(s.locationTitle ?? '')}">${flag ?? escapeHtml(s.location)}</span>`
    : '';

  // Provider badge
  const provider = s.provider ? config.providers?.[s.provider] : undefined;
  const providerUrl = s.link ?? provider?.url;
  const providerHtml =
    provider && providerUrl
      ? `<a class="service-provider" href="${escapeHtml(providerUrl)}" target="_blank" rel="noopener" data-tip="${escapeHtml(provider.name)}" style="--provider-color: ${provider.color ?? GENERIC_PROVIDER_COLOR}">${provider.icon ?? GENERIC_PROVIDER_ICON}</a>`
      : '';

  // Label stripe
  const serviceLabels = s.labels ?? [];
  const labelDataAttr = serviceLabels.length > 0 ? ` data-labels="${escapeHtml(serviceLabels.join(' '))}"` : '';
  const labelStripeStyle = (() => {
    if (serviceLabels.length === 0) return '';
    const colors = serviceLabels.map(id => labelDefs?.get(id)?.color ?? '#8b949e');
    if (colors.length === 1) return ` style="--label-stripe: ${colors[0]}"`;
    // Build hard-stop gradient so each color gets an equal band
    const stops = colors
      .map((c, i) => `${c} ${(i / colors.length) * 100}% ${((i + 1) / colors.length) * 100}%`)
      .join(', ');
    return ` style="--label-stripe: linear-gradient(to bottom, ${stops})"`;
  })();
  return `
    <div class="service" data-status="${mainStatus}"${labelDataAttr}${labelStripeStyle}>
      <div class="service-row">
        <div class="service-top">
          <div class="service-main">
            ${showBells ? `<button class="bell-btn" data-notify-key="${escapeHtml(s.host ?? s.name)}" data-notify-label="${escapeHtml(s.name)}" title="Notification settings for ${escapeHtml(s.name)}" aria-label="Notification settings for ${escapeHtml(s.name)}">🔔</button>` : ''}
            <span class="service-name"><a href="${escapeHtml(primaryUrl)}" target="_blank" rel="noopener">${escapeHtml(s.name)}</a></span>
            ${locationHtml}
            ${providerHtml}
          </div>
          <div class="service-pills">
            ${pills.join('')}
            <span class="pill pill-status ${mainPillClass}" data-tip="HTTP status code">${primaryCheck?.code ?? '-'}</span>
          </div>
        </div>
      </div>
      <div class="chart-container" data-service="${escapeHtml(s.host ?? s.name)}" data-latency="${formatLatency(latency, primaryCheck?.error)}" data-latency-class="${latencyClass}"${(() => {
        const key = s.host ?? s.name;
        const u = uptime?.[key];
        return u
          ? ` data-uptime-30d="${formatUptime(u.uptime30d ?? null)}" data-uptime-30d-class="${uptimeClass(u.uptime30d ?? null)}" data-uptime-7d="${formatUptime(u.uptime7d ?? null)}" data-uptime-7d-class="${uptimeClass(u.uptime7d ?? null)}" data-uptime-24h="${formatUptime(u.uptime24h ?? null)}" data-uptime-24h-class="${uptimeClass(u.uptime24h ?? null)}"`
          : '';
      })()}>
        <button class="chart-clear" data-clear-service="${escapeHtml(s.host ?? s.name)}" title="Clear history">clear</button>
        <div class="chart-loading">Loading...</div>
        <div class="chart-latency"><span class="stat-value ${latencyClass}">${formatLatency(latency, primaryCheck?.error)}</span></div>
      </div>
    </div>
  `;
}

/** Format relative time (e.g. "3h ago") */
function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** Render a DDNS log entry */
function renderDdnsEvent(entry: DdnsLogEntry): string {
  const time = new Date(entry.timestamp);
  const relative = formatRelativeTime(entry.timestamp);
  const pillClass = `pill pill-${entry.event.replace('_', '-')}`;

  let changeContent = '';
  if (entry.event === 'ip_change') {
    changeContent = `
      <span class="ddns-ip old">${escapeHtml(entry.old_ip ?? '')}</span>
      <span class="ddns-arrow">&rarr;</span>
      <span class="ddns-ip new">${escapeHtml(entry.new_ip ?? '')}</span>
    `;
  } else if (entry.event === 'no_change') {
    changeContent = `<span class="ddns-ip new">${escapeHtml(entry.new_ip ?? '')}</span>`;
  } else {
    changeContent = `<span class="ddns-message">${escapeHtml(entry.message)}</span>`;
  }

  return `
    <div class="ddns-event">
      <div class="ddns-event-time" data-tip="${escapeHtml(time.toLocaleString())}">${escapeHtml(relative)}</div>
      <div class="ddns-event-type"><span class="${pillClass}">${escapeHtml(entry.event.replace('_', ' ').toUpperCase())}</span></div>
      ${entry.hostname ? `<div class="ddns-event-host">${escapeHtml(entry.hostname)}</div>` : '<div class="ddns-event-host"></div>'}
      <div class="ddns-event-change">${changeContent}</div>
      ${entry.source_ip ? `<div class="ddns-source">${escapeHtml(entry.source_ip)}</div>` : ''}
    </div>
  `;
}
