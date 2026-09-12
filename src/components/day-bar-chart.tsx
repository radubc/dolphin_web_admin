"use client";

/**
 * One bar per day, with a hover read-out. The app's only chart.
 *
 * It began as the Cost center's daily spend bars and is now shared, because
 * the Customers page asks the same question of a different series (sign-ins
 * per day, requests per day) and two hand-drawn SVGs would drift apart within
 * a month. `src/components/cost-center/cost-bar-chart.tsx` is now a thin
 * wrapper over this that supplies the money formatting and the wording about
 * AWS estimates, so nothing about the Cost center changed.
 *
 * Hand-drawn SVG rather than a charting library, because the app has none —
 * `package.json` carries antd and nothing else that draws — and one bar per
 * day with a hover read-out is not worth a dependency, a bundle and a theme
 * adapter. Everything it paints comes from `src/lib/theme/colors.ts`, so it
 * follows the app's palette like every other surface.
 *
 * Three decisions worth knowing, all inherited and all still right:
 *
 * - **Responsive without measuring.** Bar positions and widths are SVG
 *   percentages and only the height is in pixels, so the chart fills whatever
 *   column it is given without a `ResizeObserver` and without a layout pass.
 * - **Days with no data are gaps, not zeros.** A bar whose value is `null`
 *   keeps its slot on the axis and draws a stub, so a missing day reads as
 *   missing rather than as a quiet one. The caller decides which days are
 *   `null`: the series it was given may simply not carry them.
 * - **The read-out is a native `<title>`**, not an antd `Tooltip`. It needs no
 *   JavaScript, it works on a focused element, and the alternative — one
 *   tooltip instance per day wrapping an SVG node — is a lot of machinery for
 *   a sentence.
 *
 * A `muted` bar is drawn in a lighter tint of the same colour, so the eye
 * reads it as the same series rather than as a second one. The Cost center
 * uses it for a day AWS has not finalised; the Customers page uses it for
 * today, which is still being counted.
 */

import { useId } from "react";
import { Typography } from "antd";
import { formatIsoDay, formatIsoDayShort } from "@/lib/format";
import { surfaceColors, withAlpha } from "@/lib/theme/colors";

/** One bar. `value` of `null` means there is no figure for that day. */
export interface DayBar {
  /** `YYYY-MM-DD`. Also the React key, so it must be unique in the series. */
  day: string;
  value: number | null;
  /** Drawn in a lighter tint: a provisional or incomplete day. */
  muted?: boolean;
}

export interface DayBarChartProps {
  bars: readonly DayBar[];
  /** The series colour; the page passes its feature colour. */
  color: string;
  /** Plot height in pixels, excluding the axis labels underneath. */
  height?: number;
  /** How a value reads in the peak line and in a bar's hover title. */
  formatValue: (value: number) => string;
  /** The line printed on the right of the scale, above the plot. */
  note?: string;
  /** The chart's accessible summary. Given the bar count and the peak. */
  summary: (count: number, peak: string) => string;
  /** What a muted bar adds to its hover title, e.g. "(AWS estimate)". */
  mutedSuffix?: string;
  /** What a `null` day's hover title says. */
  missingLabel?: string;
  /** The sentence shown instead of a plot when there are no bars at all. */
  emptyLabel?: string;
  /**
   * The smallest peak the scale may use. Without one a flat all-zero series
   * divides by zero and draws full-height bars; the floor keeps it flat and
   * empty, which is the truth. Costs use $0.01; a counter uses 1.
   */
  minPeak?: number;
  /** Day formatters, so a caller with its own wording keeps it. */
  formatDay?: (day: string) => string;
  formatDayShort?: (day: string) => string;
}

/** Plot height when the caller does not care. */
const DEFAULT_HEIGHT = 168;

/** Share of each day's slot the bar occupies; the rest is the gap. */
const BAR_SHARE = 0.72;

/** Gridlines, as fractions of the maximum. */
const GRIDLINES = [0.25, 0.5, 0.75, 1];

