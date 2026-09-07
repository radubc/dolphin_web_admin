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
 */
function deriveStatus(account: CustomerCognitoAccount | null, poolAvailable: boolean): CustomerStatus {
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
  return { ...base, cognito: account, status: deriveStatus(account, poolAvailable) };
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
): Promise<{ subsIn?: string[]; subsNotIn?: string[] }> {
  if (status === "all") return {};
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
    includeDeleted: query.includeDeleted,
    ...filter,
  });

  const [{ available, accounts }, directory, liveTotal, activeRecently] = await Promise.all([
    describeAccounts(bases.map((base) => base.cognitoSub)),
    getPoolDirectory(),
    countLiveCustomers(),
    countRecentlyActive(new Date(Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000)),
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
