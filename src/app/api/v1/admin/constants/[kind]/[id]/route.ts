/**
 * /api/v1/admin/constants/[kind]/[id] — one row of a reference catalog.
 *
 * GET returns it with its push state, PATCH applies a partial change, DELETE
 * retires a category (`deleted_at`) or removes a row of the other three kinds.
 * All three act on the **admin** database only: the main app database keeps
 * whatever it already has until the next push.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { noContent, ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";
import { patchSchemaFor } from "@/lib/constants/schemas";
import { getWithState, parseKind, removeConstant, updateWithState } from "@/lib/constants/service";

type Ctx = RouteContext<"/api/v1/admin/constants/[kind]/[id]">;

export const GET = adminHandler<Ctx>(
  async (_request, ctx) => {
    const { kind, id } = await ctx.params;
    return ok(await getWithState(parseKind(kind), id));
  },
  { endpoint: "admin.constants.get" },
);

export const PATCH = adminHandler<Ctx>(
  async (request, ctx) => {
    const { kind, id } = await ctx.params;
    const catalog = parseKind(kind);
    const patch = await parseJsonBody(request, patchSchemaFor(catalog));
    return ok(await updateWithState(catalog, id, patch));
  },
  { endpoint: "admin.constants.update" },
);

export const DELETE = adminHandler<Ctx>(
  async (_request, ctx) => {
    const { kind, id } = await ctx.params;
    await removeConstant(parseKind(kind), id);
    return noContent();
  },
  { endpoint: "admin.constants.delete" },
);
