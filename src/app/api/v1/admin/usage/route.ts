/**
 * GET /api/v1/admin/usage — per-endpoint counters over the last 30 days, for
 * the Services page. Also returns the rate-limit presets so the page can print
 * the numbers next to each endpoint's policy name.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { getAdminAccessRepository } from "@/lib/admin-access/repository";
import { ok } from "@/lib/api/response";
import { RATE_LIMITS } from "@/lib/security/rate-limit";

export const GET = adminHandler(
  async () =>
    ok({
      usage: await getAdminAccessRepository().listUsage(),
      rateLimits: Object.fromEntries(
        Object.entries(RATE_LIMITS).map(([name, policy]) => [name, { limit: policy.limit, windowMs: policy.windowMs }]),
      ),
    }),
  { endpoint: "admin.usage.list" },
);
