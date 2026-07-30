/** Hourly poller for Cloudflare GraphQL Analytics. Pulls account-level
 *  usage for the previous full hour and writes one usage_log row per
 *  resource. Runs from the cron handler gated to scheduledMinute === 1
 *  (one minute after the hour, after CF's ~5-min ingestion delay should
 *  not affect last-full-hour data). */

import { costMicrosCloudflare, type MergedPricing } from './pricing';
import { recordUsageBatch, type UsageRow } from './store';

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

interface GraphQLResponse<T> {
  data: T | null;
  errors?: { message: string; path?: string[]; extensions?: unknown }[];
}

interface AnalyticsData {
  viewer: {
    accounts: Array<{
      workersInvocationsAdaptive: Array<{ sum: { requests: number; subrequests: number; errors: number } }>;
      d1AnalyticsAdaptiveGroups: Array<{
        sum: { readQueries: number; writeQueries: number; rowsRead: number; rowsWritten: number };
      }>;
      kvOperationsAdaptiveGroups: Array<{ sum: { requests: number }; dimensions: { actionType: string } }>;
      r2OperationsAdaptiveGroups: Array<{ sum: { requests: number }; dimensions: { actionType: string } }>;
    }>;
  };
}

const QUERY = `
  query Usage($acc: String!, $since: Time!, $until: Time!) {
    viewer {
      accounts(filter: { accountTag: $acc }) {
        workersInvocationsAdaptive(
          filter: { datetime_geq: $since, datetime_lt: $until }
          limit: 10000
        ) {
          sum { requests subrequests errors }
        }
        d1AnalyticsAdaptiveGroups(
          filter: { datetime_geq: $since, datetime_lt: $until }
          limit: 10000
        ) {
          sum { readQueries writeQueries rowsRead rowsWritten }
        }
        kvOperationsAdaptiveGroups(
          filter: { datetime_geq: $since, datetime_lt: $until }
          limit: 10000
        ) {
          sum { requests }
          dimensions { actionType }
        }
        r2OperationsAdaptiveGroups(
          filter: { datetime_geq: $since, datetime_lt: $until }
          limit: 10000
        ) {
          sum { requests }
          dimensions { actionType }
        }
      }
    }
  }
`;

function isoHour(epochHourBucket: number): string {
  return new Date(epochHourBucket * 3_600_000).toISOString();
}

/** Sum an array of `{ sum: { [field]: number } }` rows down to a single bigint. */
function sumField<T extends Record<string, number>>(rows: Array<{ sum: T }>, field: keyof T): bigint {
  let total = 0n;
  for (const r of rows) total += BigInt(r.sum[field] ?? 0);
  return total;
}

/** Map CF KV action types to our resource keys.
 *    'read' / 'list' → 'kv.reads', 'write' / 'delete' → 'kv.writes' */
function bucketKvOps(rows: AnalyticsData['viewer']['accounts'][0]['kvOperationsAdaptiveGroups']): {
  reads: bigint;
  writes: bigint;
} {
  let reads = 0n;
  let writes = 0n;
  for (const r of rows) {
    const n = BigInt(r.sum.requests ?? 0);
    const action = r.dimensions.actionType?.toLowerCase() ?? '';
    if (action === 'read' || action === 'list') reads += n;
    else if (action === 'write' || action === 'delete') writes += n;
    // Unknown action types are skipped — surface via metrics later if needed
  }
  return { reads, writes };
}

/** Map CF R2 action types to Class A (write/list/delete) vs Class B (read/head). */
function bucketR2Ops(rows: AnalyticsData['viewer']['accounts'][0]['r2OperationsAdaptiveGroups']): {
  classA: bigint;
  classB: bigint;
} {
  const CLASS_A = new Set([
    'PutObject',
    'CopyObject',
    'CompleteMultipartUpload',
    'CreateMultipartUpload',
    'UploadPart',
    'ListObjects',
    'ListBuckets',
    'PutBucket',
    'DeleteObject',
    'DeleteBucket',
  ]);
  const CLASS_B = new Set(['GetObject', 'HeadObject', 'HeadBucket', 'UsageSummary']);
  let classA = 0n;
  let classB = 0n;
  for (const r of rows) {
    const n = BigInt(r.sum.requests ?? 0);
    const action = r.dimensions.actionType ?? '';
    if (CLASS_A.has(action)) classA += n;
    else if (CLASS_B.has(action)) classB += n;
    // Unknown actions skipped
  }
  return { classA, classB };
}

/** Fetch the previous full hour from CF GraphQL Analytics and record one
 *  usage_log row per resource (with that hour's start timestamp). */
export async function pollCloudflareUsage(
  db: D1Database | undefined,
  cfAnalyticsToken: string,
  cfAccountId: string,
  pricing: MergedPricing,
): Promise<{ rowsRecorded: number; hourBucketPolled: number }> {
  // Target the previous full hour. If now=14:01, query [13:00, 14:00).
  const now = Date.now();
  const currentHourBucket = Math.floor(now / 3_600_000);
  const targetHourBucket = currentHourBucket - 1;
  const since = isoHour(targetHourBucket);
  const until = isoHour(currentHourBucket);

  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfAnalyticsToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { acc: cfAccountId, since, until } }),
  });
  if (!res.ok) throw new Error(`Cloudflare GraphQL HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as GraphQLResponse<AnalyticsData>;
  if (body.errors?.length) throw new Error(`Cloudflare GraphQL errors: ${JSON.stringify(body.errors)}`);
  const account = body.data?.viewer.accounts[0];
  if (!account) throw new Error('Cloudflare GraphQL: no account in response');

  const workersRequests = sumField(account.workersInvocationsAdaptive, 'requests');
  const d1RowsRead = sumField(account.d1AnalyticsAdaptiveGroups, 'rowsRead');
  const d1RowsWritten = sumField(account.d1AnalyticsAdaptiveGroups, 'rowsWritten');
  const { reads: kvReads, writes: kvWrites } = bucketKvOps(account.kvOperationsAdaptiveGroups);
  const { classA: r2A, classB: r2B } = bucketR2Ops(account.r2OperationsAdaptiveGroups);

  // Build one row per non-zero resource. Skip zero-cost lines to keep table tidy.
  const ts = targetHourBucket * 3_600_000;
  const rows: UsageRow[] = [];
  const push = (resource: string, count: bigint) => {
    if (count <= 0n) return;
    rows.push({
      provider: 'cloudflare',
      resource,
      source: 'graphql',
      countUnits: count,
      costMicros: costMicrosCloudflare(pricing.cloudflare, resource, count),
      timestamp: ts,
    });
  };
  push('workers.requests', workersRequests);
  push('d1.rows_read', d1RowsRead);
  push('d1.rows_written', d1RowsWritten);
  push('kv.reads', kvReads);
  push('kv.writes', kvWrites);
  push('r2.class_a_operations', r2A);
  push('r2.class_b_operations', r2B);

  await recordUsageBatch(db, rows);
  return { rowsRecorded: rows.length, hourBucketPolled: targetHourBucket };
}
