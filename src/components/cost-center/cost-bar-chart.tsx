"use client";

/**
 * The daily spend bars on the Cost center page.
 *
 * The drawing moved to `src/components/day-bar-chart.tsx` when the Customers
 * page needed the same chart for sign-ins and requests per day; this file is
 * what makes it a *money* chart — the USD formatting, the wording about AWS
 * estimates, the one-cent floor on the scale, and the `D MMM YYYY` day labels
 * the Cost center has always used (`src/lib/costs/calendar.ts`, so the chart
 * and the tables on the page spell a date identically).
 *
 * Nothing about the page or its props changed: `CostBar` is still the shape
 * the page builds and `<CostBarChart bars color height />` is still the call.
 * The reasons behind the drawing — responsive without measuring, gaps rather
 * than zeros, a native `<title>` for the read-out — are documented where the
 * drawing now is.
 */

import DayBarChart from "@/components/day-bar-chart";
import { formatDay, formatDayShort, type IsoDay } from "@/lib/costs/calendar";
import { formatUsd } from "@/lib/costs/types";

/** One bar. `null` amount means AWS reported nothing for that day. */
export interface CostBar {
  day: IsoDay;
  amountUsd: number | null;
  estimated: boolean;
}

interface CostBarChartProps {
  bars: readonly CostBar[];
  /** The series colour; the page passes its feature colour. */
  color: string;
  /** Plot height in pixels, excluding the axis labels underneath. */
  height?: number;
}

export default function CostBarChart({ bars, color, height }: CostBarChartProps) {
  return (
    <DayBarChart
      bars={bars.map((bar) => ({
        day: bar.day,
        value: bar.amountUsd,
        muted: bar.estimated,
      }))}
      color={color}
      height={height}
      formatValue={formatUsd}
      // A flat zero series would otherwise divide by zero and draw
      // full-height bars; a floor of one cent keeps it flat and empty.
      minPeak={0.01}
      note="per day, UTC · lighter bars are AWS estimates"
      mutedSuffix="(AWS estimate)"
      missingLabel="no figure from AWS"
      emptyLabel="No daily figures yet."
      summary={(count, peak) => `Daily AWS spend for the last ${count} days. Peak ${peak} a day.`}
      formatDay={formatDay}
      formatDayShort={formatDayShort}
    />
  );
}
