/**
 * Overview → "Activity funnel": invited → confirmed → onboarded → first
 * transaction → first attachment, and where new customers stall.
 *
 * The first two steps come from the nightly Cognito directory snapshot and
 * the last three from the main app database, which is why a deployment whose
 * `cognito_directory` job has never run sees the top of the funnel as zero:
 * the card says so instead of drawing it as a measurement.
 *
 * Bars are a share of the **widest** step, not of the first one, and the
 * steps are never forced to descend. A step wider than the one above it is a
 * real inconsistency worth seeing — somebody onboarded whose pool account has
 * since gone, for instance — rather than a rendering problem worth hiding.
 * That is the same rule the Customers page's Activity view follows.
 */

import type { CustomerFunnel } from "@/lib/customers/types";
import { formatIsoDay } from "@/lib/format";
import { featureColors } from "@/lib/theme/colors";
import type { Loaded } from "@/lib/ops/types";
import { BarRow, NotAvailable, OverviewCard } from "./card";

const FUNNEL_COLOR = featureColors.accessMap;

export default function FunnelCard({
  funnel,
  className,
}: {
  funnel: Loaded<CustomerFunnel>;
  className?: string;
}) {
  if (!funnel.ok) {
    return (
      <OverviewCard title="Activity funnel" accent={FUNNEL_COLOR} className={className}>
        <NotAvailable reason={funnel.reason} />
      </OverviewCard>
    );
  }

  const { invited, confirmed, onboarded, firstTransaction, firstAttachment, snapshotDay } =
    funnel.data;

  const steps = [
    {
      label: "Invited",
      value: invited,
      help: "Accounts in the newest customer-pool snapshot. There is no self-service sign-up, so every account started as an invitation.",
    },
    {
      label: "Confirmed",
      value: confirmed,
      help: "Of those, the accounts whose owner has set their own password.",
    },
    {
      label: "Onboarded",
      value: onboarded,
      help: "Live users rows with at least one live tenant membership: they signed in and finished onboarding.",
    },
    {
      label: "First transaction",
      value: firstTransaction,
      help: "Of those, the ones whose tenant holds at least one live transaction.",
    },
    {
      label: "First attachment",
      value: firstAttachment,
      help: "Of those, the ones whose tenant holds at least one live file.",
    },
  ];

  const widest = Math.max(...steps.map((step) => step.value), 1);

  return (
    <OverviewCard
      title="Activity funnel"
      accent={FUNNEL_COLOR}
      className={className}
      badge={snapshotDay === null ? "no pool snapshot" : `pool ${formatIsoDay(snapshotDay)}`}
      footnote={
        snapshotDay === null
          ? "Invited and Confirmed stay at zero until the nightly cognito_directory job has taken its first snapshot."
          : "Invited and Confirmed come from the pool snapshot; the rest from the app database. Steps are shown as measured, never forced to descend."
      }
    >
      {steps.map((step) => (
        <BarRow
          key={step.label}
          label={step.label}
          value={step.value.toLocaleString("en-US")}
          share={step.value / widest}
          color={FUNNEL_COLOR}
          help={step.help}
        />
      ))}
    </OverviewCard>
  );
}
