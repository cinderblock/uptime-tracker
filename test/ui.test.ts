import { describe, expect, test } from 'bun:test';
import { renderDashboard } from '../src/ui';
import { config } from '../src/config';
import { resolvePlan } from '../src/plan';
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
