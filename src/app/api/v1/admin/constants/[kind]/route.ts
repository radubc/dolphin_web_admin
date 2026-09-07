/**
 * /api/v1/admin/constants/[kind] — one reference catalog in the admin
 * database. `[kind]` is one of `countries`, `currencies`,
 * `financial_institutions`, `categories`, `account_base_types`,
 * `account_types`, `cryptocurrencies`, `etfs`, `stocks`, `markets`; anything
 * else is a 404.
 *
 * GET returns **one page** of the catalog (`?page`, `?pageSize`, `?q`,
 * `?state`, and `?country` for `etfs` and `stocks`), each row carrying the
 * push state the sync ledger holds for it,
 * plus the whole-catalog counts, when the last compare finished and the most
 * recent job. It never compares the two databases: that is what
 * `POST …/compare` is for.
 *
 * POST adds a row here only; nothing reaches the main database until a push.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { created, ok } from "@/lib/api/response";
import { parseJsonBody, parseSearchParams } from "@/lib/api/validate";
import { createSchemaFor, listQuerySchema } from "@/lib/constants/schemas";
import { createWithState, listConstants, parseKind } from "@/lib/constants/service";

type Ctx = RouteContext<"/api/v1/admin/constants/[kind]">;

export const GET = adminHandler<Ctx>(
  async (request, ctx) => {
    const { kind } = await ctx.params;
    const catalog = parseKind(kind);
    const query = parseSearchParams(request.nextUrl, listQuerySchema);
    return ok(await listConstants(catalog, query));
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
