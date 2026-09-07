/**
 * /api/v1/admin/integrations/[key]/run — starts one integration now.
 *
 * The answer is a `running` run, which the page follows through
 * `GET …/runs/[runId]`: a catalog download moves hundreds of thousands of
 * rows and a quote run paces itself against a per-minute credit allowance, so
 * neither can finish inside a request.
 *
 * Only one run per integration is live at a time — a second request while one
 * is in flight is a 409 naming the run that holds it. An integration whose
 * API key is not configured is refused with a 422 that names the environment
 * variable, rather than starting a run that could only fail.
 *
 * `{ "force": true }` re-fetches every active symbol or pair even if it was
 * already fetched today; the catalog download ignores it, because it only
 * ever inserts rows that are missing.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";
import { runRequestSchema } from "@/lib/integrations/schemas";
import { parseIntegrationKey, startIntegrationRun } from "@/lib/integrations/service";

type Ctx = RouteContext<"/api/v1/admin/integrations/[key]/run">;

export const POST = adminHandler<Ctx>(
  async (request, ctx, principal) => {
    const { key } = await ctx.params;
    const integrationKey = parseIntegrationKey(key);
    // An empty body is normal here ("run it with the defaults"), so a request
    // with no JSON at all is treated as `{}` rather than a 400.
    const body = request.headers.get("content-length") === "0" || !request.body
      ? {}
      : await parseJsonBody(request, runRequestSchema);
    const run = await startIntegrationRun(integrationKey, body, {
      trigger: "manual",
      requestedBy: principal.user.id,
    });
    return ok(run);
  },
  { endpoint: "admin.integrations.run" },
);
