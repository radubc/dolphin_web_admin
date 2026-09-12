import "server-only";
/**
 * The two customer figures the Overview draws that `customerHeadline()` does
 * not cover: the invitation funnel and the largest tenants.
 *
 * Both are compositions of accessors the Customers feature already owns —
 * `accountCensus()` and `funnelProgress()` for the funnel, `largestTenants()`
 * for the table — assembled exactly as
 * `src/lib/customers/statistics.ts` assembles them for the Activity view, so
 * the two screens cannot disagree. **That file is the definition of record**
 * for what "invited", "onboarded" and the rest mean; this one only asks for
 * the cheap subset a dashboard card can afford. The full statistics read is
 * a dozen queries and several monthly series, which is a page's worth of work
 * and not a card's.
 *
 * Both throw whatever the database throws; the Overview loads them inside
 * `Promise.allSettled`, so a failure costs one card.
 */
import { accountCensus } from "@/lib/customers/lifecycle";
import { funnelProgress, largestTenants } from "@/lib/customers/repository";
import type { CustomerFunnel, TenantSize } from "@/lib/customers/types";

/** How many tenants the Overview's card lists. The Activity view shows ten. */
export const OVERVIEW_TENANTS_LIMIT = 5;

/**
 * The funnel: invited and confirmed from the newest Cognito snapshot,
 * onboarded and after from the main app database.
 *
 * Two queries' worth of work (a grouped count of one snapshot day, and one
 * aggregate over `user_tenants`). The first two steps are zero with a
 * `snapshotDay` of `null` until the nightly `cognito_directory` job has run,
 * which the card says out loud rather than drawing as a measurement.
 */
export async function overviewFunnel(): Promise<CustomerFunnel> {
  const [accounts, progress] = await Promise.all([accountCensus(), funnelProgress()]);
  return {
    invited: accounts.total,
    confirmed: accounts.byStatus.confirmed ?? 0,
    onboarded: progress.onboarded,
    firstTransaction: progress.firstTransaction,
    firstAttachment: progress.firstAttachment,
    snapshotDay: accounts.snapshotDay,
  };
}

/**
 * The biggest tenants by attachment bytes, largest first.
 *
 * Bytes rather than transactions: a row count is cheap to hold and a
 * multi-gigabyte attachment pile is the thing that costs money and needs a
 * retention conversation. The Activity view shows both rankings.
 */
export async function overviewLargestTenants(
  limit: number = OVERVIEW_TENANTS_LIMIT,
): Promise<TenantSize[]> {
  const { byBytes } = await largestTenants(limit);
  return byBytes.map((row) => ({
    tenantId: row.tenantId,
    name: row.name,
    bytes: row.bytes,
    transactions: row.transactions,
  }));
}
