import "server-only";
/**
 * Everything the Customers feature reads from the **main app database**
 * (`DATABASE_URL`, the `prisma` client). Read-only by construction: only
 * `findMany`, `count`, `groupBy` and `findFirst` appear below, and nothing in
 * this feature ever writes to the consumer app's data.
 *
 * The database role has BYPASSRLS, so the tenant-scoped tables
 * (`transactions`, `accounts`, `budgets`, `goals`) are readable without a
 * tenant context; that is the only reason the activity figures are possible
 * from here.
 *
 * The shape of every query is chosen so that a page of customers costs a
 * fixed number of round trips, never one per row:
 *
 *   1. one `findMany` for the page of `users`
 *   2. one `findMany` for their live `user_tenants` (+ the tenant)
 *   3. four `groupBy`s over the page's tenant ids for `lastActiveAt` and the
 *      two counters
 *
 * `users.user_tenants` is modelled by Prisma as a to-one relation (the table
 * has a partial unique index on `user_id` for the primary membership), but
 * the table really can hold several live rows per user, so memberships are
 * read separately rather than through that relation.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { Customer, CustomerTenant } from "./types";

/** A customer as the database alone can describe them: no pool, no status. */
export type CustomerBase = Omit<Customer, "cognito" | "status">;

/**
 * How many tenants a name search may match, and how many members those
 * tenants may contribute. The search is a substring over a small table today;
 * these caps stop a one-letter query from loading every membership in the
 * database, at the price of an incomplete result for such a query.
 */
const TENANT_MATCH_MAX = 1_000;
const TENANT_MEMBER_MAX = 5_000;

export interface CustomerPageFilter {
  page: number;
  pageSize: number;
  q?: string;
  includeDeleted: boolean;
  /** Restrict to these `cognito_sub`s (a status filter, resolved from the pool). */
  subsIn?: readonly string[];
  /** Exclude these `cognito_sub`s (`status=no_account`). */
  subsNotIn?: readonly string[];
  /**
   * Only soft-deleted rows (`status=deleted`). Overrides `includeDeleted`,
   * which would otherwise contradict it: asking for the deleted customers
   * while hiding deleted rows can only ever answer nothing.
   */
  deletedOnly?: boolean;
}

type UserRow = {
  id: string;
  cognito_sub: string;
  email: string;
  is_primary: boolean | null;
  created_at: Date | null;
  updated_at: Date | null;
  deleted_at: Date | null;
  last_seen_at: Date | null;
};

