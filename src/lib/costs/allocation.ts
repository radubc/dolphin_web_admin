import "server-only";
/**
 * Cost per client: how the month's AWS bill is divided over the tenants, and
 * everything that reads or writes `admin_tenant_cost_monthly`.
 *
 * **This is an allocation, not a bill, and it cannot be anything else.** AWS
 * charges per *resource*: the two ECS services, the RDS instance, the load
 * balancer, NAT, WAF, Route 53, Secrets Manager and the log groups are each
 * one resource shared by every tenant, and no API — not Cost Explorer, not
 * CUR 2.0 — can say which row of a shared database cost what. There is no
 * per-tenant cost allocation tag and there cannot be one: tenants are rows,
 * not resources. The only genuinely per-tenant measurement in the account is
 * S3 storage under `tenants/<tenantId>/files/`, and even that is cheaper to
 * read from `file_blobs.byte_size` than to buy from S3 Storage Lens.
 *
 * So the month's cached cost (from `admin_cost_daily`, which the `aws_costs`
 * job fills) is split into four **pools** by what drives each service's
 * spend, and each pool is divided over the tenants by a driver that is
 * actually measured:
 *
 * | Pool | Services | Driver |
 * | --- | --- | --- |
 * | fixed | shared capacity: ECS, RDS, ELB, NAT/EBS, WAF, Route 53, Secrets Manager, CloudWatch, **and anything unrecognised** | activity weight (requests + sync rows), with a floor every tenant still live at the end of the month gets first |
 * | storage | S3 | attachment bytes + an estimated row footprint |
 * | request | data transfer | requests |
 * | user | Cognito | distinct active users in the month |
 *
 * Three decisions worth stating, because they are what make the figure
 * defensible rather than merely plausible:
 *
 * - **Unknown services go to the fixed pool.** A new AWS service appearing on
 *   the bill must not vanish from the allocation, and "shared capacity split
 *   by how much each tenant used the product" is the least wrong assumption
 *   available for something we know nothing about. {@link classifyService}
 *   says so out loud rather than silently dropping the line.
 * - **A dormant tenant is not free.** The capacity was provisioned for them,
 *   and a strictly usage-proportional split would hand the whole bill to the
 *   busiest household and tell us a dormant one costs nothing. Every tenant
 *   still live at the end of the month therefore gets `fixedFloorShare` of
 *   the fixed pool before the remainder is split by activity — and the floors
 *   together are capped at {@link FIXED_FLOOR_POOL_SHARE_MAX} of the pool, so
 *   the measurement always decides at least half of it.
 * - **The arithmetic is exact.** Each pool is divided in integer
 *   micro-dollars with a largest-remainder pass, so the tenants' components
 *   sum to the pool to the micro-dollar. A per-client column that does not
 *   add up to the bill invites exactly the wrong conversation.
 *
 * The pure functions ({@link classifyService}, {@link poolsFromServices},
 * {@link distributeMicro}, {@link allocateMonth}) are separated from every
 * database call on purpose: they *are* the model, and they are worth being
 * able to read, and check by hand, without two databases in the way. The
 * repository half below reads `admin_cost_daily` (admin database) and the
 * consumer app's usage tables (main database, read-only) and writes the one
 * table this feature owns.
 *
 * The table may not exist yet (`docs/sql/015_cost_allocation.sql` is run by
 * hand). Prisma's P2021 is deliberately **not** caught here, so
 * `adminHandler` renders it as 503 `admin_schema_missing` like every other
 * feature, and the job fails with a message naming the file.
 *
 * The model, with its constants and its honest caveats, is
 * `docs/cost-allocation.md`.
 */
import type { Prisma } from "@/generated/prisma-admin/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { prismaAdmin } from "@/lib/prisma-admin";
import {
  endOfMonth,
  monthOf,
  shiftDay,
  shiftMonth,
  toDateColumn,
  todayUtc,
  type IsoDay,
  type IsoMonth,
} from "./calendar";
// Only the one this module's own arithmetic clamps to; the other three are
// re-exported below for the callers that name this module.
import { FIXED_FLOOR_SHARE_MAX } from "./types";

/* -------------------------------------------------------------------------- */
/*                                 Constants                                  */
/* -------------------------------------------------------------------------- */

/** The integration key whose nightly run writes the allocation. */
export const ALLOCATION_INTEGRATION_KEY = "allocate_costs";

/**
 * The run's two settings and their bounds live in `./types.ts`, which is
 * plain data and safe to import anywhere: the Integrations drawer is a Client
 * Component and has to draw the same minima, maxima and defaults the server
 * validates against. They are re-exported here because this is where the
 * allocator that uses them lives, and every existing importer names this
 * module.
 */
export {
  ALLOCATION_MONTHS_DEFAULT,
  ALLOCATION_MONTHS_MAX,
  FIXED_FLOOR_SHARE_DEFAULT,
  FIXED_FLOOR_SHARE_MAX,
} from "./types";

/**
 * The database footprint charged to a tenant per live `transactions` row, as
 * a stand-in for "how much of the RDS volume is yours".
 *
 * **An estimate, and the only invented number in the model.** 512 bytes is
 * the order of magnitude of one row of the consumer app's widest hot table
 * once its indexes are counted; the true figure depends on fill factor, TOAST
 * and how many of the other twenty tenant tables the household uses. It is
 * here because storage cost allocated on attachments alone would say a tenant
 * with 50 000 transactions and no receipts costs nothing to store, which is
 * plainly false. Transactions are the one table that grows with use in every
 * household, so they are the proxy; the constant is deliberately a single
 * named value so that changing it is one edit and one line in
 * `docs/cost-allocation.md`.
 */
export const TRANSACTION_ROW_BYTES = 512;

/**
 * The most of the fixed pool every floor **together** may take: half.
 *
 * The floor exists so a dormant tenant does not read as free. It must not
 * turn the allocation into a headcount, and with enough dormant tenants the
 * operator's `fixedFloorShare` would do exactly that: 150 tenants at half a
 * percent each is 75 % of the shared capacity handed out before a single
 * measurement is looked at. Capping the floors at half the pool guarantees
 * that **at least half of the shared capacity is always split by activity**,
 * whatever the setting and however many tenants there are. When the cap
 * binds, every eligible tenant's floor shrinks equally
 * (`0.5 / eligible tenants`), so the ranking the measurement produces is
 * untouched.
 */
