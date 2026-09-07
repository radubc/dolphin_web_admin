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
}

type UserRow = {
  id: string;
  cognito_sub: string;
  email: string;
  is_primary: boolean | null;
  created_at: Date | null;
  updated_at: Date | null;
  deleted_at: Date | null;
};

const userSelect = {
  id: true,
  cognito_sub: true,
  email: true,
  is_primary: true,
  created_at: true,
  updated_at: true,
  deleted_at: true,
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

  if (!filter.includeDeleted) where.deleted_at = null;

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
