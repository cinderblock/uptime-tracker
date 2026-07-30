/**
 * Example configuration — copy to `src/config.ts` and edit.
 *
 *   cp src/config.example.ts src/config.ts
 *
 * `src/config.ts` is gitignored, so your hostnames stay out of version control.
 *
 * This is TypeScript rather than YAML on purpose: wrangler's build doesn't
 * handle YAML imports, and adding a codegen step would break live reload.
 */

import type { DashboardConfig, DdnsClient, GitHubWorkflowConfig, LabelDefinition } from './types';

/** Shorthand for workflows in one GitHub org, so you don't repeat the owner. */
const gh =
  (owner: string) =>
  (repo: string, workflow: string, displayName?: string): GitHubWorkflowConfig => ({
    owner,
    repo,
    workflow,
    displayName,
  });

const myRepos = gh('your-github-username');

/**
 * Labels tag services across panels — click one in the UI to filter. Use them
 * for whatever cuts across your panel layout: host machine, datacenter, client.
 */
const labels = [
  { id: 'web', name: 'Web', color: '#3fb950' },
  { id: 'internal', name: 'Internal', color: '#58a6ff' },
  { id: 'cloud', name: 'Cloud', color: '#8b949e' },
] satisfies LabelDefinition[];

export const config: DashboardConfig = {
  labels,

  /**
   * Optional: GitHub Actions workflow badges. Requires a GITHUB_TOKEN secret
   * for private repos; public repos work without one. Omit or leave empty to
   * hide the panel entirely.
   */
  githubWorkflows: [myRepos('my-website', 'deploy.yml', 'Deploy'), myRepos('my-api', 'test.yml', 'Tests')],

  /**
   * Optional: hosting providers referenced by a service's `provider` key.
   * No vendor logos ship with this project — supply your own `icon` (inline
   * SVG) or omit it for a generic server glyph. Vendor logos are trademarks;
   * check the vendor's brand guidelines before redistributing one.
   */
  providers: {
    myhost: { name: 'My Host', url: 'https://console.example-host.com/', color: '#0080FF' },
  },

  /**
   * Optional: markup for `location` values. Anything without an entry renders
   * as plain text, so emoji in `location` works with no config at all.
   */
  flags: {
    DE: '<svg viewBox="0 0 18 12" width="18" height="12"><rect width="18" height="4" fill="#000"/><rect y="4" width="18" height="4" fill="#D00"/><rect y="8" width="18" height="4" fill="#FFCE00"/></svg>',
  },

  panels: [
    {
      panel: 'Websites',
      services: [
        // Simplest form: check https://example.com/ and expect a 200.
        { host: 'example.com', https: '/', labels: ['web', 'cloud'] },

        // `www: true` additionally checks that http://www.host redirects to the apex.
        { name: 'My Blog', host: 'blog.example.com', https: '/', www: true, labels: ['web'] },

        // Expect a specific status code instead of 200.
        {
          name: 'Admin API',
          host: 'api.example.com',
          https: [
            { url: '/health', expect: 200 },
            { url: '/admin', expect: 401 },
          ],
          labels: ['web'],
        },

        // Expect a redirect to a specific destination.
        {
          host: 'old-domain.example',
          https: { url: '/', redirect: 'https://example.com/' },
          www: { redirect: 'https://example.com/' },
          labels: ['web'],
        },
      ],
    },
    {
      panel: 'Servers',
      services: [
        {
          name: 'App Server',
          host: 'app.example.com',
          https: ['/', '/health'],
          location: 'DE',
          locationTitle: 'Frankfurt',
          provider: 'myhost',
          labels: ['cloud'],
        },
        {
          name: 'Office NAS',
          host: 'nas.internal.example.com',
          https: '/',
          // `internal: true` services are only checked from a browser on the
          // local network, never from Cloudflare's edge.
          internal: true,
          location: '🏢',
          locationTitle: 'Office',
          labels: ['internal'],
        },
      ],
    },
  ],
};

/**
 * Optional: dynamic-DNS clients to watch, if you point a DDNS updater at this
 * worker's database (see docs/ddns.md). Empty by default — the DDNS panel stays
 * hidden and no DDNS alerting runs.
 *
 * `heartbeat: true` means the client re-sends on a fixed interval, so silence
 * is meaningful and staleness alerting applies. Clients that only report on IP
 * change should leave it false.
 */
export const ddnsClients: DdnsClient[] = [];
