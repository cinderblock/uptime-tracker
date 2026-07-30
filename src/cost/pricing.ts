/** Provider pricing tables.
 *
 *  Cloudflare resources are priced "$X per million units" — but a single unit
 *  is often sub-micro (a Workers request is $0.0000003 = 0.3 nano-USD). To stay
 *  in integer bigint space, we store **price-per-million-units in micro-USD**:
 *
 *    cost_micros = (count × pricePerMillionMicros) / 1_000_000n
 *
 *  e.g. $0.30 per M requests → pricePerMillionMicros = 300_000n; one request
 *  costs 0n micros (correctly — below sub-micro precision), one million costs
 *  300_000n micros = $0.30. No float, no drift.
 */

export type PricePerMillionMicros = bigint;

const ONE_MILLION = 1_000_000n;

/** Convert "$/M units" → micros per million units. */
function perM(dollars: number): PricePerMillionMicros {
  return BigInt(Math.round(dollars * 1_000_000));
}

/** Cloudflare per-resource pricing (Workers Paid plan, as of 2026-05).
 *  Keyed by the same `resource` strings we write into `usage_log.resource`. */
export const CLOUDFLARE_PRICING: Record<string, PricePerMillionMicros> = {
  'workers.requests': perM(0.3),
  'workers.cpu_ms': perM(0.02),
  'd1.rows_read': perM(0.001), // $1/B = $0.001/M
  'd1.rows_written': perM(1.0),
  'kv.reads': perM(0.5),
  'kv.writes': perM(5.0),
  'r2.class_a_operations': perM(4.5),
  'r2.class_b_operations': perM(0.36),
};

/** Gemini pricing — input/output token cost per million tokens, by model.
 *  Values from ai.google.dev/pricing as of 2026-05; KV `pricing:override`
 *  lets us patch without a redeploy when Google adjusts. */
export const GEMINI_PRICING: Record<string, { input: PricePerMillionMicros; output: PricePerMillionMicros }> = {
  'gemini-2.5-pro': { input: perM(1.25), output: perM(10.0) },
  'gemini-2.5-flash': { input: perM(0.3), output: perM(2.5) },
  'gemini-2.5-flash-lite': { input: perM(0.1), output: perM(0.4) },
  'gemini-2.0-flash': { input: perM(0.1), output: perM(0.4) },
  'gemini-2.0-flash-lite': { input: perM(0.075), output: perM(0.3) },
};

export interface PricingOverride {
  /** Cloudflare values in $/M (same units as defaults). */
  cloudflare?: Partial<Record<string, number>>;
  /** Gemini values in $/M tokens (same units as defaults). */
  gemini?: Partial<Record<string, { input?: number; output?: number }>>;
}

export interface MergedPricing {
  cloudflare: Record<string, PricePerMillionMicros>;
  gemini: Record<string, { input: PricePerMillionMicros; output: PricePerMillionMicros }>;
}

/** Layer KV override JSON onto the static tables. */
export function mergePricing(override: PricingOverride | null): MergedPricing {
  const cloudflare = { ...CLOUDFLARE_PRICING };
  if (override?.cloudflare) {
    for (const [key, dollars] of Object.entries(override.cloudflare)) {
      if (dollars === undefined) continue;
      cloudflare[key] = perM(dollars);
    }
  }
  const gemini: Record<string, { input: PricePerMillionMicros; output: PricePerMillionMicros }> = {};
  for (const [model, vals] of Object.entries(GEMINI_PRICING)) gemini[model] = { ...vals };
  if (override?.gemini) {
    for (const [model, vals] of Object.entries(override.gemini)) {
      if (!vals) continue;
      const base = gemini[model] ?? { input: 0n, output: 0n };
      gemini[model] = {
        input: vals.input !== undefined ? perM(vals.input) : base.input,
        output: vals.output !== undefined ? perM(vals.output) : base.output,
      };
    }
  }
  return { cloudflare, gemini };
}

/** Compute cost in micro-USD for a Cloudflare resource × count. */
export function costMicrosCloudflare(pricing: MergedPricing['cloudflare'], resource: string, count: bigint): bigint {
  const ppm = pricing[resource];
  if (ppm === undefined) throw new Error(`Unknown Cloudflare pricing resource: ${resource}`);
  return (count * ppm) / ONE_MILLION;
}

/** Compute cost in micro-USD for Gemini input + output tokens. */
export function costMicrosGemini(
  pricing: MergedPricing['gemini'],
  model: string,
  inputTokens: bigint,
  outputTokens: bigint,
): bigint {
  const p = pricing[model];
  if (!p) throw new Error(`Unknown Gemini model pricing: ${model}`);
  return (p.input * inputTokens + p.output * outputTokens) / ONE_MILLION;
}