export const FIXED_FLOOR_POOL_SHARE_MAX = 0.5;

/**
 * The largest `share_pct` the column can hold: `NUMERIC(7,4)` is three digits
 * before the point and four after, so ±999.9999.
 *
 * A share above 100 % is not a bug to hide: a month whose cached bill has
 * been revised downwards since the allocation was written can genuinely put a
 * tenant above the total. A share can also go **negative**, in a month where
 * one pool is a credit and another is spend and the tenant's total ends up
 * with the opposite sign to the month's. (A wholly negative month is a ratio
 * of two negatives, so its shares read positive.) Clamping keeps the write
 * from failing with a numeric overflow — which would lose the whole month —
 * while the figure still reads as obviously extraordinary.
 */
export const SHARE_PCT_MAX = 999.9999;

/** Micro-dollars per dollar. The allocation's unit of account. */
const MICRO = 1_000_000;

/* -------------------------------------------------------------------------- */
/*                                 The pools                                  */
/* -------------------------------------------------------------------------- */

/** Which driver a service's cost is divided by. */
export type CostPool = "fixed" | "storage" | "request" | "user";

/**
 * Cost Explorer's `SERVICE` dimension values, mapped to a pool.
 *
 * The keys are AWS's exact strings, which is what `admin_cost_daily.service`
 * holds (`EC2 - Other`, spaces and all). Matching is case-insensitive and
 * falls back to the substring rules in {@link classifyService}, so a name AWS
 * rewords slightly still lands in the right pool.
 *
 * Every service in the three CloudFormation stacks is listed, whether or not
 * it has ever appeared on a bill, so the map reads as the inventory it is.
 */
export const SERVICE_POOLS: Readonly<Record<string, CostPool>> = {
  /* ---------------------------- Shared capacity --------------------------- */
  // The two Fargate services. Task hours, whoever is using them.
  "amazon elastic container service": "fixed",
  "aws fargate": "fixed",
  "amazon elastic container registry (ecr)": "fixed",
  "amazon ec2 container registry (ecr)": "fixed",
  // NAT gateway hours and data processing, EBS volumes, public IPv4 — all of
  // it shared, and none of it attributable.
  "ec2 - other": "fixed",
  "amazon elastic compute cloud - compute": "fixed",
  "amazon virtual private cloud": "fixed",
  "elastic load balancing": "fixed",
  // The instance *and* its storage. Cost Explorer's SERVICE dimension does
  // not separate RDS instance hours from allocated storage — that needs the
  // USAGE_TYPE dimension, which would be a second $0.01 request a day — so
  // RDS goes to the fixed pool whole. It is the one deliberate simplification
  // in the map: the volume is provisioned at a fixed size, so treating it as
  // capacity is closer to the truth than splitting it by bytes would be.
  "amazon relational database service": "fixed",
  "aws waf": "fixed",
  "amazon route 53": "fixed",
  "aws secrets manager": "fixed",
  "aws certificate manager": "fixed",
  "aws key management service": "fixed",
  amazoncloudwatch: "fixed",
  "aws cloudtrail": "fixed",
  "aws cost explorer": "fixed",
  "aws budgets": "fixed",
  "amazon simple notification service": "fixed",
  "aws systems manager": "fixed",
  "amazon ec2 container service": "fixed",
  "aws lambda": "fixed",
  tax: "fixed",

  /* -------------------------------- Storage ------------------------------- */
  // The only service with a genuinely per-tenant footprint: attachments live
  // under tenants/<tenantId>/files/.
  "amazon simple storage service": "storage",
  "amazon s3 glacier": "storage",
  "amazon elastic file system": "storage",
  "aws backup": "storage",

  /* ------------------------------ Per request ----------------------------- */
  // Bytes shipped in and out. Usually absent from this account's bill: the
  // traffic is small enough to sit inside the free allowance, and what is
  // charged arrives inside "EC2 - Other" instead. Kept so the day it appears
  // it is divided by requests rather than landing in shared capacity.
  "aws data transfer": "request",
  "amazon cloudfront": "request",
  "amazon api gateway": "request",

  /* ------------------------------- Per user ------------------------------- */
  // Cognito bills per monthly active user, which is the one AWS charge that
  // really is per person.
  "amazon cognito": "user",
  "amazon cognito user pools": "user",
};

/**
 * Substring rules applied when the exact name is unknown, in order.
 *
 * They catch the two ways AWS names drift — a service being renamed, and a
 * regional or tiered variant — without pretending to a precision the map does
 * not have.
 */
const POOL_PATTERNS: readonly { match: string; pool: CostPool }[] = [
  { match: "simple storage service", pool: "storage" },
  { match: "s3", pool: "storage" },
  { match: "cognito", pool: "user" },
  { match: "data transfer", pool: "request" },
  { match: "cloudfront", pool: "request" },
];

/**
 * Which pool a service's spend belongs to.
 *
 * **An unrecognised service is `fixed`.** That is the whole reason this
 * function exists rather than a bare lookup: a new line on the bill has to be
 * allocated somewhere, and dropping it would quietly make the per-client
 * figures add up to less than the invoice. "Shared capacity, split by how
 * much each tenant used the product" is the least wrong thing to assume about
 * a service we know nothing about — and the Cost center's by-service table is
 * where an operator notices the new name and adds it to
 * {@link SERVICE_POOLS}.
 */
export function classifyService(service: string): CostPool {
  const key = service.trim().toLowerCase();
  const exact = SERVICE_POOLS[key];
  if (exact !== undefined) return exact;
  for (const rule of POOL_PATTERNS) {
    if (key.includes(rule.match)) return rule.pool;
  }
  return "fixed";
}

/** The four pool totals for a month, in USD. */
export interface MonthPools {
  fixedUsd: number;
  storageUsd: number;
  requestUsd: number;
  userUsd: number;
}

const EMPTY_POOLS: MonthPools = { fixedUsd: 0, storageUsd: 0, requestUsd: 0, userUsd: 0 };

