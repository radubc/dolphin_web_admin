/**
 * A 24-point sparkline, hand-drawn as one inline SVG path.
 *
 * No charting library, by the same reasoning as `src/components/day-bar-chart.tsx`
 * — the app's only other chart: this draws a polyline and a baseline, which is
 * forty lines of arithmetic, and a dependency that ships a rendering engine to
 * do it would be larger than the page. It is also a Server Component, so the
 * Overview stays free of client JavaScript.
 *
 * How gaps are handled, which is the whole difficulty of a metric sparkline:
 * a slot CloudWatch published nothing for is `null`, not zero — "nothing
 * happened" and "nothing was measured" are different facts — so the line is
 * drawn as **one path per run of consecutive measured slots**. A metric with
 * one datum an hour draws a continuous line; a metric that reported twice
 * today draws two dots with a gap between them, which is the truth.
 *
 * The vertical scale is the series' own minimum to maximum, with a flat series
 * pinned to the middle. Absolute height is meaningless at this size — the
 * value beside the line carries that — and a shared scale across metrics in
 * different units would be nonsense.
 */

import { withAlpha } from "@/lib/theme/colors";

interface SparklineProps {
  /** One slot per period, oldest first; `null` where nothing was published. */
  points: readonly (number | null)[];
  color: string;
  width?: number;
  height?: number;
  /** Accessible description, e.g. "CPU over the last 24 hours". */
  label: string;
}

/** Inset so the stroke and the end dot are not clipped by the viewBox. */
const PAD = 2;

export default function Sparkline({
  points,
  color,
  width = 96,
  height = 24,
  label,
}: SparklineProps) {
  const measured = points.filter((point): point is number => point !== null);

  if (measured.length === 0) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${label}: no data`}
      >
        <line
          x1={PAD}
          y1={height / 2}
          x2={width - PAD}
          y2={height / 2}
          stroke={withAlpha(color, 0.25)}
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      </svg>
    );
  }

  const min = Math.min(...measured);
  const max = Math.max(...measured);
  const span = max - min;
  const innerWidth = width - PAD * 2;
  const innerHeight = height - PAD * 2;
  // One slot per step; a single-slot series sits in the middle horizontally.
  const step = points.length > 1 ? innerWidth / (points.length - 1) : 0;

  const xOf = (index: number): number =>
    points.length > 1 ? PAD + index * step : PAD + innerWidth / 2;
  // A flat series would divide by zero; it is drawn as a line across the
  // middle, which is what "unchanged" looks like.
  const yOf = (value: number): number =>
    span === 0 ? PAD + innerHeight / 2 : PAD + innerHeight * (1 - (value - min) / span);

  /* Runs of consecutive measured slots, so a gap is a gap. */
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  points.forEach((point, index) => {
    if (point === null) {
      if (run.length > 0) runs.push(run);
      run = [];
      return;
    }
    run.push({ x: xOf(index), y: yOf(point) });
  });
  if (run.length > 0) runs.push(run);

  const last = runs[runs.length - 1]?.at(-1) ?? null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      {runs.map((segment, index) =>
        segment.length === 1 ? (
          <circle
            key={index}
            cx={segment[0].x}
            cy={segment[0].y}
            r={1.4}
            fill={withAlpha(color, 0.8)}
          />
        ) : (
          <polyline
            key={index}
            points={segment.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ),
      )}
      {last !== null && <circle cx={last.x} cy={last.y} r={2} fill={color} />}
    </svg>
  );
}