const userSelect = {
  id: true,
  cognito_sub: true,
  email: true,
  is_primary: true,
  created_at: true,
  updated_at: true,
  deleted_at: true,
  // Stamped by the consumer app at sign-in and refreshed at most once an
  // hour. The only column in either database that means "this person used
  // the app"; everything else is inferred from what their data looks like.
  last_seen_at: true,
} as const;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function later(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/* -------------------------------------------------------------------------- */
/*                                   Search                                   */
/* -------------------------------------------------------------------------- */

/**
 * The user ids whose tenant name matches `q`.
 *
 * Done as two small queries rather than a relation filter because the tenant
 * side is a real one-to-many in the database even though Prisma models it as
 * one-to-one; a relation filter through that model would be reading a
 * relationship that does not exist.
 */
async function userIdsByTenantName(q: string): Promise<string[]> {
  const tenants = await prisma.tenants.findMany({
    where: { deleted_at: null, name: { contains: q, mode: "insensitive" } },
    select: { id: true },
    take: TENANT_MATCH_MAX,
  });
  if (tenants.length === 0) return [];
  const memberships = await prisma.user_tenants.findMany({
    where: { deleted_at: null, tenant_id: { in: tenants.map((row) => row.id) } },
    select: { user_id: true },
    distinct: ["user_id"],
    take: TENANT_MEMBER_MAX,
  });
  return memberships.map((row) => row.user_id);
}

async function whereFor(filter: CustomerPageFilter): Promise<Prisma.usersWhereInput> {
  const where: Prisma.usersWhereInput = {};

  if (filter.deletedOnly === true) where.deleted_at = { not: null };
  else if (!filter.includeDeleted) where.deleted_at = null;

  if (filter.subsIn !== undefined) {
    where.cognito_sub = { in: [...filter.subsIn] };
  } else if (filter.subsNotIn !== undefined && filter.subsNotIn.length > 0) {
    where.cognito_sub = { notIn: [...filter.subsNotIn] };
  }

  const q = filter.q?.trim();
  if (q !== undefined && q !== "") {
    const ids = await userIdsByTenantName(q);
    where.OR = [
      { email: { contains: q, mode: "insensitive" } },
      ...(ids.length > 0 ? [{ id: { in: ids } }] : []),
    ];
  }
  return where;
}

/* -------------------------------------------------------------------------- */
/*                                 Hydration                                  */
/* -------------------------------------------------------------------------- */

interface TenantActivity {
  lastActiveAt: Date | null;
  accountCount: number;
  transactionCount: number;
  tenant: CustomerTenant;
}

/**
 * Tenants, activity and counters for one page of customers: four `groupBy`s
 * and one membership read, whatever the page size.
 */
async function activityFor(userIds: string[]): Promise<Map<string, TenantActivity[]>> {
  if (userIds.length === 0) return new Map();

  const memberships = await prisma.user_tenants.findMany({
    where: { user_id: { in: userIds }, deleted_at: null, tenants: { is: { deleted_at: null } } },
    select: {
      user_id: true,
      tenant_id: true,
      is_primary: true,
      tenants: { select: { id: true, name: true, created_at: true, updated_at: true } },
    },
  });
  const tenantIds = [...new Set(memberships.map((row) => row.tenant_id))];
  if (tenantIds.length === 0) return new Map();

  const live = { tenant_id: { in: tenantIds }, deleted_at: null } as const;
  const [transactions, accounts, budgets, goals] = await Promise.all([
    prisma.transactions.groupBy({
      by: ["tenant_id"],
      where: live,
      _max: { updated_at: true },
      _count: { _all: true },
    }),
    prisma.accounts.groupBy({
      by: ["tenant_id"],
      where: live,
      _max: { updated_at: true },
      _count: { _all: true },
    }),
    prisma.budgets.groupBy({ by: ["tenant_id"], where: live, _max: { updated_at: true } }),
    prisma.goals.groupBy({ by: ["tenant_id"], where: live, _max: { updated_at: true } }),
  ]);

  const maxOf = (rows: { tenant_id: string; _max: { updated_at: Date | null } }[]) =>
    new Map(rows.map((row) => [row.tenant_id, row._max.updated_at]));
  const transactionMax = maxOf(transactions);
  const accountMax = maxOf(accounts);
  const budgetMax = maxOf(budgets);
  const goalMax = maxOf(goals);
  const transactionCounts = new Map(transactions.map((row) => [row.tenant_id, row._count._all]));
  const accountCounts = new Map(accounts.map((row) => [row.tenant_id, row._count._all]));

  const byUser = new Map<string, TenantActivity[]>();
  for (const membership of memberships) {
    const tenant = membership.tenants;
    // Newest change anywhere in the tenant; the tenant's own updated_at is the
    // fallback so a customer who has entered nothing yet still has a date.
    const newest =
      later(
        later(transactionMax.get(tenant.id) ?? null, accountMax.get(tenant.id) ?? null),
        later(budgetMax.get(tenant.id) ?? null, goalMax.get(tenant.id) ?? null),
      ) ?? tenant.updated_at;
    const entry: TenantActivity = {
      lastActiveAt: newest,
      accountCount: accountCounts.get(tenant.id) ?? 0,
      transactionCount: transactionCounts.get(tenant.id) ?? 0,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        isPrimary: membership.is_primary ?? false,
        createdAt: iso(tenant.created_at),
      },
    };
    const list = byUser.get(membership.user_id);
    if (list === undefined) byUser.set(membership.user_id, [entry]);
    else list.push(entry);
  }
  return byUser;
}

