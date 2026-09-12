import "server-only";
/**
 * What the Customers routes call: the main app database (`./repository.ts`),
 * the customer Cognito pool (`./cognito.ts`) and the invitation records in the
 * admin database (`./invites.ts`), shaped into the responses declared in
 * `./types.ts`.
 *
 * Routes stay thin — validate the query or body, call one of these.
 *
 * Two decisions live here rather than in a route:
 *
 * - **The status filter is resolved before paging, not after.** A customer's
 *   status comes from Cognito, not from a column, so filtering the page after
 *   it was fetched would give a page of the wrong size and a `total` that
 *   contradicts it. Instead the pool listing is turned into a set of `sub`s
 *   and the database does the filtering.
 * - **A pool that cannot be reached is not an error.** The list still answers
 *   from the database with `cognito: null` on every row, `status: "unknown"`
 *   and `cognitoAvailable: false`; the page says so. Only an operator *action*
 *   (invite, resend, revoke) fails loudly, because there the pool is the point.
 * - **A status filter and `includeDeleted` cannot contradict each other.**
 *   `deleted` outranks every pool-derived status on a row (see
 *   {@link deriveStatus}), so `status=active&includeDeleted=true` used to
 *   answer with rows whose own status said `deleted`. Any filter other than
 *   `all` therefore leaves the soft-deleted rows out, and `status=deleted`
 *   asks for them alone.
 */
import { NotFoundError } from "@/lib/api/errors";
import { availability, describeAccounts, getPoolDirectory } from "./cognito";
import {
  createInvite,
  listInvites,
  reconcileAcceptedInvites,
  resendInvite,
  revokeInvite,
} from "./invites";
import {
  countDeletedCustomers,
  countLiveCustomers,
  countRecentlyActive,
  findCustomerById,
  findCustomerPage,
  type CustomerBase,
} from "./repository";
import type { ResolvedCustomerListQuery, ResolvedInviteListQuery } from "./schemas";
import {
  ACTIVE_WINDOW_DAYS,
  type CreateInviteInput,
  type Customer,
  type CustomerCognitoAccount,
  type CustomerInvite,
  type CustomerListResponse,
  type CustomerStatus,
  type InviteListResponse,
} from "./types";

/* -------------------------------------------------------------------------- */
/*                                   Status                                   */
/* -------------------------------------------------------------------------- */

/**
 * The one-word state the table shows. `unknown` has two meanings the type
 * deliberately merges: the pool was never consulted, or it answered with a
 * state (`UNCONFIRMED`, `RESET_REQUIRED`) that this console has nothing to say
 * about.
 *
 * The precedence is documented in `docs/api.md`: a soft-deleted `users` row is
 * `deleted` whatever the pool says, which is why {@link includeDeletedFor}
 * keeps those rows out of every other status filter.
 */
function deriveStatus(
  account: CustomerCognitoAccount | null,
  poolAvailable: boolean,
  deletedAt: string | null = null,
): CustomerStatus {
  // A soft-deleted `users` row outranks everything the pool could say. The
  // person has left through the consumer app's own delete-my-account flow;
  // whether their Cognito account is still there (it is removed the same
  // night, by the directory diff's reckoning) is an implementation detail of
  // the clean-up, not their state.
  if (deletedAt !== null) return "deleted";
  if (!poolAvailable) return "unknown";
  if (account === null) return "no_account";
  if (!account.enabled) return "disabled";
  switch (account.status) {
    case "confirmed":
      return "active";
    case "force_change_password":
      return "invited";
    default:
      return "unknown";
  }
}

function withPool(
  base: CustomerBase,
  accounts: Map<string, CustomerCognitoAccount>,
  poolAvailable: boolean,
): Customer {
  const account = accounts.get(base.cognitoSub) ?? null;
  return {
    ...base,
    cognito: account,
    status: deriveStatus(account, poolAvailable, base.deletedAt),
  };
}

/**
 * Turns a status filter into the `sub`s the database query may return.
 *
 * `undefined` means "do not filter". An empty `subsIn` means "no customer can
 * match", which is the right answer when the pool is unreachable and the
 * operator asked for a pool-derived status.
 */
