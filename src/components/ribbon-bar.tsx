"use client";

/**
 * The app's ribbon: one bar across the top of a working surface carrying every
 * action that surface offers, the way Excel does and the way the native mac app
 * does on every list page.
 *
 * Extracted from the Banking page's transactions toolbar so the Assets page —
 * and the pages after it — wear exactly the same chrome: the same band colour,
 * the same hairline underneath, the same stacked icon-over-label buttons, the
 * same hairline between groups, and the same trailing read-out slot on the
 * right that is always saying something about what is on screen.
 *
 * Two rules the bar exists to enforce:
 *
 *   - Actions are *always visible* and only change their enabled state. The bar
 *     must never reflow while a user is changing a selection.
 *   - The trailing slot is pushed right by a flexible spacer, so the read-out
 *     sits at the far edge no matter how many buttons precede it.
 *
 * The first rule is what shapes the *compact* layout (a phone or an upright
 * tablet, below `lg`): the actions may not wrap, drop into an overflow menu or
 * change order, so the row of them becomes a strip that scrolls sideways with
 * a finger, and the trailing read-out moves to its own line underneath where
 * there is width for it. Nothing is hidden and nothing moves.
 *
 * Desktop is untouched, and by construction: the two wrappers the compact
 * layout needs are `display: contents` from `lg` up, so at desktop widths the
 * buttons, the spacer and the read-out are direct flex children of the band
 * exactly as they were before the strip existed.
 */

import { Button, Tooltip } from "antd";
import type { ReactNode } from "react";
import { featureColors, surfaceColors } from "@/lib/theme/colors";

/* -------------------------------------------------------------------------- */
/* RibbonButton                                                               */
/* -------------------------------------------------------------------------- */

export interface RibbonButtonProps {
  label: string;
  icon: ReactNode;
  /**
   * Optional so the button can sit inside a `Popconfirm`, which owns the click
   * itself and only wants the button as its anchor.
   */
  onClick?: () => void;
  disabled?: boolean;
  /**
   * Destructive. Red is reserved for exactly this and for errors, and it is
   * dropped while the button is disabled so a greyed-out control never shouts.
   */
  danger?: boolean;
  tooltip?: string;
}

/** Icon over label, borderless, sized to the band. */
export function RibbonButton({
  label,
  icon,
  onClick,
  disabled = false,
  danger = false,
  tooltip,
}: RibbonButtonProps) {
  const button = (
    <Button
      type="text"
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-center justify-center gap-1"
      // antd's button styles carry a hashed class, so they outrank Tailwind's
      // single-class utilities: `h-auto` and `py-2.5` never applied, the box
      // stayed 32px tall with the icon and label overflowing it, and the hover
      // highlight painted only that 32px band. Inline styles are what beat it.
      style={{
        height: "auto",
        padding: "4px 10px",
        color: danger && !disabled ? featureColors.rule : undefined,
      }}
    >
      <span aria-hidden className="text-lg leading-none">
        {icon}
      </span>
      {/* Two-line labels ("Add Transaction") get a fixed two-line box so every
          button in the bar is the same height and single-line labels align. */}
      <span className="flex h-[26px] w-[72px] items-center justify-center text-center text-[11px] leading-[13px] whitespace-normal">
        {label}
      </span>
    </Button>
  );

  return tooltip ? <Tooltip title={tooltip}>{button}</Tooltip> : button;
}

/* -------------------------------------------------------------------------- */
/* RibbonDivider                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The hairline between two groups of actions.
 *
 * A measured `<span>` rather than antd's `Divider`: the rule has to be exactly
 * as tall as a ribbon button (56px) and sit on the band's own separator colour,
 * which `Divider type="vertical"` — sized in `em` off the surrounding text —
 * cannot be made to do without overriding every one of its tokens.
 */
export function RibbonDivider() {
  return (
    <span
      aria-hidden
      className="mx-2 self-center"
      style={{ width: 1, height: 56, backgroundColor: surfaceColors.separator }}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* RibbonBar                                                                  */
/* -------------------------------------------------------------------------- */

export interface RibbonBarProps {
  /** The action buttons, with `RibbonDivider` between groups. */
  children: ReactNode;
  /** The read-out pinned to the right edge. */
  trailing?: ReactNode;
}

export function RibbonBar({ children, trailing }: RibbonBarProps) {
  return (
    <div
      // A column below `lg` — the strip, then the read-out — and the same
      // single centred row it has always been from `lg` up.
      className="flex flex-col px-3 py-1 lg:flex-row lg:items-center lg:gap-1"
      style={{
        backgroundColor: surfaceColors.cardHeader,
        borderBottom: `1px solid ${surfaceColors.separator}`,
      }}
    >
      {/* The scrolling strip. `lg:contents` dissolves it at desktop widths, so
          the buttons remain direct children of the band and neither the
          overflow nor the gap declared here ever applies there.

          On compact: no wrapping (a flex row does not wrap by default),
          `[&>*]:shrink-0` so a button keeps its width instead of being
          squeezed out of shape — scoped to `max-lg` because a desktop ribbon
          is allowed to shrink its buttons as it always has — and the
          scrollbar is hidden in both engines, since a bar that is 56px tall
          cannot afford a 15px gutter and a finger needs no bar to drag. */}
      <div className="flex items-center gap-1 overflow-x-auto max-lg:[&>*]:shrink-0 lg:contents [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        {children}

        {/* The flexible spacer that pushes the read-out to the far edge.
            Desktop only: on compact the read-out is on its own line and a
            spacer would only add scrollable width to the strip. */}
        <div className="hidden min-w-3 flex-1 lg:block" />
      </div>

      {trailing !== undefined && trailing !== null && (
        // Its own line on compact, right-aligned under the strip; dissolved
        // into the band's row from `lg` up, where it is the element the
        // spacer above pushes right.
        <div className="lg:contents max-lg:pt-0.5 max-lg:text-right">{trailing}</div>
      )}
    </div>
  );
}