function assemble(users: UserRow[], activity: Map<string, TenantActivity[]>): CustomerBase[] {
  return users.map((user) => {
    const entries = activity.get(user.id) ?? [];
    let lastActiveAt: Date | null = null;
    let accountCount = 0;
    let transactionCount = 0;
    for (const entry of entries) {
      lastActiveAt = later(lastActiveAt, entry.lastActiveAt);
      accountCount += entry.accountCount;
      transactionCount += entry.transactionCount;
    }
    return {
      id: user.id,
      cognitoSub: user.cognito_sub,
      email: user.email,
      isPrimary: user.is_primary ?? false,
      createdAt: iso(user.created_at),
      updatedAt: iso(user.updated_at),
      deletedAt: iso(user.deleted_at),
      lastSeenAt: iso(user.last_seen_at),
      tenants: entries
        .map((entry) => entry.tenant)
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name)),
      lastActiveAt: iso(lastActiveAt),
      accountCount,
      transactionCount,
    };
  });
}

/* -------------------------------------------------------------------------- */
/*                                   Reads                                    */
/* -------------------------------------------------------------------------- */

/** One page of customers, newest first, with the total for that filter. */
export async function findCustomerPage(
  filter: CustomerPageFilter,
): Promise<{ items: CustomerBase[]; total: number }> {
  const where = await whereFor(filter);
  const [total, users] = await Promise.all([
    prisma.users.count({ where }),
    prisma.users.findMany({
      where,
      select: userSelect,
      // created_at is nullable in the consumer app's schema; a row without one
      // sorts last rather than first, and `id` keeps the order stable.
      orderBy: [{ created_at: { sort: "desc", nulls: "last" } }, { id: "desc" }],
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
    }),
  ]);
  const items = assemble(users, await activityFor(users.map((user) => user.id)));
  return { items, total };
}

/** One customer by `users.id`, soft-deleted rows included. */
export async function findCustomerById(id: string): Promise<CustomerBase | null> {
  const user = await prisma.users.findFirst({ where: { id }, select: userSelect });
  if (user === null) return null;
  return assemble([user], await activityFor([user.id]))[0] ?? null;
}

/** Live `users` rows. */
export async function countLiveCustomers(): Promise<number> {
  return prisma.users.count({ where: { deleted_at: null } });
}

/**
 * Soft-deleted `users` rows: the self-service account deletions the consumer
 * app writes. Counted for the header figure, which is the only place an
 * operator sees them without switching "Include deleted" on.
 */
export async function countDeletedCustomers(): Promise<number> {
  return prisma.users.count({ where: { deleted_at: { not: null } } });
}

/**
 * Live customers whose tenants changed anything since `since`.
 *
 * Cost note: this collects every tenant id touched in the window and then
 * counts the distinct live members of those tenants, so it grows with the
 * number of *active* tenants, not with the number of customers on the page.
 * It is one figure in a header at the current scale (tens of tenants); when
 * the product has thousands, this becomes a materialised counter or a raw
 * `SELECT count(DISTINCT …)` rather than an `IN (…)` list.
 */
export async function countRecentlyActive(since: Date): Promise<number> {
  const recent = { deleted_at: null, updated_at: { gte: since } } as const;
  const [transactions, accounts, budgets, goals, tenants] = await Promise.all([
    prisma.transactions.groupBy({ by: ["tenant_id"], where: recent, _count: { _all: true } }),
    prisma.accounts.groupBy({ by: ["tenant_id"], where: recent, _count: { _all: true } }),
    prisma.budgets.groupBy({ by: ["tenant_id"], where: recent, _count: { _all: true } }),
    prisma.goals.groupBy({ by: ["tenant_id"], where: recent, _count: { _all: true } }),
    prisma.tenants.findMany({ where: recent, select: { id: true } }),
  ]);
  const tenantIds = new Set<string>([
    ...transactions.map((row) => row.tenant_id),
    ...accounts.map((row) => row.tenant_id),
    ...budgets.map((row) => row.tenant_id),
    ...goals.map((row) => row.tenant_id),
    ...tenants.map((row) => row.id),
  ]);
  if (tenantIds.size === 0) return 0;
  const members = await prisma.user_tenants.findMany({
    where: {
      deleted_at: null,
      tenant_id: { in: [...tenantIds] },
      users: { is: { deleted_at: null } },
    },
    select: { user_id: true },
    distinct: ["user_id"],
  });
  return members.length;
}

