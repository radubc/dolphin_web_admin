"use client";

/**
 * The strip under the ribbon while an integration is running on the server.
 *
 * A run over a whole watch list takes minutes and is paced by the provider's
 * credit allowance, so the page says what is running, how far it has got and —
 * the part an operator most needs to read — that the work belongs to the
 * server: there is no cancel, and closing the page only stops the watching.
 * The bar goes indeterminate until the run knows its own total.
 */

import { Progress, Typography } from "antd";
import { LoadingOutlined } from "@ant-design/icons";
import type { IntegrationRun } from "@/lib/integrations/types";
import { surfaceColors, withAlpha } from "@/lib/theme/colors";
import { INTEGRATIONS_COLOR, TRIGGER_LABELS } from "./integrations-meta";

export default function IntegrationRunStrip({
  name,
  run,
}: {
  /** The integration's name, so three strips at once are told apart. */
  name: string;
  run: IntegrationRun;
}) {
  const total = run.total;
  const known = total !== null && total > 0;
  // An unknown total still gets a moving bar: `status="active"` animates, and a
  // full track with no percentage reads as "working" rather than "finished".
  const percent = known ? Math.min(100, Math.round((run.processed / total) * 100)) : 100;
  const label = run.status === "queued" ? `${name} queued…` : `${name} running…`;

  return (
    <div
      className="flex flex-col gap-1 rounded-lg px-4 py-3"
      role="status"
      aria-live="polite"
      style={{
        backgroundColor: withAlpha(INTEGRATIONS_COLOR, 0.06),
        border: `1px solid ${withAlpha(INTEGRATIONS_COLOR, 0.25)}`,
      }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-2 text-sm" style={{ color: surfaceColors.text }}>
          <LoadingOutlined aria-hidden style={{ color: INTEGRATIONS_COLOR }} />
          {label}
        </span>
        <span className="text-xs tabular-nums" style={{ color: surfaceColors.textSecondary }}>
          {known
            ? `${run.processed.toLocaleString()} of ${total.toLocaleString()} items`
            : `${run.processed.toLocaleString()} items so far`}
          {" · "}
          {run.created} created · {run.updated} updated · {run.unchanged} unchanged · {run.failed} failed
          {" · "}
          {TRIGGER_LABELS[run.trigger]}
        </span>
      </div>

      <Progress
        percent={percent}
        status="active"
        size="small"
        showInfo={known}
        strokeColor={INTEGRATIONS_COLOR}
        aria-label={label}
      />

      <Typography.Text type="secondary" className="text-xs">
        The run belongs to the server and cannot be cancelled from here. Leaving this page only stops
        the watching; the result is waiting when you come back.
      </Typography.Text>
    </div>
  );
}
