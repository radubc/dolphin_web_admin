/**
 * /api/v1/admin/integrations/currency-pairs/[id]/backfill — six months of
 * history for one watched pair, now.
 *
 * The button beside Refresh in the pair's download-history drawer. It takes no
 * body: the window is always `today − 182 days` → today, the same one a manual
 * add uses, so the two answers mean the same thing. One ranged Bank of Canada
 * call, recorded as an inline `on_demand` run, and the answer carries the watch
 * row as it now stands plus what the fetch did
 * (`{ pair, history: { status, days, from, to, latestDate, … } }`).
 *
 * An **inactive** pair is a 409: switching a pair off is an operator's
 * decision, and no fetch overturns it — the same rule the on-demand lookup
 * follows. A provider that is down, disabled or busy is **not** an error here;
 * it comes back as `history.status` with a message, because nothing was asked
 * for beyond "try".
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { backfillCurrencyPairHistory } from "@/lib/integrations/service";

type Ctx = RouteContext<"/api/v1/admin/integrations/currency-pairs/[id]/backfill">;

export const POST = adminHandler<Ctx>(
  async (_request, ctx, principal) => {
    const { id } = await ctx.params;
    return ok(await backfillCurrencyPairHistory(id, principal.user.id));
  },
  { endpoint: "admin.integrations.currency_pairs.backfill" },
);
