/**
 * /api/v1/admin/constants/[kind]/push — copies the admin catalog into the
 * main app database.
 *
 * Body: exactly one of `{ "ids": ["…"] }` (those rows, at most
 * `PUSH_IDS_MAX`), `{ "scope": "pending" }` (everything the ledger calls new
 * or changed) or `{ "scope": "all" }` (the whole catalog). Rows are upserted
 * **by id** in batches, each batch its own transaction, dependencies first (a
 * country's currency, an account type's base type, a category's ancestors).
 * Nothing is ever deleted over there: a row in the main database may be
 * referenced by tenant data, so removing it stays a deliberate act on the
 * consumer side.
 *
 * The answer is always a job. At most `PUSH_INLINE_MAX` rows finish inline and
 * come back `succeeded` or `failed`; anything larger comes back `running` and
 * is followed through `GET …/jobs/[jobId]`.
 *
 * `push` is a static segment, so it is matched before the sibling `[id]`
 * route and no id may be called "push".
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";
import { pushInputSchema } from "@/lib/constants/schemas";
import { parseKind, startPush } from "@/lib/constants/service";
import type { JobResponse } from "@/lib/constants/types";

type Ctx = RouteContext<"/api/v1/admin/constants/[kind]/push">;

export const POST = adminHandler<Ctx>(
  async (request, ctx, principal) => {
    const { kind } = await ctx.params;
    const catalog = parseKind(kind);
    const input = await parseJsonBody(request, pushInputSchema);
    const job = await startPush(catalog, input, principal.user.id);
    return ok<JobResponse>({ job });
  },
  { endpoint: "admin.constants.push" },
);
