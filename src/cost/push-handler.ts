/** /api/usage POST endpoint — callers (e.g. apps using Gemini) fire-and-forget
 *  a usage report after each API call. The worker computes cost from its
 *  pricing table and records to usage_log; thresholds fire next cron tick.
 *
 *  Request body:
 *    {
 *      provider: 'gemini' | 'openai' | 'anthropic' | string,
 *      model: string,                  // model identifier
 *      input_tokens: number,           // prompt tokens
 *      output_tokens: number,          // completion/generated tokens
 *      tag?: string,                   // optional caller-supplied tag (per-app/feature)
 *      ts?: number                     // optional ms-epoch override (default: now)
 *    }
 *
 *  No auth: apps shouldn't need a token to report their own spend. Abuse is
 *  bounded by Cloudflare's per-request rate limits at the zone level.
 *
 *  Response:
 *    200 { ok: true, cost_micros, cost_usd, model, provider }
 *    400 on invalid payload or unknown model
 *    500 on storage failure (caller can retry; cost is rounded so duplicates
 *        slightly inflate spend — design accepts this) */

import { costMicrosGemini, type MergedPricing } from './pricing';
import { recordUsage } from './store';

interface UsageBody {
  provider?: unknown;
  model?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  tag?: unknown;
  ts?: unknown;
}

function bad(msg: string, status = 400): Response {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v;
}

export async function handleUsagePost(
  request: Request,
  db: D1Database | undefined,
  pricing: MergedPricing,
): Promise<Response> {
  if (request.method !== 'POST') return bad('POST required', 405);

  let body: UsageBody;
  try {
    body = (await request.json()) as UsageBody;
  } catch {
    return bad('Body must be JSON');
  }

  const provider = typeof body.provider === 'string' ? body.provider : null;
  const model = typeof body.model === 'string' ? body.model : null;
  const inputTokens = isInt(body.input_tokens) ? body.input_tokens : null;
  const outputTokens = isInt(body.output_tokens) ? body.output_tokens : null;
  const tag = typeof body.tag === 'string' ? body.tag : null;
  const ts = isInt(body.ts) ? (body.ts as number) : Date.now();

  if (!provider) return bad('provider required (string)');
  if (!model) return bad('model required (string)');
  if (inputTokens === null) return bad('input_tokens required (non-negative integer)');
  if (outputTokens === null) return bad('output_tokens required (non-negative integer)');
  if (inputTokens < 0 || outputTokens < 0) return bad('token counts must be non-negative');

  // Only Gemini supported in v1. Reject unknown providers explicitly rather
  // than silently recording zero cost (would hide config bugs).
  if (provider !== 'gemini') {
    return bad(`provider '${provider}' not configured — add pricing in src/cost/pricing.ts`);
  }
  if (!pricing.gemini[model]) {
    return bad(`unknown model '${model}' — add pricing in src/cost/pricing.ts`);
  }

  const costMicros = costMicrosGemini(pricing.gemini, model, BigInt(inputTokens), BigInt(outputTokens));

  // Record one row capturing total tokens. We could split into input/output
  // rows if we ever want to slice the dashboard that way; for now combined
  // is fine — model field stays specific.
  await recordUsage(db, {
    provider,
    resource: 'tokens',
    model,
    source: 'push',
    tag,
    countUnits: BigInt(inputTokens + outputTokens),
    costMicros,
    timestamp: ts,
  });

  return new Response(
    JSON.stringify({
      ok: true,
      cost_micros: costMicros.toString(),
      cost_usd: Number(costMicros) / 1_000_000,
      model,
      provider,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}
