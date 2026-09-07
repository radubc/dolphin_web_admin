/**
 * /api/v1/admin/constants/[kind]/jobs/[jobId] — one compare or push job, for
 * polling while it runs.
 *
 * A job id that is not a UUID, or one that belongs to another catalog, is a
 * 404: from the caller's side that job does not exist, and the shape of the
 * id is not something the answer should confirm.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { NotFoundError } from "@/lib/api/errors";
import { ok } from "@/lib/api/response";
import { getConstantJob, parseKind } from "@/lib/constants/service";

type Ctx = RouteContext<"/api/v1/admin/constants/[kind]/jobs/[jobId]">;

/** Any RFC 4122 variant; the column is a Postgres `uuid`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = adminHandler<Ctx>(
  async (_request, ctx) => {
    const { kind, jobId } = await ctx.params;
    const catalog = parseKind(kind);
    // Checked before the query so a hand-typed id cannot reach Prisma as a
    // malformed uuid, which would be a 500 rather than a 404.
    if (!UUID.test(jobId)) throw new NotFoundError("That job does not exist.");
    return ok(await getConstantJob(catalog, jobId));
  },
  { endpoint: "admin.constants.jobs.get" },
);
