/**
 * /api/v1/service/defaults/financial-institutions — the default financial
 * institutions the consumer app copies into a tenant it is creating.
 *
 * Machine-to-machine only, same as the default categories: an `API_KEYS` entry,
 * and the path listed in `PUBLIC_API_PATHS` in `src/proxy.ts`.
 *
 * The answer is `{ financialInstitutions }`: the whole admin catalog by name.
 * The table has no retirement column, so every row is current.
 *
 * **An empty answer is never a success**: a missing admin schema is a 503
 * `admin_schema_missing` and an empty catalog a 503 `defaults_unavailable`
 * (raised in `src/lib/constants/defaults.ts`).
 */
import { serviceHandler } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import {
  defaultFinancialInstitutions,
  type DefaultFinancialInstitutionsResponse,
} from "@/lib/constants/defaults";
import { RATE_LIMITS } from "@/lib/security/rate-limit";

export const GET = serviceHandler(
  async () => ok<DefaultFinancialInstitutionsResponse>(await defaultFinancialInstitutions()),
  // The `service` preset per IP as well as per key, like the other service
  // endpoints; the default `api` policy would cap a machine client at 120/min.
  { endpoint: "service.defaults.financial_institutions", rateLimit: RATE_LIMITS.service },
);
