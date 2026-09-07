"use client";

/**
 * The Integrations view: one card per external provider the admin app calls,
 * with its address, its key, its schedule, what its last run did, and the three
 * things an operator can do about it — run it now, edit it, or read its runs.
 *
 * Cards rather than a table: there is a handful of them and each carries a
 * paragraph's worth of state (a key that may not be configured, a schedule in
 * words, a next run, four counters), which a row would either crush or hide
 * behind an expander.
 *
 * A run belongs to the server. "Run now" hands the run it returns to
 * `useRunPolling`, which draws the progress strip and reports the landing; the
 * page holds that integration's buttons meanwhile, because the API refuses a
 * second run with 409 anyway.
 */

import { useState } from "react";
import { Alert, App, Button, Checkbox, Popconfirm, Spin, Switch, Tag, Tooltip, Typography } from "antd";
import {
  ApiOutlined,
  ClockCircleOutlined,
  EditOutlined,
  HistoryOutlined,
  InfoCircleOutlined,
  KeyOutlined,
  LoadingOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import Figures from "@/components/figures";
import { ListPageFrame, ListPanel } from "@/components/list-page-frame";
import { RibbonBar, RibbonButton } from "@/components/ribbon-bar";
import StatCard from "@/components/stat-card";
import { ApiClientError } from "@/lib/api/client";
import { canDo, type AdminCapabilities } from "@/lib/admin-access/types";
import { integrationsApi } from "@/lib/integrations/client";
import type { Integration, IntegrationRun } from "@/lib/integrations/types";
import { errorMessage, formatDateTimeOrDash, formatRelativeTimeOrNever, pluralise } from "@/lib/format";
import { featureColors, surfaceColors, withAlpha } from "@/lib/theme/colors";
import IntegrationDrawer from "./integration-drawer";
import IntegrationRunStrip from "./integration-run-strip";
import IntegrationRunsDrawer from "./integration-runs-drawer";
import {
  INTEGRATION_NOTES,
  INTEGRATIONS_COLOR,
  providerLabel,
  RUN_STATUS_META,
  RunStatusTag,
  scheduleSummary,
  TriggerTag,
} from "./integrations-meta";
import { useIntegrationsStore } from "./use-integrations-store";
import { useRunPolling } from "./use-run-polling";

/** One labelled fact on a card. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span
        className="text-[11px] font-medium tracking-wide uppercase"
        style={{ color: surfaceColors.textSecondary }}
      >
        {label}
      </span>
      <span className="min-w-0 truncate text-sm" style={{ color: surfaceColors.text }}>
        {children}
      </span>
    </div>
  );
}

/** The key line: configured, missing, or not needed at all. */
function KeyStatus({ integration }: { integration: Integration }) {
  if (!integration.requiresApiKey) {
    return <span style={{ color: surfaceColors.textSecondary }}>No key needed</span>;
  }
  if (integration.apiKeyConfigured) {
    return (
      <span style={{ color: featureColors.loan }}>
        Key configured ({integration.apiKeyEnv ?? "unnamed variable"})
      </span>
    );
  }
  return (
    <span style={{ color: featureColors.rule }}>
      <WarningOutlined aria-hidden /> Key missing: set {integration.apiKeyEnv ?? "the provider's key"}{" "}
      in .env
    </span>
  );
}

/** The newest run's counters, or a line saying there has never been one. */
function LatestRunResult({ run }: { run: IntegrationRun | null }) {
  if (run === null) return <span style={{ color: surfaceColors.textTertiary }}>Never run</span>;
  return (
    <span className="tabular-nums" style={{ color: surfaceColors.textSecondary }}>
      {run.created} created · {run.updated} updated · {run.unchanged} unchanged · {run.failed} failed
    </span>
  );
}

interface IntegrationCardProps {
  integration: Integration;
  canWrite: boolean;
  /** A run for this integration is live: its write controls are held. */
  running: boolean;
  /** A request of this card's is on its way out. */
  busy: boolean;
  onToggleEnabled: (next: boolean) => void;
  onRun: (force: boolean) => void;
  onEdit: () => void;
  onShowRuns: () => void;
}

function IntegrationCard({
  integration,
  canWrite,
  running,
  busy,
  onToggleEnabled,
  onRun,
  onEdit,
  onShowRuns,
}: IntegrationCardProps) {
  // The two catalog downloads only ever insert rows they do not have, so
  // `force` means nothing to them; the checkbox is offered to the ones that
  // re-fetch.
  const forceable =
    integration.key !== "twelvedata_catalogs" && integration.key !== "iso_mic_markets";
  // A sentence for an integration whose behaviour its name does not give away.
  const note = INTEGRATION_NOTES[integration.key];
  const [force, setForce] = useState(false);
  const held = busy || running;
  const keyMissing = integration.requiresApiKey && !integration.apiKeyConfigured;

  return (
    <ListPanel>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span
            aria-hidden
            className="flex items-center justify-center rounded-full text-base"
            style={{
              width: 32,
              height: 32,
              backgroundColor: withAlpha(INTEGRATIONS_COLOR, 0.12),
              color: INTEGRATIONS_COLOR,
            }}
          >
            <ApiOutlined />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-base font-semibold" style={{ color: surfaceColors.text }}>
              {integration.name}
            </span>
            <span className="text-xs" style={{ color: surfaceColors.textTertiary }}>
              {providerLabel(integration.provider)} · <code>{integration.key}</code>
            </span>
          </span>

          <span className="ms-auto flex items-center gap-2">
            {integration.latestRun !== null && <RunStatusTag status={integration.latestRun.status} />}
            {canWrite ? (
              <Tooltip
                title={
                  integration.isEnabled
                    ? "Disable: it stops running on its own and refuses Run now"
                    : "Enable it"
                }
              >
                <Switch
                  checked={integration.isEnabled}
                  disabled={held}
                  onChange={onToggleEnabled}
                  aria-label={`${integration.isEnabled ? "Disable" : "Enable"} ${integration.name}`}
                />
              </Tooltip>
            ) : (
              <Tag color={integration.isEnabled ? "green" : "default"} style={{ marginInlineEnd: 0 }}>
                {integration.isEnabled ? "Enabled" : "Disabled"}
              </Tag>
            )}
          </span>
        </div>

        <Typography.Text type="secondary" className="text-sm">
          {integration.description}
        </Typography.Text>

        {note !== undefined && (
          <span
            className="flex items-start gap-2 rounded-md px-3 py-2 text-xs"
            style={{
              backgroundColor: withAlpha(INTEGRATIONS_COLOR, 0.08),
              color: surfaceColors.textSecondary,
            }}
          >
            <InfoCircleOutlined aria-hidden style={{ color: INTEGRATIONS_COLOR, marginTop: 2 }} />
            <span>{note}</span>
          </span>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Base URL">
            <Tooltip title={integration.baseUrl}>
              <code className="text-xs">{integration.baseUrl}</code>
            </Tooltip>
          </Fact>
          <Fact label="API key">
            <KeyStatus integration={integration} />
          </Fact>
          <Fact label="Schedule">
            <ClockCircleOutlined aria-hidden style={{ color: surfaceColors.textTertiary }} />{" "}
            {scheduleSummary(integration.schedule)}
          </Fact>
          <Fact label="Last run">
            <Tooltip title={formatDateTimeOrDash(integration.lastRunAt)}>
              <span tabIndex={0}>{formatRelativeTimeOrNever(integration.lastRunAt)}</span>
            </Tooltip>
            {integration.latestRun !== null && (
              <>
                {" · "}
                <TriggerTag trigger={integration.latestRun.trigger} />
              </>
            )}
          </Fact>
          <Fact label="Next run">
            {integration.nextRunAt === null ? (
              <span style={{ color: surfaceColors.textTertiary }}>
                {integration.isEnabled ? "Not scheduled" : "Disabled"}
              </span>
            ) : (
              <Tooltip title={formatDateTimeOrDash(integration.nextRunAt)}>
                <span tabIndex={0}>{formatRelativeTimeOrNever(integration.nextRunAt)}</span>
              </Tooltip>
            )}
          </Fact>
          <Fact label="Latest result">
            <LatestRunResult run={integration.latestRun} />
          </Fact>
        </div>

        {integration.latestRun !== null &&
          integration.latestRun.error !== null &&
          integration.latestRun.error !== "" && (
          <Alert
            type="error"
            showIcon
            title="The last run reported an error."
            description={integration.latestRun.error}
          />
        )}

        {keyMissing && (
          <Alert
            type="warning"
            showIcon
            icon={<KeyOutlined />}
            title={`Key missing: set ${integration.apiKeyEnv ?? "the provider's key"} in .env`}
            description="Until it is set the provider refuses every call, and Run now is answered with an error."
          />
        )}

        {canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            <Popconfirm
              title={`Run ${integration.name} now`}
              description={
                <span className="flex max-w-xs flex-col gap-2">
                  <span>
                    {forceable
                      ? "The run works through every active item on the watch list and writes what the provider returns."
                      : "The download inserts only the rows the admin catalogs do not have yet. Nothing existing is changed or removed."}
                  </span>
                  {forceable && (
                    <Checkbox checked={force} onChange={(event) => setForce(event.target.checked)}>
                      Refresh everything, even items fetched today
                    </Checkbox>
                  )}
                </span>
              }
              okText="Run now"
              cancelText="Cancel"
              disabled={held || !integration.isEnabled}
              onConfirm={() => onRun(forceable && force)}
            >
              <Button
                type="primary"
                icon={running ? <LoadingOutlined /> : <PlayCircleOutlined />}
                disabled={held || !integration.isEnabled}
              >
                {running ? "Running…" : "Run now"}
              </Button>
            </Popconfirm>

            <Button icon={<EditOutlined />} onClick={onEdit} disabled={busy}>
              Edit
            </Button>

            <Button icon={<HistoryOutlined />} onClick={onShowRuns}>
              Runs
            </Button>

            {!integration.isEnabled && (
              <Typography.Text type="secondary" className="text-xs">
                Disabled: enable it before it can run.
              </Typography.Text>
            )}
          </div>
        )}

        {!canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            <Button icon={<HistoryOutlined />} onClick={onShowRuns}>
              Runs
            </Button>
          </div>
        )}
      </div>
    </ListPanel>
  );
}

export default function IntegrationsView({
  capabilities,
  switcher,
}: {
  capabilities: AdminCapabilities;
  /** The view segmented control, drawn at the top of the body by every view. */
  switcher: React.ReactNode;
}) {
  const { message, notification } = App.useApp();
  const store = useIntegrationsStore();
  const runs = useRunPolling(store.integrations);
  const [editing, setEditing] = useState<Integration | null>(null);
  const [showingRuns, setShowingRuns] = useState<Integration | null>(null);
  /** The key whose request is on its way out; its card's buttons are held. */
  const [requesting, setRequesting] = useState<string | null>(null);

  const canWrite = canDo(capabilities, "can_write_integrations");
  const { integrations } = store;

  const enabled = integrations.filter((integration) => integration.isEnabled).length;
  const scheduled = integrations.filter(
    (integration) => integration.isEnabled && integration.schedule.frequency !== "off",
  ).length;
  const liveCount = Object.keys(runs.live).length;
  const failing = integrations.filter(
    (integration) =>
      integration.latestRun !== null &&
      (integration.latestRun.status === "failed" || integration.latestRun.status === "interrupted"),
  ).length;
  const keysMissing = integrations.filter(
    (integration) => integration.requiresApiKey && !integration.apiKeyConfigured,
  ).length;

  /** The two refusals the API has words for, said in the page's own voice. */
  const reportFailure = (integration: Integration, cause: unknown) => {
    if (cause instanceof ApiClientError && cause.status === 409) {
      notification.warning({
        title: `${integration.name} is already running`,
        description: cause.message,
        duration: 6,
      });
      return;
    }
    if (cause instanceof ApiClientError && cause.status === 422) {
      notification.warning({
        title: `${integration.name} is not configured`,
        description: cause.message,
        duration: 8,
      });
      return;
    }
    message.error(errorMessage(cause));
  };

  const runNow = async (integration: Integration, force: boolean) => {
    setRequesting(integration.key);
    try {
      runs.track(await integrationsApi.start(integration.key, force ? { force: true } : {}));
    } catch (cause) {
      reportFailure(integration, cause);
    } finally {
      setRequesting(null);
    }
  };

  const toggleEnabled = async (integration: Integration, next: boolean) => {
    setRequesting(integration.key);
    try {
      await integrationsApi.update(integration.key, { isEnabled: next });
      message.success(`${integration.name} ${next ? "enabled" : "disabled"}.`);
    } catch (cause) {
      reportFailure(integration, cause);
    } finally {
      setRequesting(null);
    }
  };

  /* --------------------------------- header -------------------------------- */

  const figures = (
    <Figures
      label="Integration totals"
      figures={[
        {
          label: "Integrations",
          value: integrations.length.toLocaleString(),
          tooltip: "The providers this app calls. They are seeded, never created here.",
        },
        {
          label: "Enabled",
          value: enabled.toLocaleString(),
          color: enabled > 0 ? featureColors.loan : undefined,
          tooltip: "Enabled integrations. A disabled one never runs and refuses Run now.",
          separatorBefore: true,
        },
        {
          label: "Scheduled",
          value: scheduled.toLocaleString(),
          tooltip: "Enabled and on a frequency other than Off.",
        },
        {
          label: "Running",
          value: liveCount.toLocaleString(),
          color: liveCount > 0 ? featureColors.banking : undefined,
          tooltip: "Runs live on the server right now.",
          separatorBefore: true,
        },
        {
          label: "Needs attention",
          value: (failing + keysMissing).toLocaleString(),
          color: failing + keysMissing > 0 ? featureColors.rule : undefined,
          tooltip: "Integrations whose last run failed or was interrupted, or whose API key is not set.",
        },
      ]}
    />
  );

  const outcomes = {
    succeeded: integrations.filter((i) => i.latestRun?.status === "succeeded").length,
    failed: integrations.filter((i) => i.latestRun?.status === "failed").length,
    interrupted: integrations.filter((i) => i.latestRun?.status === "interrupted").length,
    never: integrations.filter((i) => i.latestRun === null).length,
  };

  const rail = (
    <div className="flex flex-col gap-4">
      <StatCard
        title="How the last run ended"
        icon={<ApiOutlined style={{ color: INTEGRATIONS_COLOR }} />}
        total={Math.max(1, integrations.length)}
        rows={[
          {
            label: RUN_STATUS_META.succeeded.label,
            value: outcomes.succeeded,
            color: RUN_STATUS_META.succeeded.color,
            tooltip: RUN_STATUS_META.succeeded.tooltip,
          },
          {
            label: RUN_STATUS_META.failed.label,
            value: outcomes.failed,
            color: RUN_STATUS_META.failed.color,
            tooltip: RUN_STATUS_META.failed.tooltip,
          },
          {
            label: RUN_STATUS_META.interrupted.label,
            value: outcomes.interrupted,
            color: RUN_STATUS_META.interrupted.color,
            tooltip: RUN_STATUS_META.interrupted.tooltip,
          },
          {
            label: "Never run",
            value: outcomes.never,
            color: featureColors.neutral,
            tooltip: "No run on record yet.",
          },
        ]}
        footnote="Individual items a provider refused are counted as failed inside an otherwise successful run."
      />

      {keysMissing > 0 && (
        <Alert
          type="warning"
          showIcon
          title={`${pluralise(keysMissing, "integration")} cannot call its provider.`}
          description="The environment variable named on the card is not set in this deployment. Set it in .env and restart the app; the key itself never travels to this page."
        />
      )}
    </div>
  );

  const ribbon = (
    <RibbonBar
      trailing={
        <span
          className="shrink-0 pr-1 text-right text-[11px] tabular-nums"
          style={{ color: surfaceColors.textSecondary }}
        >
          {liveCount > 0 && (
            <>
              <LoadingOutlined aria-hidden /> {pluralise(liveCount, "run")} in flight{" · "}
            </>
          )}
          {pluralise(integrations.length, "integration")} · {enabled} enabled ·{" "}
          {store.schedulerActive ? "scheduler on" : "scheduler off"}
        </span>
      }
    >
      <RibbonButton
        label="Refresh"
        icon={store.refreshing ? <LoadingOutlined /> : <ReloadOutlined />}
        onClick={store.reload}
        disabled={store.refreshing}
        tooltip="Reload the integrations, their schedules and their newest runs"
      />
    </RibbonBar>
  );

  /* ---------------------------------- body --------------------------------- */

  let body: React.ReactNode;
  if (store.loading) {
    body = (
      <ListPanel>
        <div className="flex items-center justify-center py-16">
          <Spin />
        </div>
      </ListPanel>
    );
  } else if (!store.loaded) {
    body = (
      <Alert
        type="error"
        showIcon
        title="The integrations could not be loaded."
        description={store.error ?? undefined}
        action={
          <Button size="small" onClick={store.reload}>
            Retry
          </Button>
        }
      />
    );
  } else {
    body = (
      <>
        {store.error !== null && <Alert type="warning" showIcon closable title={store.error} />}

        {!store.schedulerActive && (
          <Alert
            type="info"
            showIcon
            title="The scheduler is off in this process (INTEGRATIONS_SCHEDULER=off); nothing runs on its own."
            description="Schedules are still saved and still shown; they are simply not being kept here. Run now works as usual."
          />
        )}

        {integrations.map((integration) => {
          const live = runs.live[integration.key];
          return live === undefined ? null : (
            <IntegrationRunStrip key={`${integration.key}-strip`} name={integration.name} run={live} />
          );
        })}

        {integrations.map((integration) => (
          <IntegrationCard
            key={integration.key}
            integration={integration}
            canWrite={canWrite}
            running={runs.isRunning(integration.key)}
            busy={requesting === integration.key}
            onToggleEnabled={(next) => {
              void toggleEnabled(integration, next);
            }}
            onRun={(force) => {
              void runNow(integration, force);
            }}
            onEdit={() => setEditing(integration)}
            onShowRuns={() => setShowingRuns(integration)}
          />
        ))}
      </>
    );
  }

  return (
    <>
      <ListPageFrame
        title="Integrations"
        caption="External providers this app calls on a schedule, and the watch lists they keep current."
        figures={store.loaded ? figures : undefined}
        ribbon={ribbon}
        rail={store.loaded ? rail : undefined}
      >
        {switcher}
        {body}
      </ListPageFrame>

      <IntegrationDrawer
        integration={editing}
        onClose={() => setEditing(null)}
        onSaved={(summary) => message.success(summary)}
      />

      <IntegrationRunsDrawer integration={showingRuns} onClose={() => setShowingRuns(null)} />
    </>
  );
}