/** The month's cost by service, folded into the four pools. */
export function poolsFromServices(
  rows: readonly { service: string; amountUsd: number }[],
): MonthPools {
  const pools: MonthPools = { ...EMPTY_POOLS };
  for (const row of rows) {
    switch (classifyService(row.service)) {
      case "storage":
        pools.storageUsd += row.amountUsd;
        break;
      case "request":
        pools.requestUsd += row.amountUsd;
        break;
      case "user":
        pools.userUsd += row.amountUsd;
        break;
      default:
        pools.fixedUsd += row.amountUsd;
    }
  }
  return pools;
}

/** The sum of the four pools: the month's whole bill, as cached. */
export function poolsTotal(pools: MonthPools): number {
  return pools.fixedUsd + pools.storageUsd + pools.requestUsd + pools.userUsd;
}

/* -------------------------------------------------------------------------- */
/*                            The drivers per tenant                          */
/* -------------------------------------------------------------------------- */

/** What one tenant did in a month, as far as anything measures it. */
export interface TenantDrivers {
  tenantId: string;
  /** `tenants.name`; null when the tenant row is gone but its data is not. */
  name: string | null;
  /** True when the tenant row is soft-deleted now. */
  deleted: boolean;
  /**
   * True when the tenant was still live at the **end of the month's window**.
   *
   * Only these carry the fixed pool's floor. A tenant deleted during the
   * month keeps every share its measured drivers earn it — the requests were
   * made and the capacity was used — but it is not charged a floor for
   * capacity that was standing by for it after it was gone. (A tenant deleted
   * *after* the month is live at that month's end, and does carry the floor.)
   */
  liveAtMonthEnd: boolean;
  /** `usage_daily.requests` for the month. */
  requests: number;
  /** `usage_daily.sync_rows` for the month. */
  syncRows: number;
  /**
   * Live attachment bytes plus {@link TRANSACTION_ROW_BYTES} per live
   * transaction row. **Current**, not historical: neither table keeps the
   * size it had in June.
   */
  storageBytes: number;
  /** Distinct users seen, or recording usage, inside the month. */
  activeUsers: number;
}

/**
 * What the tenants hold today, read once and reused for every month of a run.
 *
 * Both maps are keyed by tenant id and hold zero-less entries: a tenant with
 * no attachments and no transactions is simply absent.
 */
export interface TenantStorageNow {
  /** Live `file_blobs.byte_size` per tenant. */
  bytes: Map<string, number>;
  /** Live `transactions` rows per tenant. */
  transactionRows: Map<string, number>;
}

/**
 * The weight the fixed pool's remainder is split by: `requests + syncRows`.
 *
 * One definition, in one function, so the allocator, the job and the stored
 * `activity_weight` column cannot drift apart. A sync row is counted the same
 * as a request because both are one trip through the same containers and the
 * same database connection; if that ever stops being true, this is the only
 * line that changes.
 */
export function activityWeightOf(
  drivers: Pick<TenantDrivers, "requests" | "syncRows">,
): number {
  return drivers.requests + drivers.syncRows;
}

/** One tenant's allocated estimate for a month, in USD. */
export interface TenantAllocation {
  tenantId: string;
  fixedUsd: number;
  storageUsd: number;
  requestUsd: number;
  userUsd: number;
  totalUsd: number;
  /** `totalUsd` as a percentage of the month's whole bill, 0..100. */
  sharePct: number;
  /** `requests + syncRows`, the weight the fixed remainder was split by. */
  activityWeight: number;
  storageBytes: number;
  requests: number;
  activeUsers: number;
}

/** What {@link allocateMonth} answers. */
export interface MonthAllocation {
  month: IsoMonth;
  pools: MonthPools;
  /** The sum of the pools: the month's bill as cached. */
  monthTotalUsd: number;
  /** What the tenants were given, to the micro-dollar. */
  allocatedUsd: number;
  /**
   * The rest: pools whose driver was zero for every tenant (no attachments
   * anywhere, nobody signed in) and, when there are no tenants at all, the
   * whole bill. Shown rather than smeared over the tenants, because "nobody
   * used the storage we are paying for" is a fact worth seeing.
   */
  unallocatedUsd: number;
  tenants: TenantAllocation[];
}

/* -------------------------------------------------------------------------- */
/*                               The arithmetic                               */
/* -------------------------------------------------------------------------- */

/** USD to whole micro-dollars. */
function toMicro(usd: number): number {
  return Math.round(usd * MICRO);
}

/** Whole micro-dollars back to USD, exactly as the column stores it. */
function fromMicro(micro: number): number {
  return micro / MICRO;
}

/**
 * A percentage as `share_pct` can store it: four decimals, and inside
 * ±{@link SHARE_PCT_MAX} so a `NUMERIC(7,4)` write can never overflow.
 *
 * The clamp is a guard, not arithmetic: it only engages when a tenant's total
 * is more than ten times the month's whole bill, which takes a bill revised
 * downwards (or a credit turning the month negative) after the allocation was
 * written. Losing a whole month's rows to a numeric overflow would be a far
 * worse answer than an obviously extraordinary percentage.
 */
function clampSharePct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  const rounded = Math.round(pct * 10_000) / 10_000;
  return Math.min(SHARE_PCT_MAX, Math.max(-SHARE_PCT_MAX, rounded));
}

/**
 * Divides `totalMicro` over `weights`, so that the parts sum to
 * `totalMicro` **exactly**.
 *
 * Each part gets the floor of its proportional share, and the units the
 * flooring left over go to the largest fractional remainders — the
 * largest-remainder (Hamilton) method. Ties break towards the earlier index,
 * which makes the answer deterministic for a given tenant order; the callers
 * order tenants by id, so a re-run reproduces the same split rather than
 * moving a cent between two identical tenants.
 *
 * A total of zero, or weights that do not sum to anything positive, gives all
 * zeros: the caller then reports the pool as unallocated rather than
 * inventing a split. Negative weights are treated as zero — a driver cannot
 * be negative, and quietly flipping one would corrupt every other share.
 */
