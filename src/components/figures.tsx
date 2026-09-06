"use client";

/**
 * The book-level read-outs that sit in a settings screen's header band, to the
 * right of the title.
 *
 * Read-outs rather than cards, per the owner's layout rule: totals belong in
 * the header and the cards down the right rail are for breakdowns. Every figure
 * covers whatever the filters have left on screen, which the tooltips say out
 * loud so a narrowed total is never mistaken for the whole book.
 *
 * Shared by all four reference screens (Categories, Payees, Tags, Rules)
 * because they all say the same kind of thing — how many of a list there are,
 * and how they split — and four near-identical header components would drift.
 */

import { Tooltip } from "antd";
import { surfaceColors } from "@/lib/theme/colors";

export interface Figure {
  label: string;
  value: string;
  /** Defaults to the primary text colour. */
  color?: string;
  tooltip: string;
  /** Draws a hairline before this figure, to group the ones after it. */
  separatorBefore?: boolean;
}

function Separator() {
  return (
    <span
      aria-hidden
      className="self-stretch"
      style={{ width: 1, backgroundColor: surfaceColors.separator }}
    />
  );
}

export default function Figures({
  figures,
  label,
}: {
  figures: readonly Figure[];
  /** The group's accessible name, e.g. "Category totals". */
  label: string;
}) {
  return (
    <div className="flex items-center gap-5" role="group" aria-label={label}>
      {figures.map((figure) => (
        <span key={figure.label} className="flex items-center gap-5">
          {figure.separatorBefore === true && <Separator />}
          <Tooltip title={figure.tooltip}>
            {/* A tab stop, so the tooltip explaining a figure is reachable
                without a pointer: antd opens it on focus as well as on hover. */}
            <span tabIndex={0} className="flex flex-col items-end gap-0.5">
              <span
                className="text-[11px] font-medium tracking-wide uppercase"
                style={{ color: surfaceColors.textSecondary }}
              >
                {figure.label}
              </span>
              <span
                className="text-lg leading-tight font-semibold tabular-nums"
                style={{ color: figure.color ?? surfaceColors.text }}
              >
                {figure.value}
              </span>
            </span>
          </Tooltip>
        </span>
      ))}
    </div>
  );
}
