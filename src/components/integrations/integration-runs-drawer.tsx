"use client";

/**
 * The recent runs of one integration: what started each, how it ended, how long
 * it took, what it wrote, and the error when it failed.
 *
 * Read-only and loaded on open — a history nobody is looking at is not worth
 * polling. The live run, if there is one, is followed by the page itself and
 * drawn as the progress strip; this drawer only reports what the server has on
 * record, so a row here is a settled fact.
 *
 * The drawer body is a fixed-height column and the table sits in a
 * `ListTableRegion`, so the rows scroll under their own header rather than
 * taking the note above them off the screen — the same rule the list pages
 * follow.
 */

import { useEffect, useState } from "react";
import { Alert, Button, Drawer, Empty, Spin, Table, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { HistoryOutlined, ReloadOutlined } from "@ant-design/icons";
import { ListTableRegion } from "@/components/list-page-frame";
import { ENTRY_DRAWER_WIDTH } from "@/components/shell/definitions";
import { integrationsApi } from "@/lib/integrations/client";
import type { Integration, IntegrationRun } from "@/lib/integrations/types";
import { errorMessage, formatDateTimeOrDash, formatRelativeTimeOrNever } from "@/lib/format";
import { surfaceColors } from "@/lib/theme/colors";
import { ErrorCell, formatDuration, INTEGRATIONS_COLOR, RunStatusTag, TriggerTag } from "./integrations-meta";

/** How many runs the drawer asks for. Enough to cover a week of daily runs. */
const RUNS_LIMIT = 20;

export default function IntegrationRunsDrawer({
  integration,
  onClose,
}: {
  /** Null closes the drawer. */
  integration: Integration | null;
  onClose: () => void;
}) {
  const [display, setDisplay] = useState<Integration | null>(integration);
  const [runs, setRuns] = useState<IntegrationRun[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  if (integration !== null && integration !== display) setDisplay(integration);

  const key = integration?.key ?? null;

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const next = await integrationsApi.runs(key, RUNS_LIMIT);
        if (cancelled) return;
        setRuns(next);
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, tick]);

  const columns: ColumnsType<IntegrationRun> = [
    {
      title: "Started",
      key: "started",
      width: 190,
      render: (_value, run) => (
        <span className="flex flex-col">
          <Tooltip title={formatDateTimeOrDash(run.startedAt ?? run.createdAt)}>
            <span tabIndex={0}>{formatRelativeTimeOrNever(run.startedAt ?? run.createdAt)}</span>
          </Tooltip>
          <span className="text-xs" style={{ color: surfaceColors.textTertiary }}>
            {formatDuration(run.startedAt, run.finishedAt)}
          </span>
        </span>
      ),
    },
    {
      title: "Status",
      key: "status",
      width: 130,
      render: (_value, run) => <RunStatusTag status={run.status} />,
    },
    {
      title: "Started by",
      key: "trigger",
      width: 130,
      render: (_value, run) => (
        <span className="flex flex-col gap-1">
          <TriggerTag trigger={run.trigger} />
          {run.requestedBy !== null && (
            <span className="text-xs" style={{ color: surfaceColors.textTertiary }}>
              {run.requestedBy}
            </span>
          )}
        </span>
      ),
    },
    {
      title: "Result",
      key: "counters",
      width: 260,
      render: (_value, run) => (
        <span className="flex flex-col text-xs tabular-nums" style={{ color: surfaceColors.textSecondary }}>
          <span>
            {run.processed.toLocaleString()}
            {run.total === null ? "" : ` of ${run.total.toLocaleString()}`} processed
          </span>
          <span>
            {run.created} created · {run.updated} updated · {run.unchanged} unchanged · {run.failed}{" "}
            failed
          </span>
          <ErrorCell error={run.error} />
        </span>
      ),
    },
  ];

  let body: React.ReactNode;
  if (loading && runs === null) {
    body = (
      <div className="flex items-center justify-center py-16">
        <Spin />
      </div>
    );
  } else if (error !== null && runs === null) {
    body = (
      <Alert
        type="error"
        showIcon
        title="The runs could not be loaded."
        description={error}
        action={
          <Button size="small" onClick={() => setTick((value) => value + 1)}>
            Retry
          </Button>
        }
      />
    );
  } else if (runs !== null && runs.length === 0) {
    body = (
      <div className="py-14">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Typography.Text type="secondary">
              This integration has never run. Press Run now, or wait for its schedule.
            </Typography.Text>
          }
        />
      </div>
    );
  } else {
    body = (
      <>
        {error !== null && <Alert type="warning" showIcon closable title={error} />}
        {/* No `ListPanel` around this table — it sits directly in the drawer
            body — so there is no panel border for the region to reserve. */}
        <ListTableRegion panelBorder={false}>
          {(y) => (
            <Table<IntegrationRun>
              dataSource={runs ?? []}
              rowKey="id"
              columns={columns}
              size="small"
              loading={loading}
              pagination={false}
              scroll={{ x: 710, y }}
            />
          )}
        </ListTableRegion>
      </>
    );
  }

  return (
    <Drawer
      open={integration !== null}
      onClose={onClose}
      afterOpenChange={(open) => {
        if (!open) {
          setDisplay(null);
          setRuns(null);
          setError(null);
        }
      }}
      placement="right"
      size={ENTRY_DRAWER_WIDTH}
      destroyOnHidden
      title={
        <span className="flex items-center gap-2">
          <HistoryOutlined style={{ fontSize: 18, color: INTEGRATIONS_COLOR }} />
          <span>{display === null ? "Runs" : `${display.name} · recent runs`}</span>
        </span>
      }
      extra={
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => setTick((value) => value + 1)}
          loading={loading}
        >
          Refresh
        </Button>
      }
      // A column, so the table region below can be given a definite height;
      // the body keeps its own `overflow: auto` for the states that are taller
      // than it — a long error, a narrow window.
      styles={{ body: { background: surfaceColors.page, display: "flex", flexDirection: "column" } }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 [&>*]:shrink-0">
        <Typography.Text type="secondary" className="text-xs">
          The {RUNS_LIMIT} most recent runs, newest first. Every batch commits on its own, so an
          interrupted run has lost nothing — it only has to be started again.
        </Typography.Text>
        {body}
      </div>
    </Drawer>
  );
}
