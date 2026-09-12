/**
 * /api/v1/service/defaults/categories — the default category tree the consumer
 * app copies into a tenant it is creating.
 *
 * Machine-to-machine only: the caller presents an `API_KEYS` entry
 * (`x-api-key` or `Authorization: ApiKey`), which is why the path is listed in
 * `PUBLIC_API_PATHS` in `src/proxy.ts` — the proxy would otherwise refuse a
 * request that carries no Cognito cookie.
 *
 * The answer is `{ categories }`: every live admin category (`deleted_at IS
 * NULL`), oldest first, with `type` exactly as stored. No query string — the
 * whole catalog is the point, and the consumer decides nothing about it.
 *
 * **An empty answer is never a success.** A missing admin schema is a 503
 * `admin_schema_missing` and an empty catalog a 503 `defaults_unavailable`, so
 * a tenant is never created with no categories; `src/lib/constants/defaults.ts`
 * raises both.
 */
import { serviceHandler } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { defaultCategories, type DefaultCategoriesResponse } from "@/lib/constants/defaults";
import { RATE_LIMITS } from "@/lib/security/rate-limit";

export const GET = serviceHandler(
  async () => ok<DefaultCategoriesResponse>(await defaultCategories()),
  // The `service` preset per IP as well as per key, like the quote and rate
  // lookups: the default `api` policy (120/min) would cap a machine client far
  // below the 600/min the registry row and docs/api.md advertise.
  { endpoint: "service.defaults.categories", rateLimit: RATE_LIMITS.service },
);