async function subsForStatus(
  status: ResolvedCustomerListQuery["status"],
): Promise<{ subsIn?: string[]; subsNotIn?: string[]; deletedOnly?: boolean }> {
  if (status === "all") return {};
  // The one status that is a column rather than a pool answer, so it is
  // filtered in the database and needs no listing at all. It also implies
  // "include deleted", which the repository resolves.
  if (status === "deleted") return { deletedOnly: true };
  const directory = await getPoolDirectory();
  if (directory === null) {
    // Without the pool every customer is `unknown`, so that filter is a no-op
    // and every other one matches nothing.
    return status === "unknown" ? {} : { subsIn: [] };
  }
  if (status === "no_account") {
    return { subsNotIn: [...directory.bySub.keys()] };
  }
  const subsIn: string[] = [];
  for (const [sub, account] of directory.bySub) {
    if (deriveStatus(account, true) === status) subsIn.push(sub);
  }
  return { subsIn };
}

/**
 * Whether soft-deleted rows may appear, given the status filter.
 *
 * Only an unfiltered list honours `includeDeleted`. Every other value is a
 * status a soft-deleted row cannot truthfully have: `deriveStatus` answers
 * `deleted` for it whatever the pool says, so a row matching
 * `status=active&includeDeleted=true` would arrive labelled `deleted` and the
 * filter and the row would disagree on screen. `status=deleted` is the way to
 * ask for them, and it selects them alone (`deletedOnly`, which the
 * repository lets override this).
 */
function includeDeletedFor(query: ResolvedCustomerListQuery): boolean {
  return query.status === "all" ? query.includeDeleted : false;
}

/* -------------------------------------------------------------------------- */
/*                                  Customers                                 */
/* -------------------------------------------------------------------------- */

/** One page of customers with the header figures. */
export async function listCustomers(query: ResolvedCustomerListQuery): Promise<CustomerListResponse> {
  // Cheap, and it keeps the invited/accepted split honest on a page an
  // operator is looking at anyway.
  await reconcileAcceptedInvites();

  const filter = await subsForStatus(query.status);
  const { items: bases, total } = await findCustomerPage({
    page: query.page,
    pageSize: query.pageSize,
    q: query.q,
    includeDeleted: includeDeletedFor(query),
    ...filter,
  });

  const [{ available, accounts }, directory, liveTotal, activeRecently, deletedTotal] =
    await Promise.all([
      describeAccounts(bases.map((base) => base.cognitoSub)),
      getPoolDirectory(),
      countLiveCustomers(),
      countRecentlyActive(new Date(Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000)),
      countDeletedCustomers(),
    ]);
  const { canSend, reason } = availability();

  return {
    items: bases.map((base) => withPool(base, accounts, available)),
    total,
    page: query.page,
    pageSize: query.pageSize,
    counts: {
      total: liveTotal,
      activeRecently,
      // Pool figures, so zero when the pool could not be consulted rather than
      // a number the page would have to caveat.
      invited: directory?.invited ?? 0,
      disabled: directory?.disabled ?? 0,
      // A column, not a pool figure, so it is always known.
      deleted: deletedTotal,
    },
    cognitoAvailable: available,
    cognitoTruncated: directory?.truncated ?? false,
    canSend,
    unavailableReason: reason,
  };
}

/** One customer by `users.id`. */
export async function getCustomer(id: string): Promise<Customer> {
  const base = await findCustomerById(id);
  if (base === null) throw new NotFoundError("That customer does not exist.");
  const { available, accounts } = await describeAccounts([base.cognitoSub]);
  return withPool(base, accounts, available);
}

/* -------------------------------------------------------------------------- */
/*                                   Invites                                  */
/* -------------------------------------------------------------------------- */

/** One page of invitations, with whether this deployment can send any. */
export async function listCustomerInvites(query: ResolvedInviteListQuery): Promise<InviteListResponse> {
  await reconcileAcceptedInvites();
  const page = await listInvites(query);
  const { canSend, reason } = availability();
  return { ...page, canSend, unavailableReason: reason };
}

/** Creates the pool account and sends the invitation email. */
export async function inviteCustomer(
  input: CreateInviteInput,
  actorUserId: string | null,
): Promise<CustomerInvite> {
  return createInvite(input, actorUserId);
}

/** Sends an open invitation again. */
export async function resendCustomerInvite(
  id: string,
  actorUserId: string | null,
): Promise<CustomerInvite> {
  return resendInvite(id, actorUserId);
}

/** Withdraws an open invitation and deletes its unused pool account. */
export async function revokeCustomerInvite(
  id: string,
  actorUserId: string | null,
): Promise<CustomerInvite> {
  return revokeInvite(id, actorUserId);
}
