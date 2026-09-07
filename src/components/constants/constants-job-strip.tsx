"use client";

/**
 * The strip under the ribbon while a compare or a push runs on the server.
 *
 * A job over 300,000 rows takes minutes, so the page says what is running, how
 * far it has got and — the part an operator most needs to read — that the work
 * belongs to the server: there is no cancel, and closing the page only stops
 * the watching. The bar goes indeterminate until the job knows its own total.
 */

import { Progress, Typography } from "antd";
import { LoadingOutlined } from "@ant-design/icons";
import type { ConstantJob } from "@/lib/constants/types";
import { surfaceColors, withAlpha } from "@/lib/theme/colors";
import { CONSTANTS_COLOR } from "./constants-meta";
import { jobRunningLabel } from "./use-job-polling";

export default function ConstantsJobStrip({ job }: { job: ConstantJob }) {
  const total = job.total;
  const known = total !== null && total > 0;
  // An unknown total still gets a moving bar: `status="active"` animates, and a
  // full track with no percentage reads as "working" rather than "finished".
  const percent = known ? Math.min(100, Math.round((job.processed / total) * 100)) : 100;

  return (
    <div
      className="flex flex-col gap-1 rounded-lg px-4 py-3"
      role="status"
      aria-live="polite"
      style={{
        backgroundColor: withAlpha(CONSTANTS_COLOR, 0.06),
        border: `1px solid ${withAlpha(CONSTANTS_COLOR, 0.25)}`,
      }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-2 text-sm" style={{ color: surfaceColors.text }}>
          <LoadingOutlined aria-hidden style={{ color: CONSTANTS_COLOR }} />
          {jobRunningLabel(job)}
        </span>
        <span className="text-xs tabular-nums" style={{ color: surfaceColors.textSecondary }}>
          {known
            ? `${job.processed.toLocaleString()} of ${total.toLocaleString()} rows`
            : `${job.processed.toLocaleString()} rows so far`}
        </span>
      </div>

      <Progress
        percent={percent}
        status="active"
        size="small"
        showInfo={known}
        strokeColor={CONSTANTS_COLOR}
        aria-label={jobRunningLabel(job)}
      />

      <Typography.Text type="secondary" className="text-xs">
        The job runs on the server and cannot be cancelled from here. Leaving this page only stops
        the watching; the result is waiting when you come back.
      </Typography.Text>
    </div>
  );
}