export function distributeMicro(
  totalMicro: number,
  weights: readonly number[],
): number[] {
  const safe = weights.map((weight) =>
    Number.isFinite(weight) && weight > 0 ? weight : 0,
  );
  const sum = safe.reduce((total, weight) => total + weight, 0);
  const parts = safe.map(() => 0);
  if (sum <= 0 || totalMicro === 0 || !Number.isFinite(totalMicro)) return parts;

  const remainders: { index: number; remainder: number }[] = [];
  let assigned = 0;
  for (let index = 0; index < safe.length; index += 1) {
    // The share is normalised first so the product stays well inside the
    // exact-integer range: `totalMicro * weight` with a byte count for a
    // weight would not.
    const exact = totalMicro * (safe[index] / sum);
    const floor = Math.floor(exact);
    parts[index] = floor;
    assigned += floor;
    remainders.push({ index, remainder: exact - floor });
  }

  // `totalMicro - assigned` is in [0, weights.length) by construction, for a
  // positive total and for a negative one alike (flooring always rounds down).
  let left = totalMicro - assigned;
  remainders.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const entry of remainders) {
    if (left <= 0) break;
    parts[entry.index] += 1;
    left -= 1;
  }
  return parts;
}

/**
 * The whole model in one function: the month's pools plus the tenants'
 * drivers, in, and every tenant's allocated estimate out.
 *
 * Pure — no clock, no database — so it can be checked by hand, and is.
 *
 * How each pool is divided:
 *
 * - **fixed**: every tenant still live at the end of the month is first
 *   given `fixedFloorShare` of the pool — capped so the floors together take
 *   at most {@link FIXED_FLOOR_POOL_SHARE_MAX} of it — and the remainder is
 *   split by `requests + syncRows` over **every** tenant, floor or no floor.
 *   With no activity anywhere the remainder is split equally, which is the
 *   only defensible answer when nothing distinguishes the tenants.
 * - **storage**: by `storageBytes`.
 * - **request**: by `requests`.
 * - **user**: by `activeUsers`. A tenant nobody signed in to gets nothing
 *   from it, because Cognito charged nothing for them.
 *
 * A pool whose driver is zero for every tenant is left undivided and lands in
 * `unallocatedUsd`.
 */
export function allocateMonth(input: {
  month: IsoMonth;
  pools: MonthPools;
  tenants: readonly TenantDrivers[];
  fixedFloorShare: number;
}): MonthAllocation {
  const { month, pools } = input;
  const tenants = [...input.tenants].sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  const monthTotalMicro =
    toMicro(pools.fixedUsd) +
    toMicro(pools.storageUsd) +
    toMicro(pools.requestUsd) +
    toMicro(pools.userUsd);
  const monthTotalUsd = fromMicro(monthTotalMicro);

  if (tenants.length === 0) {
    return {
      month,
      pools,
      monthTotalUsd,
      allocatedUsd: 0,
      unallocatedUsd: monthTotalUsd,
      tenants: [],
    };
  }

  const count = tenants.length;
  // The floor is for capacity that was standing by for a tenant, so only a
  // tenant that was still there at the end of the month pays one. The others
  // keep every share their measured drivers earn them.
  const floorEligible = tenants.map((tenant) => tenant.liveAtMonthEnd);
  const floorCount = floorEligible.reduce((total, eligible) => total + (eligible ? 1 : 0), 0);
  // Three caps: the operator's setting, the model's own ceiling, and
  // arithmetic — the floors together take at most half the pool, so at least
  // half of the shared capacity is always divided by measurement.
  const floor =
    floorCount === 0
      ? 0
      : Math.min(
          Math.max(0, input.fixedFloorShare),
          FIXED_FLOOR_SHARE_MAX,
          FIXED_FLOOR_POOL_SHARE_MAX / floorCount,
        );
  const remainderShare = 1 - floor * floorCount;
  const activity = tenants.map((tenant) => Math.max(0, activityWeightOf(tenant)));
  const activityTotal = activity.reduce((total, weight) => total + weight, 0);
  // Sums to 1 by construction: floorCount × floor, plus a remainder share
  // spread over every tenant by activity (or equally when there is none).
  const fixedWeights = activity.map(
    (weight, index) =>
      (floorEligible[index] === true ? floor : 0) +
      (activityTotal > 0 ? (remainderShare * weight) / activityTotal : remainderShare / count),
  );

  const fixed = distributeMicro(toMicro(pools.fixedUsd), fixedWeights);
  const storage = distributeMicro(
    toMicro(pools.storageUsd),
    tenants.map((tenant) => tenant.storageBytes),
  );
  const request = distributeMicro(
    toMicro(pools.requestUsd),
    tenants.map((tenant) => tenant.requests),
  );
  const user = distributeMicro(
    toMicro(pools.userUsd),
    tenants.map((tenant) => tenant.activeUsers),
  );

  let allocatedMicro = 0;
  const rows: TenantAllocation[] = tenants.map((tenant, index) => {
    const totalMicro =
      (fixed[index] ?? 0) + (storage[index] ?? 0) + (request[index] ?? 0) + (user[index] ?? 0);
    allocatedMicro += totalMicro;
    return {
      tenantId: tenant.tenantId,
      fixedUsd: fromMicro(fixed[index] ?? 0),
      storageUsd: fromMicro(storage[index] ?? 0),
      requestUsd: fromMicro(request[index] ?? 0),
      userUsd: fromMicro(user[index] ?? 0),
      totalUsd: fromMicro(totalMicro),
      sharePct:
        monthTotalMicro === 0 ? 0 : clampSharePct((totalMicro / monthTotalMicro) * 100),
      activityWeight: activityWeightOf(tenant),
      storageBytes: tenant.storageBytes,
      requests: tenant.requests,
      activeUsers: tenant.activeUsers,
    };
  });

  return {
    month,
    pools,
    monthTotalUsd,
    allocatedUsd: fromMicro(allocatedMicro),
    unallocatedUsd: fromMicro(monthTotalMicro - allocatedMicro),
    tenants: rows.sort((a, b) => b.totalUsd - a.totalUsd || a.tenantId.localeCompare(b.tenantId)),
  };
}

/* -------------------------------------------------------------------------- */
/*                                 The month                                  */
/* -------------------------------------------------------------------------- */

/** The window a month's figures are measured over. */
export interface MonthWindow {
  month: IsoMonth;
  /** The 1st, as a UTC day. */
  from: IsoDay;
  /**
   * The last day counted: the end of the month, or yesterday for the month in
   * progress. **Nothing is counted for today** — AWS has not totalled it, and
   * the driver window is kept to the same days as the cost window so a
   * tenant's share is measured over exactly the days it is charged for.
   */
  to: IsoDay;
  /** True when the window is empty: it is the 1st and nothing has settled. */
  empty: boolean;
}

