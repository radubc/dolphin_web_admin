/**
 * /api/v1/admin/constants/[kind]/push — copies the admin catalog into the
 * main app database.
 *
 * Body: `{ "ids": ["…"] }` for a selection, `{}` for the whole catalog. Rows
 * are upserted **by id** in one transaction, dependencies first (a country's
 * currency, a category's ancestors). Nothing is ever deleted over there: a row
 * in the main database may be referenced by tenant data, so removing it stays
 * a deliberate act on the consumer side.
 *
 * `push` is a static segment, so it is matched before the sibling `[id]`
 * route and no id may be called "push".
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";
import { pushInputSchema } from "@/lib/constants/schemas";
import { parseKind, push } from "@/lib/constants/service";

type Ctx = RouteContext<"/api/v1/admin/constants/[kind]/push">;

export const POST = adminHandler<Ctx>(
  async (request, ctx, principal) => {
    const { kind } = await ctx.params;
    const catalog = parseKind(kind);
    const { ids } = await parseJsonBody(request, pushInputSchema);
    return ok(await push(catalog, { ids, actorUserId: principal.user.id }));
  },
  { endpoint: "admin.constants.push" },
);
