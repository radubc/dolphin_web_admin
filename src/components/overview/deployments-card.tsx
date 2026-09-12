/**
 * Overview → "Deployments": what ECS is running, per service.
 *
 * One `ecs:DescribeServices` call, cached for a minute
 * (`src/lib/ops/deploy.ts`): running against desired tasks, the task
 * definition revision, the rollout state, and the newest service event —
 * which is where a rollout that is failing says why.
 *
 * **No image tag.** It lives in the task definition, which needs
 * `ecs:DescribeTaskDefinition`; the task role is granted `DescribeServices`
 * only, so the revision stands in and the card says as much
 * (`IMAGE_TAG_NOTE`).
 */

import { formatRelativeTimeOrNever } from "@/lib/format";
import { featureColors, surfaceColors } from "@/lib/theme/colors";
import { IMAGE_TAG_NOTE, type DeployHealth, type DeployService, type Loaded } from "@/lib/ops/types";
import { NotAvailable, OverviewCard, Pill, Waiting } from "./card";

const DEPLOY_COLOR = featureColors.integrations;

/** The colour a rollout state is painted. Anything unknown stays neutral. */
function rolloutColor(state: string | null, healthy: boolean): string {
  switch (state) {
    case "COMPLETED":
      return healthy ? featureColors.loan : featureColors.incomeBills;
    case "IN_PROGRESS":
      return featureColors.banking;
    case "FAILED":
      return featureColors.rule;
    default:
      return surfaceColors.textSecondary;
  }
}

export default function DeploymentsCard({
  deploy,
  className,
}: {
  deploy: Loaded<DeployHealth>;
  className?: string;
}) {
  if (!deploy.ok) {
    return (
      <OverviewCard title="Deployments" accent={DEPLOY_COLOR} className={className}>
        <NotAvailable reason={deploy.reason} />
      </OverviewCard>
    );
  }

  const { cluster, services, fetchedAt, error } = deploy.data;

  return (
    <OverviewCard
      title="Deployments"
      accent={DEPLOY_COLOR}
      className={className}
      badge={
        <>
          {cluster ?? "no cluster set"}
          <br />
          read {formatRelativeTimeOrNever(fetchedAt)}
        </>
      }
      footnote={IMAGE_TAG_NOTE}
    >
      {error !== null && <NotAvailable reason={error} />}
      {error === null && services.length === 0 && (
        <Waiting>No ECS service is configured for this card.</Waiting>
      )}
      {services.map((service) => (
        <ServiceRow key={service.name} service={service} />
      ))}
    </OverviewCard>
  );
}

function ServiceRow({ service }: { service: DeployService }) {
  const healthy =
    service.running !== null && service.desired !== null && service.running >= service.desired;
  const color = rolloutColor(service.rolloutState, healthy);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm" style={{ color: surfaceColors.text }}>
          {service.name}
        </span>
        {service.error === null ? (
          <span className="flex shrink-0 items-baseline gap-2">
            <span
              className="text-sm font-semibold tabular-nums"
              style={{ color: healthy ? surfaceColors.text : featureColors.incomeBills }}
              title="Running tasks against desired tasks"
            >
              {service.running ?? "—"}/{service.desired ?? "—"}
            </span>
            <Pill color={color}>{service.rolloutState ?? service.status ?? "unknown"}</Pill>
          </span>
        ) : (
          <Pill color={featureColors.rule}>error</Pill>
        )}
      </div>

      {service.error !== null ? (
        <span className="text-[11px] leading-snug" style={{ color: surfaceColors.textSecondary }}>
          {service.error}
        </span>
      ) : (
        <>
          <span
            className="truncate text-[11px] tabular-nums"
            style={{ color: surfaceColors.textTertiary }}
            title="Task definition family and revision"
          >
            {service.taskDefinition ?? "no task definition"}
            {service.pending !== null && service.pending > 0 && ` · ${service.pending} pending`}
            {service.updatedAt !== null &&
              ` · rolled out ${formatRelativeTimeOrNever(service.updatedAt)}`}
          </span>
          {(service.rolloutStateReason ?? service.lastEvent?.message) !== undefined && (
            <span
              className="line-clamp-2 text-[11px] leading-snug"
              style={{ color: surfaceColors.textSecondary }}
              title={service.lastEvent?.at ?? undefined}
            >
              {service.rolloutStateReason ?? service.lastEvent?.message}
            </span>
          )}
        </>
      )}
    </div>
  );
}
