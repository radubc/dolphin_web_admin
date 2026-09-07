/**
 * /api/v1/admin/constants/[kind]/jobs — the catalog's recent compare and push
 * jobs, newest first, with progress and counters. `?limit=` is 1..50 and
 * defaults to 10.
 *
 * A job that has gone stale — `running` with an old heartbeat, or `queued`
 * since before `JOB_STALE_AFTER_MS` — is reported as `interrupted`, and so is
 * the `failed` row a later job closed it with. The process that ran it went
 * away; nothing it committed is lost, so the answer is simply to run it again.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { parseSearchParams } from "@/lib/api/validate";
import { jobsQuerySchema } from "@/lib/constants/schemas";
import { listConstantJobs, parseKind } from "@/lib/constants/service";

type Ctx = RouteContext<"/api/v1/admin/constants/[kind]/jobs">;

export const GET = adminHandler<Ctx>(
  async (request, ctx) => {
    const { kind } = await ctx.params;
    const { limit } = parseSearchParams(request.nextUrl, jobsQuerySchema);
    return ok(await listConstantJobs(parseKind(kind), limit));
  },
  { endpoint: "admin.constants.jobs.list" },
);
