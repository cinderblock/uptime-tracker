#!/usr/bin/env bun
/**
 * Local dev server with remote bindings.
 *
 * Resolves placeholder D1/KV IDs in wrangler.toml using `wrangler` CLI
 * (which uses OAuth from `wrangler login`), writes wrangler.resolved.toml,
 * then starts `wrangler dev --remote`.
 *
 * Usage: bun dev.ts
 * Prerequisites: run `wrangler login` once to authenticate.
 */

import { $ } from 'bun';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

const tomlContent = await Bun.file('wrangler.toml').text();
const parsed = parseToml(tomlContent) as Record<string, unknown>;
let needsResolve = false;

// ── Resolve D1 databases ─────────────────────────────────────────────────────

const d1Databases = parsed.d1_databases as
  { binding: string; database_name: string; database_id: string }[] | undefined;
if (d1Databases) {
  const d1Out = await $`wrangler d1 list --json`.quiet().text();
  const d1List = JSON.parse(d1Out.slice(d1Out.indexOf('['))) as { name: string; uuid: string }[];
  const d1ByName = new Map(d1List.map(db => [db.name, db.uuid]));

  for (const db of d1Databases) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(db.database_id)) continue;
    const uuid = d1ByName.get(db.database_name);
    if (!uuid) {
      console.error(`D1 database "${db.database_name}" not found. Run sync or create it first.`);
      process.exit(1);
    }
    console.log(`D1 "${db.database_name}" → ${uuid}`);
    db.database_id = uuid;
    needsResolve = true;
  }
}

// ── Resolve KV namespaces ────────────────────────────────────────────────────

const kvNamespaces = parsed.kv_namespaces as
  { binding: string; id: string; preview_id?: string; title?: string }[] | undefined;
if (kvNamespaces) {
  const kvOut = await $`wrangler kv namespace list`.quiet().text();
  const kvList = JSON.parse(kvOut.slice(kvOut.indexOf('['))) as { id: string; title: string }[];
  const kvByTitle = new Map(kvList.map(ns => [ns.title, ns.id]));

  for (const ns of kvNamespaces) {
    if (/^[0-9a-f]{32}$/i.test(ns.id)) continue;
    const title = ns.title ?? ns.binding;
    const id = kvByTitle.get(title);
    if (!id) {
      console.error(`KV namespace "${title}" not found. Run sync or create it first.`);
      process.exit(1);
    }
    console.log(`KV "${title}" → ${id}`);
    ns.id = id;
    ns.preview_id = id; // wrangler dev requires preview_id — use same namespace
    needsResolve = true;
  }
}

// ── Write resolved TOML and start dev server ─────────────────────────────────

const configFlag = needsResolve ? '-c wrangler.resolved.toml' : '';
if (needsResolve) {
  await Bun.write('wrangler.resolved.toml', stringifyToml(parsed));
  console.log('Wrote wrangler.resolved.toml');
}

const args = ['wrangler', 'dev', '--remote'];
if (needsResolve) args.push('-c', 'wrangler.resolved.toml');

const proc = Bun.spawn(args, { stdio: ['inherit', 'inherit', 'inherit'] });
process.on('SIGINT', () => proc.kill());
await proc.exited;