/**
 * The window for one month, as measured at `now`.
 *
 * Every boundary comes from the `dayjs.utc` helpers in `./calendar`, which is
 * the one place this feature's day and month arithmetic lives: a month is not
 * 30 days and a `Date.UTC(year, month, 0)` is a puzzle where
 * `endOfMonth(day)` is a sentence.
 */
export function monthWindow(month: IsoMonth, now: Date = new Date()): MonthWindow {
  const yesterday = shiftDay(todayUtc(now), -1);
  const from = `${month}-01`;
  const monthEnd = endOfMonth(from);
  const to = monthEnd <= yesterday ? monthEnd : yesterday;
  return { month, from, to, empty: to < from };
}

/**
 * The `months` months ending with the one `now` falls in, oldest first.
 *
 * The current month is included and is deliberately partial: an allocation
 * that only covered finished months would be a month out of date for thirty
 * days at a time, and every surface labels the figure an estimate anyway.
 */
export function recentMonths(now: Date, months: number): IsoMonth[] {
  const current = monthOf(todayUtc(now));
  const list: IsoMonth[] = [];
  for (let back = months - 1; back >= 0; back -= 1) {
    list.push(shiftMonth(current, -back));
  }
  return list;
}

/* -------------------------------------------------------------------------- */
/*                        Reads: the month's pools (admin)                    */
/* -------------------------------------------------------------------------- */

/**
 * The month's cost by service from `admin_cost_daily`, by-service rows only
 * (`component IS NULL`).
 *
 * The by-component rows are deliberately excluded: they are the same money
 * counted a second way (the `Component` tag split), and adding them would
 * double the bill.
 */
export async function monthCostByService(
  window: MonthWindow,
): Promise<{ service: string; amountUsd: number }[]> {
  if (window.empty) return [];
  const groups = await prismaAdmin.admin_cost_daily.groupBy({
    by: ["service"],
    where: {
      day: { gte: toDateColumn(window.from), lte: toDateColumn(window.to) },
      component: null,
    },
    _sum: { amount_usd: true },
  });
  return groups.map((group) => ({
    service: group.service,
    amountUsd: group._sum.amount_usd === null ? 0 : Number(group._sum.amount_usd),
  }));
}

/** The month's four pool totals, ready for {@link allocateMonth}. */
export async function monthPools(window: MonthWindow): Promise<{
  pools: MonthPools;
  /** How many by-service rows the month has. Zero means aws_costs has not run. */
  services: number;
}> {
  const rows = await monthCostByService(window);
  return { pools: poolsFromServices(rows), services: rows.length };
}

/* -------------------------------------------------------------------------- */
/*                      Reads: the drivers (main app database)                */
/* -------------------------------------------------------------------------- */

/**
 * What every tenant holds **right now**: attachment bytes and live
 * transaction rows.
 *
 * Month-independent on purpose, and that is the whole reason it is its own
 * function. `file_blobs` and `transactions` keep no history, so the same two
 * aggregates answer for June and for September; reading them once per *run*
 * instead of once per *month* turns a fourteen-month backfill's 28 full-table
 * aggregates of the consumer app's two largest tables into 2.
 *
 * See `docs/cost-allocation.md`: a recomputed old month therefore moves as
 * data grows, which is why only the last couple of months are recomputed by
 * default.
 */
export async function tenantStorageNow(): Promise<TenantStorageNow> {
  const [blobs, transactions] = await Promise.all([
    prisma.file_blobs.groupBy({
      by: ["tenant_id"],
      where: { deleted_at: null },
      _sum: { byte_size: true },
    }),
    prisma.transactions.groupBy({
      by: ["tenant_id"],
      where: { deleted_at: null },
      _count: { tenant_id: true },
    }),
  ]);
  return {
    bytes: new Map(blobs.map((group) => [group.tenant_id, Number(group._sum.byte_size ?? 0)])),
    transactionRows: new Map(
      transactions.map((group) => [group.tenant_id, group._count.tenant_id]),
    ),
  };
}

/**
 * Every tenant the month concerns, with what it did.
 *
 * "Concerns" is live tenants **plus** tenants deleted during or after the
 * month: their usage that month was real and was paid for, and dropping them
 * would move their share onto everyone else after the fact. A tenant deleted
 * before the month began is not included and never had a row. Only the ones
 * still live at the end of the window carry the fixed pool's floor
 * (`liveAtMonthEnd`).
 *
 * Four aggregates per month, whatever the number of tenants, plus the two
 * month-independent ones {@link tenantStorageNow} answers — pass them in and
 * a multi-month run reads them once rather than per month.
 *
 * Two caveats, both in `docs/cost-allocation.md`:
 *
 * - **Storage is measured now, not then.** `file_blobs` and `transactions`
 *   hold what the tenant has today; neither keeps its size in June. A
 *   recomputed old month therefore moves as data grows, which is why only the
 *   last couple of months are recomputed by default.
 * - **Active users are a union of two facts**: a `users.last_seen_at` inside
 *   the month (the consumer app's sign-in stamp) or any `usage_daily` row in
 *   it. Either is evidence a person was there, and Cognito billed for them.
 */
