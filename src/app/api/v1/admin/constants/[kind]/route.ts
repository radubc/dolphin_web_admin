/**
 * /api/v1/admin/constants/[kind] — one reference catalog in the admin
 * database. `[kind]` is one of `countries`, `currencies`,
 * `financial_institutions`, `categories`; anything else is a 404.
 *
 * GET lists every row with its state against the main app database, plus the
 * ids the main database still has that this catalog no longer does. POST adds
 * a row here only; nothing reaches the main database until a push.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { created, ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";
import { createSchemaFor } from "@/lib/constants/schemas";
import { createWithState, listWithState, parseKind } from "@/lib/constants/service";

type Ctx = RouteContext<"/api/v1/admin/constants/[kind]">;

export const GET = adminHandler<Ctx>(
  async (_request, ctx) => {
    const { kind } = await ctx.params;
    return ok(await listWithState(parseKind(kind)));
  },
  { endpoint: "admin.constants.list" },
);

export const POST = adminHandler<Ctx>(
  async (request, ctx) => {
    const { kind } = await ctx.params;
    const catalog = parseKind(kind);
    const input = await parseJsonBody(request, createSchemaFor(catalog));
    return created(await createWithState(catalog, input));
  },
  { endpoint: "admin.constants.create" },
);
