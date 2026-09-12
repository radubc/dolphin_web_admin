/**
 * /api/v1/admin/costs/per-client — the month's allocated cost per tenant.
 *
 * `{ month, monthTotalUsd, pools, tenants, computedAt }`, read from
 * `admin_tenant_cost_monthly` (the nightly `allocate_costs` run writes it)
 * with the pool totals summed from `admin_cost_daily` and the tenant names
 * and owners read live from the main app database.
 *
 * **Never calls AWS and never recomputes.** The allocation is six aggregates
 * of the consumer app's tables per month; doing that per request would spend
 * real time on a figure that moves once a day. A month the run has not
 * covered answers with the pools it can read, an empty `tenants` array and
 * `computedAt: null`, and the page says "not computed yet" rather than
 * drawing zeros as measurements.
 *
 * `?month=YYYY-MM` selects the month; it defaults to the current UTC one and
 * is bounded to `ALLOCATION_MONTH_MIN .. the month after this one` (422
 * outside that). A month with no rows is a 200 with an empty list, not a 404
 * — "we have not allocated that month" is an answer. Before
 * `docs/sql/015_cost_allocation.sql` has run it is a 503
 * `admin_schema_missing`, like every other feature's list.
 *
 * **`ownerEmail` is included only for an operator who may read the customer
 * directory** (`can_read_user_list` or `can_read_user_detail`). The cost
 * actions buy the figures, not the addresses behind them; without one of
 * those two the field is `null` and the read that would have produced it is
 * never made. Documented in `docs/api.md`.
 *
 * Every amount is an **estimate**: AWS bills per resource and every resource
 * except an S3 object is shared by all tenants. See `docs/cost-allocation.md`.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { canDo } from "@/lib/admin-access/types";
import { ok } from "@/lib/api/response";
import { parseSearchParams } from "@/lib/api/validate";
import {
  costPerClientQuerySchema,
  getCostPerClient,
  resolveMonth,
} from "@/lib/costs/allocation";

export const GET = adminHandler(
  async (request, _ctx, principal) => {
    const query = parseSearchParams(request.nextUrl, costPerClientQuerySchema);
    const includeOwnerEmail =
      canDo(principal, "can_read_user_list") || canDo(principal, "can_read_user_detail");
    return ok(await getCostPerClient(resolveMonth(query), { includeOwnerEmail }));
  },
  { endpoint: "admin.costs.per_client" },
);