export async function tenantDriversFor(
  window: MonthWindow,
  storage?: TenantStorageNow,
): Promise<TenantDrivers[]> {
  const from = toDateColumn(window.from);
  const to = toDateColumn(window.to);
  const monthStart = new Date(`${window.from}T00:00:00.000Z`);
  // Exclusive: the instant after the last day counted.
  const monthEnd = new Date(`${shiftDay(window.to, 1)}T00:00:00.000Z`);
  const dayRange = window.empty ? undefined : { gte: from, lte: to };

  const [tenants, usage, now, seen, usageUsers] = await Promise.all([
    prisma.tenants.findMany({
      where: { OR: [{ deleted_at: null }, { deleted_at: { gte: monthStart } }] },
      select: { id: true, name: true, deleted_at: true },
    }),
    dayRange === undefined
      ? []
      : prisma.usage_daily.groupBy({
          by: ["tenant_id"],
          where: { day: dayRange },
          _sum: { requests: true, sync_rows: true },
        }),
    storage ?? tenantStorageNow(),
    // Signed in during the month, by the consumer app's own stamp.
    prisma.user_tenants.findMany({
      where: {
        deleted_at: null,
        users: { is: { deleted_at: null, last_seen_at: { gte: monthStart, lt: monthEnd } } },
      },
      select: { tenant_id: true, user_id: true },
    }),
    // Recorded usage during the month, which catches a sign-in stamp that was
    // never written (a row that predates the column) and a long session.
    //
    // A `groupBy` rather than a `findMany({ distinct })`: `distinct` is
    // applied by Prisma in memory, so it would pull one row per tenant, user
    // **and day** — a hundred users over a 31-day month is 3 100 rows to
    // deduplicate into a hundred. The grouped form is the same answer,
    // computed by Postgres over the same index, and its size is the answer's
    // size.
    dayRange === undefined
      ? []
      : prisma.usage_daily.groupBy({
          by: ["tenant_id", "user_id"],
          where: { day: dayRange, user_id: { not: null } },
        }),
  ]);

  const requests = new Map<string, number>();
  const syncRows = new Map<string, number>();
  for (const group of usage) {
    requests.set(group.tenant_id, group._sum.requests ?? 0);
    syncRows.set(group.tenant_id, group._sum.sync_rows ?? 0);
  }
  const bytes = now.bytes;
  const rows = now.transactionRows;

  const activeUsers = new Map<string, Set<string>>();
  const remember = (tenantId: string, userId: string | null) => {
    if (userId === null) return;
    const set = activeUsers.get(tenantId);
    if (set === undefined) activeUsers.set(tenantId, new Set([userId]));
    else set.add(userId);
  };
  for (const row of seen) remember(row.tenant_id, row.user_id);
  for (const row of usageUsers) remember(row.tenant_id, row.user_id);

  return tenants.map((tenant) => ({
    tenantId: tenant.id,
    name: tenant.name,
    deleted: tenant.deleted_at !== null,
    // Deleted after the window's last day (or not at all) means the capacity
    // was still standing by for this tenant when the month ended.
    liveAtMonthEnd: tenant.deleted_at === null || tenant.deleted_at >= monthEnd,
    requests: requests.get(tenant.id) ?? 0,
    syncRows: syncRows.get(tenant.id) ?? 0,
    storageBytes:
      (bytes.get(tenant.id) ?? 0) + (rows.get(tenant.id) ?? 0) * TRANSACTION_ROW_BYTES,
    activeUsers: activeUsers.get(tenant.id)?.size ?? 0,
  }));
}

/* -------------------------------------------------------------------------- */
/*                     Writes: admin_tenant_cost_monthly                      */
/* -------------------------------------------------------------------------- */

/**
 * The interactive-transaction budget for one month's write.
 *
 * One upsert per tenant plus one delete, so the work grows with the number of
 * tenants; 30 seconds is generous for the few dozen this product has and
 * still bounded, and `maxWait` keeps a run from queueing behind a busy pool
 * forever. Prisma's defaults (5 s and 2 s) are tuned for a request, not for a
 * nightly job.
 */
const ALLOCATION_WRITE_TIMEOUT_MS = 30_000;
const ALLOCATION_WRITE_MAX_WAIT_MS = 10_000;

/** What one write of a month did, for the run's counters. */
export interface AllocationWriteOutcome {
  created: number;
  updated: number;
  /** Rows for tenants the month no longer concerns, removed. */
  removed: number;
  /**
   * Why the write was refused, when it was: the month already has rows and
   * the allocation covers no tenant at all. Null on a write that happened.
   * The caller counts a refusal as a failed month and leaves the rows alone.
   */
  refused: string | null;
}

/**
 * Writes one month's allocation: an upsert per tenant on
 * `(tenant_id, month)`, and a delete of any row for that month whose tenant
 * the recomputation did not cover — **all of it in one transaction**.
 *
 * The delete is what keeps the table's promise. The whole point of the
 * micro-dollar pass is that a month's rows sum to the month's bill; a row left
 * behind for a tenant that has since been deleted *before* the month began —
 * or a tenant id that existed in an older, wider recomputation — would break
 * that silently. Tenants deleted during or after the month are still included
 * by {@link tenantDriversFor}, so this removes nothing that belongs to the
 * month.
 *
 * **One transaction per month, and that is the unit of atomicity the job
 * promises.** The upserts and the stale delete are the same edit of the same
 * month seen from two sides: a run that died between them would leave a month
 * whose rows no longer sum to its bill, which is the one thing this table is
 * for. So either the whole month lands or none of it does, and a month
 * already written stays written — the transaction is per month, never per run.
 *
 * Upserts rather than a replace so `computed_at` moves only for rows that were
 * actually recomputed.
 *
 * **An empty allocation never overwrites a written month.** Covering zero
 * tenants while the month already has rows means the drivers read as "there
 * are no tenants", which is either a read that came back empty or a
 * consumer-database problem — never news worth deleting a month of figures
 * over. The month is refused, the existing rows are kept, and the run counts
 * it as failed so the Integrations page says so out loud. (A month that has
 * no rows *and* no tenants is not refused: there is nothing to protect, and
 * writing nothing is the right answer.)
 */
export async function writeMonthAllocation(
  allocation: MonthAllocation,
): Promise<AllocationWriteOutcome> {
  const month = allocation.month;
  const computedAt = new Date();

  const outcome = await prismaAdmin.$transaction(async (tx) => {
    const existing = await tx.admin_tenant_cost_monthly.findMany({
      where: { month },
      select: { tenant_id: true },
    });
    const had = new Set(existing.map((row) => row.tenant_id));

    if (allocation.tenants.length === 0 && had.size > 0) {
      return {
        created: 0,
        updated: 0,
        removed: 0,
        refused:
          `${month} would be written with no tenants at all, while ${had.size} allocated ` +
          `${had.size === 1 ? "row" : "rows"} already exist for it — the tenant read came back ` +
          "empty, so the existing rows are kept rather than deleted. Check the main app " +
          "database's tenants table and run the allocation again.",
      };
    }

    const wanted = new Set(allocation.tenants.map((row) => row.tenantId));
    let created = 0;
    let updated = 0;
    for (const row of allocation.tenants) {
      const data = {
        fixed_usd: row.fixedUsd,
        storage_usd: row.storageUsd,
        request_usd: row.requestUsd,
        user_usd: row.userUsd,
        total_usd: row.totalUsd,
        share_pct: row.sharePct,
        activity_weight: row.activityWeight,
        storage_bytes: BigInt(Math.max(0, Math.trunc(row.storageBytes))),
        requests: row.requests,
        active_users: row.activeUsers,
        computed_at: computedAt,
      };
      await tx.admin_tenant_cost_monthly.upsert({
        where: { tenant_id_month: { tenant_id: row.tenantId, month } },
        create: { tenant_id: row.tenantId, month, ...data },
        update: data,
      });
      if (had.has(row.tenantId)) updated += 1;
      else created += 1;
    }

    const stale = [...had].filter((tenantId) => !wanted.has(tenantId));
    let removed = 0;
    if (stale.length > 0) {
      const deleted = await tx.admin_tenant_cost_monthly.deleteMany({
        where: { month, tenant_id: { in: stale } },
      });
      removed = deleted.count;
    }

    return { created, updated, removed, refused: null };
  }, { timeout: ALLOCATION_WRITE_TIMEOUT_MS, maxWait: ALLOCATION_WRITE_MAX_WAIT_MS });

  if (outcome.refused !== null) {
    console.warn(`[integrations] allocate_costs refused to write ${month}: ${outcome.refused}`);
  }
  return outcome;
}

