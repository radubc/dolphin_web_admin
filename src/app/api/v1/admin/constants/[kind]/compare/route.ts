/**
 * /api/v1/admin/constants/[kind]/compare — rebuilds one catalog's sync
 * ledger against the main app database.
 *
 * The compare walks both sides and records, per row, whether the main
 * database is missing it, holds a different version of it or matches; ids that
 * exist only over there are counted as `main_only`. Everything the list
 * endpoint reports as a state comes from what this writes.
 *
 * No request body: the catalog is the `[kind]` segment and there is nothing
 * else to say. Anything sent is ignored rather than trusted. Catalogs of at
 * most `COMPARE_INLINE_MAX` rows finish before the response is sent; larger
 * ones come back `running` and are followed through `GET …/jobs/[jobId]`.
 * Only one compare or push runs per catalog at a time — a second request
 * while one is in flight is a 409 naming the job that holds it.
 *
 * `categories` and `financial_institutions` cannot be compared: the consumer
 * app pulls them at tenant creation rather than holding a pushed copy
 * (`PULLED_KINDS` in `src/lib/constants/types.ts`), so those two answer 409
 * `conflict`. Everything else about them still works.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { parseKind, startCompare } from "@/lib/constants/service";
import type { JobResponse } from "@/lib/constants/types";

type Ctx = RouteContext<"/api/v1/admin/constants/[kind]/compare">;

export const POST = adminHandler<Ctx>(
  async (_request, ctx, principal) => {
    const { kind } = await ctx.params;
    const job = await startCompare(parseKind(kind), principal.user.id);
    return ok<JobResponse>({ job });
  },
  { endpoint: "admin.constants.compare" },
);