/**
 * How many x-axis labels to aim for. Printing one per day is unreadable at 35
 * days and unnecessary — the labels are there to place the shape in time, and
 * the exact day of any bar is one hover away.
 */
const AXIS_LABELS = 6;

export default function DayBarChart({
  bars,
  color,
  height = DEFAULT_HEIGHT,
  formatValue,
  note,
  summary,
  mutedSuffix,
  missingLabel = "no figure",
  emptyLabel = "No daily figures yet.",
  minPeak = 1,
  formatDay = formatIsoDay,
  formatDayShort = formatIsoDayShort,
}: DayBarChartProps) {
  const titleId = useId();
  const values = bars.map((bar) => bar.value ?? 0);
  const max = Math.max(minPeak, ...values);
  const step = bars.length === 0 ? 0 : 100 / bars.length;
  const barWidth = step * BAR_SHARE;
  const offset = (step - barWidth) / 2;

  const labelEvery = Math.max(1, Math.ceil(bars.length / AXIS_LABELS));

  if (bars.length === 0) {
    return (
      <div
        className="flex items-center justify-center"
        style={{ height: height + 24, color: surfaceColors.textTertiary }}
      >
        <Typography.Text type="secondary">{emptyLabel}</Typography.Text>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {/* The scale, above the plot rather than on a y-axis: one number is
          enough to read a bar chart whose bars all carry their own value. */}
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] tabular-nums" style={{ color: surfaceColors.textTertiary }}>
          peak {formatValue(max)}
        </span>
        {note !== undefined && (
          <span className="text-[11px]" style={{ color: surfaceColors.textTertiary }}>
            {note}
          </span>
        )}
      </div>

      <svg
        role="img"
        aria-labelledby={titleId}
        width="100%"
        height={height}
        // No `viewBox`: percentage x/width keep the bars responsive while the
        // height stays in real pixels, so nothing is ever scaled unevenly.
        style={{ display: "block", overflow: "visible" }}
      >
        <title id={titleId}>{summary(bars.length, formatValue(max))}</title>

        {GRIDLINES.map((fraction) => (
          <line
            key={fraction}
            x1="0"
            x2="100%"
            y1={height - fraction * height}
            y2={height - fraction * height}
            stroke={surfaceColors.separator}
            strokeWidth={1}
          />
        ))}

        {bars.map((bar, index) => {
          if (bar.value === null) {
            // A slot with no reading: a stub where the bar would be, so the
            // gap is visibly a gap and not a zero.
            return (
              <rect
                key={bar.day}
                x={`${index * step + offset}%`}
                width={`${barWidth}%`}
                y={height - 3}
                height={3}
                fill={surfaceColors.chip}
              >
                <title>{`${formatDay(bar.day)} — ${missingLabel}`}</title>
              </rect>
            );
          }
          const barHeight = Math.max(1, (bar.value / max) * (height - 2));
          return (
            <rect
              key={bar.day}
              x={`${index * step + offset}%`}
              width={`${barWidth}%`}
              y={height - barHeight}
              height={barHeight}
              rx={2}
              fill={bar.muted === true ? withAlpha(color, 0.45) : color}
            >
              <title>
                {`${formatDay(bar.day)} — ${formatValue(bar.value)}${
                  bar.muted === true && mutedSuffix !== undefined ? ` ${mutedSuffix}` : ""
                }`}
              </title>
            </rect>
          );
        })}

        <line
          x1="0"
          x2="100%"
          y1={height}
          y2={height}
          stroke={surfaceColors.separator}
          strokeWidth={1}
        />
      </svg>

      {/* The axis, as flex boxes rather than SVG text: the browser's own text
          layout handles the ellipsis and the font tokens for free. */}
      <div className="flex" aria-hidden>
        {bars.map((bar, index) => (
          <span
            key={bar.day}
            className="overflow-hidden text-center text-[10px] whitespace-nowrap"
            style={{ width: `${step}%`, color: surfaceColors.textTertiary }}
          >
            {index % labelEvery === 0 ? formatDayShort(bar.day) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
