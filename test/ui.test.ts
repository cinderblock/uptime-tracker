import { describe, expect, test } from 'bun:test';
import { renderDashboard } from '../src/ui';
import { config } from '../src/config';
import { chartIntervals, resolvePlan } from '../src/plan';
import type { Env } from '../src/types';

const render = (tier: string) =>
  renderDashboard(resolvePlan({ PLAN: tier } as Env), config, { panels: [], lastUpdate: Date.now() });

describe('client poll intervals', () => {
  // These lived on the profile but were read by nothing for a while — the
  // client JS hardcoded 30s/5min, so free did twice its intended read rate.
  // The full-poll interval is the dominant free-plan read cost: a full poll is
  // the ~6,000-row rollup query, a light one is a single blob row.
  test.each(['free', 'paid'])('%s renders its own profile values', tier => {
    const plan = resolvePlan({ PLAN: tier } as Env);
    const html = render(tier);
    expect(html).toContain(`const POLL_INTERVAL = ${plan.clientPollMs}`);
    expect(html).toContain(`const FULL_POLL_INTERVAL = ${plan.clientFullPollMs}`);
  });

  test('the two profiles actually differ', () => {
    expect(render('free')).not.toBe(render('paid'));
  });

  test('no hardcoded interval survives', () => {
    for (const tier of ['free', 'paid']) {
      expect(render(tier)).not.toContain('startPolling(30000)');
    }
  });
});

describe('chart gap threshold', () => {
  // Regression: the client hardcoded a 1-minute expected interval and declares a
  // gap at 3x it. On free's 5-minute cron every adjacent pair therefore looked
  // like a gap, so every segment held one point and buildSegmentPaths emitted a
  // bare `M x y` with no `L` — an SVG path that renders nothing. The dots stayed
  // (drawn separately), so the chart lost only its line, with no error anywhere.
  test.each(['free', 'paid'])('%s tolerates its own cron spacing', tier => {
    const plan = resolvePlan({ PLAN: tier } as Env);
    const { tiers } = chartIntervals(plan);
    const cronMs = plan.cronIntervalMinutes * 60_000;

    expect(tiers[0][1]).toBe(cronMs);
    // The actual invariant: normally-spaced points must NOT read as a gap.
    expect(cronMs).toBeLessThan(tiers[0][1] * 3);
  });

  test('an overridden cron interval reaches the rendered client JS', () => {
    // A 15-minute cron on the free profile: nothing may still assume 1 minute.
    const plan = resolvePlan({ PLAN: 'free', CRON_INTERVAL_MINUTES: '15' } as Env);
    const html = renderDashboard(plan, config, { panels: [], lastUpdate: Date.now() });
    expect(html).toContain(JSON.stringify(chartIntervals(plan)));
    expect(chartIntervals(plan).tiers[0][1]).toBe(15 * 60_000);
  });

  test('free reads pre-6h history as hourly, matching uptime_hourly', () => {
    // Older free data comes from the rollup, so it is hourly by construction —
    // asserting the paid decimation tiers there would reintroduce the same bug.
    expect(chartIntervals(resolvePlan({ PLAN: 'free' } as Env)).fallback).toBe(3_600_000);
  });
});

describe('rendering', () => {
  test('produces a complete document with no unresolved template holes', () => {
    const html = render('paid');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    // A bare `undefined` anywhere is too strict to assert — the emitted client
    // JS legitimately calls toLocaleDateString(undefined, …) to mean "use the
    // browser locale". Only flag it where it landed in markup, which is what a
    // botched interpolation actually looks like.
    expect(html).not.toMatch(/>undefined</);
    expect(html).not.toMatch(/="undefined"/);
    expect(html).not.toContain('[object Object]');
  });

  test('survives an empty dashboard with no data yet', () => {
    const plan = resolvePlan({ PLAN: 'free' } as Env);
    expect(() => renderDashboard(plan, config, { panels: [], lastUpdate: null })).not.toThrow();
  });
});