/**
 * The `users` rows for the given Cognito subs, which is how an invitation is
 * detected as accepted: a row exists, so the person has signed in at least
 * once. Soft-deleted rows count — they signed in before they were removed.
 */
export async function findUsersByCognitoSub(
  subs: readonly string[],
): Promise<Map<string, { id: string; email: string; createdAt: Date | null }>> {
  if (subs.length === 0) return new Map();
  const rows = await prisma.users.findMany({
    where: { cognito_sub: { in: [...subs] } },
    select: { id: true, email: true, cognito_sub: true, created_at: true },
  });
  return new Map(
    rows.map((row) => [row.cognito_sub, { id: row.id, email: row.email, createdAt: row.created_at }]),
  );
}

/** Whether any `users` row (live) already holds this address. */
export async function findLiveUserByEmail(email: string): Promise<{ id: string } | null> {
  return prisma.users.findFirst({
    where: { deleted_at: null, email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
}

/* -------------------------------------------------------------------------- */
/*                                 Statistics                                 */
/* -------------------------------------------------------------------------- */
/**
 * Everything the Activity view reads from the main app database. Still
 * read-only, still bounded: every query below is either an aggregate the
 * database performs, or is limited by a date window and a `take`.
 *
 * Two of them are raw SQL. Both bucket by `date_trunc('month', …)`, which
 * Prisma's `groupBy` cannot express, and both are tagged templates whose only
 * inputs are `Date`s, so the values are parameterised.
 */

/** `YYYY-MM` for the month a UTC instant falls in. */
function monthKey(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/**
 * Live customers seen since `since` — the DAU / WAU / MAU figures.
 *
 * `users` holds one row per person, so a count is already the distinct count.
 * Soft-deleted rows are excluded: someone who deleted their account last week
 * is not this week's active user, whatever their last sign-in says.
 */
export async function countSeenSince(since: Date): Promise<number> {
  return prisma.users.count({ where: { deleted_at: null, last_seen_at: { gte: since } } });
}

/**
 * New customers per UTC calendar month, from `users.created_at` — the moment
 * the consumer app first saw them, which is the first successful sign-in.
 *
 * Deliberately **not** the pool's account-creation date: an invitation that
 * was never accepted is not a customer, and counting it as one would make the
 * "new" line disagree with every other figure on the page, all of which are
 * about people who actually arrived. Soft-deleted rows are included — they
 * were new that month, and their departure is counted separately.
 */
export async function newCustomersPerMonth(
  from: Date,
  toExclusive: Date,
): Promise<{ month: string; count: number }[]> {
  const rows = await prisma.$queryRaw<{ month: string; n: bigint }[]>`
    SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
           count(*) AS n
    FROM users
    WHERE created_at >= ${from}
      AND created_at < ${toExclusive}
    GROUP BY 1
    ORDER BY 1
  `;
  return rows.map((row) => ({ month: row.month, count: Number(row.n) }));
}

/**
 * The churn denominator for one month: how many customers the month started
 * with.
 *
 * "Started with" is the union of two populations, which is the definition the
 * brief asks for:
 *
 * 1. everyone who already existed at 00:00 UTC on the 1st and had not been
 *    deleted by then (`created_at < start` and `deleted_at` either null or
 *    later than the start) — the base the month inherited;
 * 2. anyone with a `last_seen_at` in the 30 days before the start, which adds
 *    nothing the first clause missed today but keeps the figure meaningful if
 *    `users` ever stops being the only record of a customer.
 *
 * Because it is a union and `users` holds one row per person, the count is the
 * distinct count.
 */
export async function countActiveAtMonthStart(start: Date, windowDays: number): Promise<number> {
  const seenFrom = new Date(start.getTime() - windowDays * 24 * 60 * 60 * 1000);
  return prisma.users.count({
    where: {
      OR: [
        {
          AND: [
            { created_at: { lt: start } },
            { OR: [{ deleted_at: null }, { deleted_at: { gte: start } }] },
          ],
        },
        { last_seen_at: { gte: seenFrom, lt: start } },
      ],
    },
  });
}

/**
 * Retention by sign-up cohort: everyone who signed up in a month, and how
 * many of them have been seen in the last 30 days.
 *
 * Deleted accounts stay in the denominator and are excluded from the
 * numerator by `deleted_at IS NULL` — someone who deleted their account last
 * week is not a retained customer, however recent their last sign-in — so a
 * cohort that left shows as retention falling, which is the question the
 * table is asked. That is also the same population `countSeenSince` counts
 * for MAU, so the two cannot disagree about who is still here.
 *
 * `since` is the start of the recency window and is passed in rather than
 * computed here, so the churn table and this one agree about when "recently"
 * began.
 */
export async function retentionByCohort(
  from: Date,
  toExclusive: Date,
  since: Date,
): Promise<{ month: string; cohort: number; retained: number }[]> {
  const rows = await prisma.$queryRaw<{ month: string; cohort: bigint; retained: bigint }[]>`
    SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
           count(*) AS cohort,
           count(*) FILTER (WHERE last_seen_at >= ${since} AND deleted_at IS NULL) AS retained
    FROM users
    WHERE created_at >= ${from}
      AND created_at < ${toExclusive}
    GROUP BY 1
    ORDER BY 1
  `;
  return rows.map((row) => ({
    month: row.month,
    cohort: Number(row.cohort),
    retained: Number(row.retained),
  }));
}

/**
 * The three app-side funnel steps: onboarded, first transaction, first
 * attachment.
 *
 * One `COUNT(DISTINCT user_id)` each, with the "has any" test as an `EXISTS`
 * so the database stops at the first matching row per tenant instead of
 * counting every transaction in it. Raw because `COUNT(DISTINCT …)` over a
 * join is not something `groupBy` expresses; no interpolated values at all.
 */
export async function funnelProgress(): Promise<{
  onboarded: number;
  firstTransaction: number;
  firstAttachment: number;
}> {
  const [rows] = await prisma.$queryRaw<
    { onboarded: bigint; first_transaction: bigint; first_attachment: bigint }[]
  >`
    SELECT
      count(DISTINCT ut.user_id) AS onboarded,
      count(DISTINCT ut.user_id) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM transactions t
          WHERE t.tenant_id = ut.tenant_id AND t.deleted_at IS NULL
        )
      ) AS first_transaction,
      count(DISTINCT ut.user_id) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM file_blobs f
          WHERE f.tenant_id = ut.tenant_id AND f.deleted_at IS NULL
        )
      ) AS first_attachment
    FROM user_tenants ut
    JOIN users u ON u.id = ut.user_id AND u.deleted_at IS NULL
    JOIN tenants tn ON tn.id = ut.tenant_id AND tn.deleted_at IS NULL
    WHERE ut.deleted_at IS NULL
  `;
  return {
    onboarded: Number(rows?.onboarded ?? 0),
    firstTransaction: Number(rows?.first_transaction ?? 0),
    firstAttachment: Number(rows?.first_attachment ?? 0),
  };
}

/** One day of `usage_daily`, summed over every tenant and user. */
export interface UsageDayRow {
  day: string;
  requests: number;
  errors: number;
  syncRows: number;
  bytesUploaded: number;
}

/** A `DATE` column as `YYYY-MM-DD`. */
function dayKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * `usage_daily` summed per day over the whole product, oldest first.
 *
 * One `groupBy` bounded by the date range. `bytes_uploaded` is a `BIGINT`, so
 * its sum arrives as a `BigInt` and is narrowed to a number here — at any
 * plausible upload volume that is exact, and the alternative is a `BigInt` on
 * the wire, which `JSON.stringify` refuses.
 */
export async function usagePerDay(from: Date, to: Date): Promise<UsageDayRow[]> {
  const groups = await prisma.usage_daily.groupBy({
    by: ["day"],
    where: { day: { gte: from, lte: to } },
    _sum: { requests: true, errors: true, sync_rows: true, bytes_uploaded: true },
    orderBy: { day: "asc" },
  });
  return groups.map((group) => ({
    day: dayKey(group.day),
    requests: group._sum.requests ?? 0,
    errors: group._sum.errors ?? 0,
    syncRows: group._sum.sync_rows ?? 0,
    bytesUploaded: Number(group._sum.bytes_uploaded ?? 0),
  }));
}

/** One tenant's size, for the "largest tenants" tables. */
export interface TenantSizeRow {
  tenantId: string;
  name: string | null;
  bytes: number;
  transactions: number;
}

/** Tenant names for a handful of ids; `null` for a tenant row that is gone. */
async function tenantNames(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.tenants.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * The biggest tenants, two ways: by attachment bytes and by transaction count.
 *
 * Two ranked lists rather than one, because they answer different questions —
 * who is filling the S3 bucket, and who is actually using the product — and a
 * single combined score would answer neither. Each is one aggregate with an
 * `ORDER BY` and a `LIMIT` in the database, then one name lookup for the
 * twenty ids at most that came back.
 *
 * The cross figure (bytes for a transaction-heavy tenant, and the reverse) is
 * filled in with a second bounded aggregate over just those ids, so each row
 * can show both numbers.
 */
export async function largestTenants(
  limit: number,
): Promise<{ byBytes: TenantSizeRow[]; byTransactions: TenantSizeRow[] }> {
  const [byBytesGroups, byTransactionGroups] = await Promise.all([
    prisma.file_blobs.groupBy({
      by: ["tenant_id"],
      where: { deleted_at: null },
      _sum: { byte_size: true },
      orderBy: { _sum: { byte_size: "desc" } },
      take: limit,
    }),
    prisma.transactions.groupBy({
      by: ["tenant_id"],
      where: { deleted_at: null },
      _count: { tenant_id: true },
      orderBy: { _count: { tenant_id: "desc" } },
      take: limit,
    }),
  ]);

  const ids = [
    ...new Set([
      ...byBytesGroups.map((group) => group.tenant_id),
      ...byTransactionGroups.map((group) => group.tenant_id),
    ]),
  ];
  if (ids.length === 0) return { byBytes: [], byTransactions: [] };

  const [names, bytesFor, transactionsFor] = await Promise.all([
    tenantNames(ids),
    prisma.file_blobs.groupBy({
      by: ["tenant_id"],
      where: { deleted_at: null, tenant_id: { in: ids } },
      _sum: { byte_size: true },
    }),
    prisma.transactions.groupBy({
      by: ["tenant_id"],
      where: { deleted_at: null, tenant_id: { in: ids } },
      _count: { tenant_id: true },
    }),
  ]);
  const bytes = new Map(bytesFor.map((group) => [group.tenant_id, group._sum.byte_size ?? 0]));
  const counts = new Map(
    transactionsFor.map((group) => [group.tenant_id, group._count.tenant_id]),
  );

  const rowFor = (tenantId: string): TenantSizeRow => ({
    tenantId,
    name: names.get(tenantId) ?? null,
    bytes: bytes.get(tenantId) ?? 0,
    transactions: counts.get(tenantId) ?? 0,
  });

  return {
    byBytes: byBytesGroups.map((group) => rowFor(group.tenant_id)),
    byTransactions: byTransactionGroups.map((group) => rowFor(group.tenant_id)),
  };
}

/* ---------------------------- One customer -------------------------------- */

/** One customer's daily usage rows, oldest first. */
export async function usageForUser(
  userId: string,
  from: Date,
  to: Date,
): Promise<UsageDayRow[]> {
  const groups = await prisma.usage_daily.groupBy({
    by: ["day"],
    where: { user_id: userId, day: { gte: from, lte: to } },
    _sum: { requests: true, errors: true, sync_rows: true, bytes_uploaded: true },
    orderBy: { day: "asc" },
  });
  return groups.map((group) => ({
    day: dayKey(group.day),
    requests: group._sum.requests ?? 0,
    errors: group._sum.errors ?? 0,
    syncRows: group._sum.sync_rows ?? 0,
    bytesUploaded: Number(group._sum.bytes_uploaded ?? 0),
  }));
}

/** How much data one tenant holds. */
export interface TenantFootprint {
  tenantId: string;
  name: string | null;
  transactions: number;
  accounts: number;
  documents: number;
  bytes: number;
}

/**
 * The footprint of each tenant a customer belongs to: four aggregates over
 * their tenant ids, whatever the number of tenants, plus the names.
 *
 * Live rows only. A soft-deleted transaction is not data the person still has,
 * and counting it would make the figure disagree with the list's own counters.
 */
export async function tenantFootprints(userId: string): Promise<TenantFootprint[]> {
  const memberships = await prisma.user_tenants.findMany({
    where: { user_id: userId, deleted_at: null },
    select: { tenant_id: true, tenants: { select: { id: true, name: true } } },
  });
  const ids = [...new Set(memberships.map((row) => row.tenant_id))];
  if (ids.length === 0) return [];

  const live = { tenant_id: { in: ids }, deleted_at: null } as const;
  const [transactions, accounts, documents, blobs] = await Promise.all([
    prisma.transactions.groupBy({ by: ["tenant_id"], where: live, _count: { tenant_id: true } }),
    prisma.accounts.groupBy({ by: ["tenant_id"], where: live, _count: { tenant_id: true } }),
    prisma.documents.groupBy({ by: ["tenant_id"], where: live, _count: { tenant_id: true } }),
    prisma.file_blobs.groupBy({ by: ["tenant_id"], where: live, _sum: { byte_size: true } }),
  ]);
  const countMap = (rows: { tenant_id: string; _count: { tenant_id: number } }[]) =>
    new Map(rows.map((row) => [row.tenant_id, row._count.tenant_id]));
  const transactionCounts = countMap(transactions);
  const accountCounts = countMap(accounts);
  const documentCounts = countMap(documents);
  const byteSums = new Map(blobs.map((row) => [row.tenant_id, row._sum.byte_size ?? 0]));

  return memberships.map((membership) => ({
    tenantId: membership.tenant_id,
    name: membership.tenants?.name ?? null,
    transactions: transactionCounts.get(membership.tenant_id) ?? 0,
    accounts: accountCounts.get(membership.tenant_id) ?? 0,
    documents: documentCounts.get(membership.tenant_id) ?? 0,
    bytes: byteSums.get(membership.tenant_id) ?? 0,
  }));
}

/**
 * Customers soft-deleted since `since`, for the nightly `deleted_in_app`
 * sweep: the consumer app's delete-my-account flow sets `users.deleted_at`,
 * and this is how the admin app learns about it the same night.
 *
 * Bounded by the window (7 days) and a `take`, so a mass deletion cannot turn
 * one run into an unbounded read. Hitting the `take` is worth saying out loud:
 * the rows are ordered newest first, so the deletions that were dropped are
 * the *oldest* in the window, and unless another run picks them up inside the
 * seven days they are never recorded at all. One line per call — the caller is
 * a job that runs once a night.
 */
export async function findRecentlyDeletedUsers(
  since: Date,
  take: number,
): Promise<{ id: string; cognitoSub: string; email: string; deletedAt: Date }[]> {
  const rows = await prisma.users.findMany({
    where: { deleted_at: { gte: since } },
    select: { id: true, cognito_sub: true, email: true, deleted_at: true },
    orderBy: { deleted_at: "desc" },
    take,
  });
  if (rows.length >= take) {
    console.warn(
      `[customers] the consumer-app deletion sweep hit its cap of ${take} rows since ` +
        `${since.toISOString()}; older deletions inside the window were not read. Raise ` +
        "DELETED_IN_APP_MAX in src/lib/customers/types.ts if this is not a one-off.",
    );
  }
  return rows.flatMap((row) =>
    row.deleted_at === null
      ? []
      : [{ id: row.id, cognitoSub: row.cognito_sub, email: row.email, deletedAt: row.deleted_at }],
  );
}

/** Exported for the month bucketing the statistics service does. */
export { monthKey };