/* -------------------------------------------------------------------------- */
/*                          The endpoint's response                           */
/* -------------------------------------------------------------------------- */

/** One tenant's row of the per-client table. */
export interface PerClientTenant {
  tenantId: string;
  /** `tenants.name`, read live; null when the tenant row is gone. */
  tenantName: string | null;
  /**
   * The primary live member's address, else any live member's, else a
   * soft-deleted member's. Null when the tenant has none — and null for an
   * operator who holds a cost action but no Customers read action, which is
   * the only personal datum this endpoint would otherwise volunteer.
   */
  ownerEmail: string | null;
  totalUsd: number;
  fixedUsd: number;
  storageUsd: number;
  requestUsd: number;
  userUsd: number;
  /** Percentage of the month's whole bill, 0..100. */
  sharePct: number;
  requests: number;
  storageBytes: number;
  activeUsers: number;
  /** True when the tenant has since been soft-deleted. */
  deleted: boolean;
}

/** `GET /api/v1/admin/costs/per-client?month=YYYY-MM`. */
export interface CostPerClientResponse {
  month: IsoMonth;
  /** The month's whole bill as cached, the sum of the four pools. */
  monthTotalUsd: number;
  pools: {
    fixedUsd: number;
    storageUsd: number;
    requestUsd: number;
    userUsd: number;
    /**
     * What no tenant was given: pools whose driver was zero everywhere, and
     * the whole bill when the allocation has never run for this month.
     */
    unallocatedUsd: number;
  };
  /** Most expensive first. Empty until the nightly run has covered the month. */
  tenants: PerClientTenant[];
  /** When the allocation was last computed for this month; null if never. */
  computedAt: string | null;
}

/** What {@link getCostPerClient} may show, beyond the figures themselves. */
export interface CostPerClientOptions {
  /** The instant the month window is measured from. Tests only. */
  now?: Date;
  /**
   * Whether `ownerEmail` is filled in.
   *
   * **A cost action is not a directory action.** The owner's address is
   * personal data belonging to the Customers feature, so the endpoint only
   * includes it for an operator who could read it there anyway
   * (`can_read_user_list` or `can_read_user_detail`). For everybody else the
   * field is `null` and the query that would have read it is not made —
   * omitted, not blanked after the fact.
   */
  includeOwnerEmail?: boolean;
}

/**
 * `GET /api/v1/admin/costs/per-client` — one month of the stored allocation,
 * with the tenant names (and, for an operator who may see them, the owners)
 * read live.
 *
 * The pool totals are recomputed from `admin_cost_daily` on every call rather
 * than stored per month: they are one `groupBy` of a small table, and reading
 * them the same way the job does means the strip and the rows cannot drift
 * apart when the bill is revised but the allocation has not been recomputed
 * yet — the difference shows up as `unallocatedUsd`, which is exactly where a
 * reader should see it.
 *
 * **Never recomputes and never calls AWS.** A month the nightly run has not
 * covered answers with the pools it can read, an empty `tenants` array and
 * `computedAt: null`; the page says "not computed yet" rather than drawing
 * zeros as measurements.
 */
export async function getCostPerClient(
  month: IsoMonth,
  options: CostPerClientOptions = {},
): Promise<CostPerClientResponse> {
  const now = options.now ?? new Date();
  const window = monthWindow(month, now);
  const [{ pools }, rows] = await Promise.all([
    monthPools(window),
    prismaAdmin.admin_tenant_cost_monthly.findMany({
      where: { month },
      orderBy: { total_usd: "desc" },
    }),
  ]);

  const identities = await tenantIdentities(rows.map((row) => row.tenant_id), {
    includeOwnerEmail: options.includeOwnerEmail === true,
  });
  const num = (value: Prisma.Decimal): number => Number(value);
  const tenants: PerClientTenant[] = rows.map((row) => {
    const identity = identities.get(row.tenant_id);
    return {
      tenantId: row.tenant_id,
      tenantName: identity?.name ?? null,
      ownerEmail: identity?.ownerEmail ?? null,
      totalUsd: num(row.total_usd),
      fixedUsd: num(row.fixed_usd),
      storageUsd: num(row.storage_usd),
      requestUsd: num(row.request_usd),
      userUsd: num(row.user_usd),
      sharePct: num(row.share_pct),
      requests: row.requests,
      storageBytes: Number(row.storage_bytes),
      activeUsers: row.active_users,
      // A tenant whose row is gone from the main database entirely counts as
      // deleted too: the data it was charged for is not coming back.
      deleted: identity === undefined ? true : identity.deleted,
    };
  });

  // In micro-dollars, like the allocation itself: summing a few dozen
  // six-decimal floats and subtracting them from another one leaves a
  // remainder of a few billionths of a dollar, which has no business being
  // reported as "unallocated". Integer units make the gap exact, and anything
  // under one micro-dollar *is* zero.
  const allocatedMicro = tenants.reduce((total, tenant) => total + toMicro(tenant.totalUsd), 0);
  const monthTotalUsd = poolsTotal(pools);
  const monthTotalMicro =
    toMicro(pools.fixedUsd) +
    toMicro(pools.storageUsd) +
    toMicro(pools.requestUsd) +
    toMicro(pools.userUsd);
  const gapMicro = monthTotalMicro - allocatedMicro;
  const computedAt = rows.reduce<Date | null>(
    (newest, row) =>
      newest === null || row.computed_at.getTime() > newest.getTime() ? row.computed_at : newest,
    null,
  );

  return {
    month,
    monthTotalUsd,
    pools: {
      fixedUsd: pools.fixedUsd,
      storageUsd: pools.storageUsd,
      requestUsd: pools.requestUsd,
      userUsd: pools.userUsd,
      // Never negative on the page: a bill that has shrunk since the last
      // recomputation would otherwise read as "minus four cents unallocated",
      // which says nothing useful. The rows are what they are; this is the
      // gap, floored at zero, and a gap of under one micro-dollar is zero.
      unallocatedUsd: Math.abs(gapMicro) < 1 ? 0 : Math.max(0, fromMicro(gapMicro)),
    },
    tenants,
    computedAt: computedAt === null ? null : computedAt.toISOString(),
  };
}

