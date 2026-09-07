/**
 * /api/v1/admin/customers/invites — invitations to the consumer app.
 *
 * GET answers one page (`?page`, `?pageSize`, `?q`, `?status`) with the counts
 * per status and whether this deployment can send an invitation at all
 * (`canSend`, `unavailableReason`).
 *
 * POST creates the Cognito account in the **customer** pool and lets Cognito
 * email the temporary password. 409 when the address already has an account
 * or an open invitation; 503 `cognito_unavailable` when the pool is not
 * configured or the deployment's AWS credentials do not allow it.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { created, ok } from "@/lib/api/response";
import { parseJsonBody, parseSearchParams } from "@/lib/api/validate";
import { createInviteSchema, inviteListQuerySchema } from "@/lib/customers/schemas";
import { inviteCustomer, listCustomerInvites } from "@/lib/customers/service";

export const GET = adminHandler(
  async (request) => {
    const query = parseSearchParams(request.nextUrl, inviteListQuerySchema);
    return ok(await listCustomerInvites(query));
  },
  { endpoint: "admin.customers.invites.list" },
);

export const POST = adminHandler(
  async (request, _ctx, principal) => {
    const input = await parseJsonBody(request, createInviteSchema);
    return created(await inviteCustomer(input, principal.user.id));
  },
  { endpoint: "admin.customers.invites.create" },
);
