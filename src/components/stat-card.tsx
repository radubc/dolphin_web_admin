"use client";

/**
 * The breakdown card that sits on a settings screen's right rail.
 *
 * A card of labelled rows, each with its own colour dot, its count and a bar
 * showing its share of the whole. It is the pie card the owner's layout rule
 * asks for, drawn as bars rather than a pie: these breakdowns are two to five
 * slices of a list of names, and a bar per row can carry the name, the count
 * and the share on one line where a pie needs a legend beside it.
 *
 * The card surface is the Overview's `cardSurfaceStyle`, so a rail card here
 * and a card on the dashboard are the same object.
 */

import type { ReactNode } from "react";
import { Empty, Tooltip, Typography } from "antd";
import { cardSurfaceStyle } from "@/lib/theme/colors";
import { surfaceColors } from "@/lib/theme/colors";

export interface StatRow {
  label: string;
  value: number;
  /** The dot and the bar's colour. */
  color: string;
  /** Optional explanation, shown on hover and on focus. */
  tooltip?: string;
}

interface StatCardProps {
  title: string;
  icon?: ReactNode;
  /** The denominator for the bars. Defaults to the sum of the rows. */
  total?: number;
  rows: readonly StatRow[];
  /** Small print under the rows. */
  footnote?: ReactNode;
  /** Lays the rows out in a grid instead of a column, for the stacked layout. */
  horizontal?: boolean;
}

export default function StatCard({
  title,
  icon,
  total,
  rows,
  footnote,
  horizontal = false,
}: StatCardProps) {
  const denominator = total ?? rows.reduce((sum, row) => sum + row.value, 0);

  return (
    <section className="p-4" style={cardSurfaceStyle} aria-label={title}>
      <div className="mb-3 flex items-center gap-2">
        {icon !== undefined && <span aria-hidden>{icon}</span>}
        <Typography.Text
          strong
          className="text-[11px] tracking-wide uppercase"
          style={{ color: surfaceColors.textSecondary }}
        >
          {title}
        </Typography.Text>
      </div>

      {rows.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span style={{ color: surfaceColors.textTertiary }}>Nothing to break down yet</span>
          }
        />
      ) : (
        <div
          className={
            horizontal ? "grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4" : "flex flex-col gap-3"
          }
        >
          {rows.map((row) => {
            // A zero denominator means an empty list, not a full bar.
            const share = denominator > 0 ? Math.min(1, row.value / denominator) : 0;
            const bar = (
              <div className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm">
                    <span
                      aria-hidden
                      className="inline-block rounded-full"
                      style={{ width: 8, height: 8, backgroundColor: row.color }}
                    />
                    <span style={{ color: surfaceColors.text }}>{row.label}</span>
                  </span>
                  <span
                    className="text-sm font-semibold tabular-nums"
                    style={{ color: surfaceColors.text }}
                  >
                    {row.value}
                  </span>
                </div>
                <span
                  aria-hidden
                  className="block overflow-hidden rounded-full"
                  style={{ height: 4, backgroundColor: surfaceColors.chip }}
                >
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${share * 100}%`, backgroundColor: row.color }}
                  />
                </span>
              </div>
            );

            return (
              <div key={row.label}>
                {row.tooltip === undefined ? (
                  bar
                ) : (
                  <Tooltip title={row.tooltip}>
                    <div tabIndex={0}>{bar}</div>
                  </Tooltip>
                )}
              </div>
            );
          })}
        </div>
      )}

      {footnote !== undefined && (
        <p className="mt-3 mb-0 text-xs" style={{ color: surfaceColors.textTertiary }}>
          {footnote}
        </p>
      )}
    </section>
  );
}