/** A tenant's name and who to call about it. */
interface TenantIdentity {
  name: string | null;
  ownerEmail: string | null;
  deleted: boolean;
}

/**
 * How good a candidate one membership row is for "who to call about this
 * tenant": a live member beats a deleted one, and among equals the primary
 * beats the rest.
 *
 * Explicit rather than left to the `orderBy`, because the two criteria are
 * not in the same order as the sort: `is_primary DESC` would otherwise hand
 * the tenant a soft-deleted primary member's address in front of the live
 * person who is actually using it.
 */
function ownerRank(live: boolean, primary: boolean): number {
  return (live ? 2 : 0) + (primary ? 1 : 0);
}

/**
 * Names — and, when the caller may see them, owners — for the tenant ids of
 * one month, from the main app database. One or two bounded reads (the ids
 * come from the rows already fetched) and read-only, like everything else this
 * console does to the consumer app's data.
 *
 * `includeOwnerEmail: false` skips the membership read entirely: an operator
 * with only a cost action never causes an address to be read, let alone sent.
 */
async function tenantIdentities(
  ids: readonly string[],
  options: { includeOwnerEmail: boolean },
): Promise<Map<string, TenantIdentity>> {
  if (ids.length === 0) return new Map();
  const list = [...ids];
  const [tenants, members] = await Promise.all([
    prisma.tenants.findMany({
      where: { id: { in: list } },
      select: { id: true, name: true, deleted_at: true },
    }),
    options.includeOwnerEmail
      ? prisma.user_tenants.findMany({
          where: { tenant_id: { in: list }, deleted_at: null },
          select: {
            tenant_id: true,
            is_primary: true,
            users: { select: { email: true, deleted_at: true } },
          },
          // `is_primary` is nullable, and a NULL is not a primary member:
          // Postgres sorts NULLs first on a DESC by default, which would put
          // "we do not know" ahead of "yes". Ties then go to the oldest
          // membership, which makes the answer stable between calls.
          orderBy: [{ is_primary: { sort: "desc", nulls: "last" } }, { created_at: "asc" }],
        })
      : [],
  ]);

  const owners = new Map<string, { email: string; rank: number }>();
  for (const member of members) {
    const email = member.users?.email;
    if (email === undefined || email === null) continue;
    const rank = ownerRank(member.users?.deleted_at === null, member.is_primary === true);
    const current = owners.get(member.tenant_id);
    // Strictly greater, so the `orderBy` still breaks ties: the first row of
    // an equally good pair wins.
    if (current === undefined || rank > current.rank) {
      owners.set(member.tenant_id, { email, rank });
    }
  }

  return new Map(
    tenants.map((tenant) => [
      tenant.id,
      {
        name: tenant.name,
        ownerEmail: owners.get(tenant.id)?.email ?? null,
        deleted: tenant.deleted_at !== null,
      },
    ]),
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Schemas                                   */
/* -------------------------------------------------------------------------- */

/**
 * The earliest month the endpoint will answer for.
 *
 * Nothing in this account predates it — the product's first AWS bill is 2026
 * — and the cached bill only reaches back fourteen months whatever is asked.
 * The bound exists so `?month=0001-01` is refused at the boundary instead of
 * becoming a query, a month window and a `formatMonth` for a year no reader
 * meant.
 */
export const ALLOCATION_MONTH_MIN: IsoMonth = "2020-01";

/**
 * The latest month the endpoint will answer for: the one **after** the
 * current UTC month.
 *
 * Next month rather than this one so a browser a few hours ahead of UTC — or
 * a page left open across a month boundary — is never refused for asking
 * about "now". There is no cost for it yet, so the answer is an empty one.
 */
export function allocationMonthMax(now: Date = new Date()): IsoMonth {
  return shiftMonth(monthOf(todayUtc(now)), 1);
}

/** Whether a month label is one this feature will answer for at all. */
export function isAllocatableMonth(month: IsoMonth, now: Date = new Date()): boolean {
  // `YYYY-MM` sorts as text exactly as it sorts as a date, which is the whole
  // reason the column is a label.
  return month >= ALLOCATION_MONTH_MIN && month <= allocationMonthMax(now);
}

/**
 * `?month=YYYY-MM`, defaulting to the current UTC month.
 *
 * Shape **and range**: the month is a label the query filters by, so a month
 * with no rows is a perfectly good answer rather than an error — but a month
 * outside `ALLOCATION_MONTH_MIN .. next month` is not a month anybody is
 * asking about, and refusing it at the boundary keeps a typo from turning
 * into an empty table the reader has to interpret. The range is evaluated
 * when the request is validated, so "next month" moves with the clock.
 */
export const costPerClientQuerySchema = z.object({
  month: z
    .string()
    .trim()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a month in the form YYYY-MM.")
    .refine((month) => isAllocatableMonth(month), {
      message: `Use a month between ${ALLOCATION_MONTH_MIN} and the month after this one.`,
    })
    .optional(),
});

export type ResolvedCostPerClientQuery = z.infer<typeof costPerClientQuerySchema>;

/** The month a request means: what it asked for, else the current one. */
export function resolveMonth(
  query: ResolvedCostPerClientQuery,
  now: Date = new Date(),
): IsoMonth {
  return query.month ?? monthOf(todayUtc(now));
}
