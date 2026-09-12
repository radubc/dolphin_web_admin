/**
 * Overview → "Customers": how many accounts there are, how many people used
 * the product in the last thirty days, and how the month is moving.
 *
 * Every figure comes from `customerHeadline()`, which exists for this card:
 * six small queries, no monthly series and no per-tenant aggregates, because
 * a dashboard card that costs as much as a whole page will not be put on a
 * dashboard. The definitions — what MAU counts, what "deleted" means, how
 * churn is divided — live in `src/lib/customers/statistics.ts` and are
 * summarised in `docs/customers.md`; nothing is redefined here.
 */

import { MAU_WINDOW_DAYS, type CustomerHeadline } from "@/lib/customers/types";
import { formatPercentOrDash } from "@/lib/format";
import { featureColors } from "@/lib/theme/colors";
import type { Loaded } from "@/lib/ops/types";
import { Figure, FigureRow, NotAvailable, OverviewCard } from "./card";

/** The same blue the Customers tab and its quick action wear. */
const CUSTOMERS_COLOR = featureColors.users;

/** Where churn stops being noise. Amber above it, red at twice it. */
const CHURN_WARN_PCT = 5;

export default function CustomersCard({
  headline,
  className,
}: {
  headline: Loaded<CustomerHeadline>;
  className?: string;
}) {
  if (!headline.ok) {
    return (
      <OverviewCard title="Customers" accent={CUSTOMERS_COLOR} className={className}>
        <NotAvailable reason={headline.reason} />
      </OverviewCard>
    );
  }

  const { accountsTotal, mau, newThisMonth, deletedThisMonth, churnPct } = headline.data;
  const churnColor =
    churnPct === null
      ? undefined
      : churnPct >= CHURN_WARN_PCT * 2
        ? featureColors.rule
        : churnPct >= CHURN_WARN_PCT
          ? featureColors.incomeBills
          : featureColors.loan;

  return (
    <OverviewCard
      title="Customers"
      accent={CUSTOMERS_COLOR}
      className={className}
      badge={`${MAU_WINDOW_DAYS}-day window`}
      footnote="Accounts from last night's Cognito snapshot (live users rows until the first run). Months are UTC calendar months."
    >
      <FigureRow>
        <Figure
          label="Accounts"
          value={accountsTotal.toLocaleString("en-US")}
          help="Accounts in the newest customer-pool snapshot, or live users rows before the nightly cognito_directory job has run."
        />
        <Figure
          label="Active"
          value={mau.toLocaleString("en-US")}
          hint={`seen in ${MAU_WINDOW_DAYS} days`}
          help="Live users rows whose last_seen_at falls inside the window. Not sign-ins: someone signed in all week is one active user."
        />
      </FigureRow>
      <FigureRow>
        <Figure
          label="New"
          value={newThisMonth.toLocaleString("en-US")}
          hint="this month"
          color={newThisMonth > 0 ? featureColors.loan : undefined}
          help="users rows created since the 1st, UTC: people who reached the app, not invitations sent."
        />
        <Figure
          label="Departed"
          value={deletedThisMonth.toLocaleString("en-US")}
          hint="this month"
          color={deletedThisMonth > 0 ? featureColors.rule : undefined}
          help="deleted and deleted_in_app lifecycle events this month, deduped per Cognito sub."
        />
        <Figure
          label="Churn"
          value={formatPercentOrDash(churnPct)}
          color={churnColor}
          help="Departures this month over the accounts that were active at 00:00 UTC on the 1st. A month that began with nobody has no rate."
        />
      </FigureRow>
    </OverviewCard>
  );
}
