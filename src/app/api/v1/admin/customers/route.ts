/**
 * /api/v1/admin/customers — the consumer app's users.
 *
 * One page of customers (`?page`, `?pageSize`, `?q`, `?status`,
 * `?includeDeleted`), each with their tenants, when they last changed
 * anything, how many accounts and transactions they have, and what the
 * customer Cognito pool says about the account. `cognitoAvailable` is false
 * when the pool could not be consulted; the list still answers from the
 * database alone. `cognitoTruncated` is true when the pool listing hit its
 * page cap, so the pool-derived counts and statuses cover only part of the
 * pool. `canSend` and `unavailableReason` carry the same invite-availability
 * verdict as the invitations list, so the invite drawer knows before the
 * operator presses Send whichever view it was opened from.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { parseSearchParams } from "@/lib/api/validate";
import { customerListQuerySchema } from "@/lib/customers/schemas";
import { listCustomers } from "@/lib/customers/service";

export const GET = adminHandler(
  async (request) => {
    const query = parseSearchParams(request.nextUrl, customerListQuerySchema);
    return ok(await listCustomers(query));
  },
  { endpoint: "admin.customers.list" },
);
