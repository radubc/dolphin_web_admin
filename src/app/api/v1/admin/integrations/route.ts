/**
 * /api/v1/admin/integrations — every integration, each with its
 * schedule, settings, latest run and whether its API key is configured
 * (presence only; the key itself never leaves the server).
 *
 * `schedulerActive` says whether *this* process runs the 60-second scheduler
 * tick, so the page can tell an operator that nothing will start on its own
 * (`INTEGRATIONS_SCHEDULER=off`).
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { listIntegrations } from "@/lib/integrations/service";

export const GET = adminHandler(
  async () => ok(await listIntegrations()),
  { endpoint: "admin.integrations.list" },
);
