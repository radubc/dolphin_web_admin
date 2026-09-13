"use client";

/**
 * The frame every settings screen wears, so the ten of them read as one part of
 * the app rather than ten separate windows.
 *
 * Top to bottom: a sticky band — the page header with the screen's title, its
 * accent rule and a read-out of book-level figures on the right, glued to the
 * full-width ribbon carrying every action the screen offers — and then a body:
 * the list taking the width, with an optional rail of breakdown cards down the
 * right.
 *
 * That is the owner's layout rule, the same one Banking, Subscriptions, Budgets
 * and the rest already follow: actions live on one strip across the top,
 * Excel-style, never scattered through the content; book-level totals live in
 * the header; breakdowns live on cards to the right of the list.
 *
 * The frame is a column exactly as tall as the shell's content area: the band
 * is fixed at the top of it and the body below is the only thing that can
 * scroll. A screen that puts its table in a `ListTableRegion` hands that region
 * every pixel the fixed parts leave over, and the table scrolls its rows inside
 * it: the ribbon, the alerts, the toolbar, the table header and the pager all
 * stay on screen and nothing else moves. That is the owner's rule for every
 * list. A screen whose content is not a table — a stack of cards — simply
 * scrolls in the body, under the same fixed band.
 *
 * Below 1100px the rail would squeeze the list to an unreadable width, so its
 * cards move above the content instead.
 *
 * On the *compact* layout — a phone or an upright tablet, `useCompactLayout`,
 * below 1024px — two of those rules are relaxed, because a 700px-tall phone has
 * no pixels to spend on chrome that never moves: the band scrolls with the page
 * instead of sticking to the top of it, and `ListTableRegion` stops pinning the
 * table, so the whole body is the one scroller. Everything at 1024px and above
 * is the owner's desktop layout and is left exactly as it was.
 */

import type { ReactNode } from "react";
import PageHeader from "@/components/page-header";
import { useCompactLayout } from "@/lib/hooks/use-compact-layout";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import {
  TableBodyHeightContext,
  useTableBodyHeight,
} from "@/lib/hooks/use-table-body-height";
import { surfaceColors } from "@/lib/theme/colors";

/** Where the right rail stops paying for itself. */
const RAIL_QUERY = "(min-width: 1100px)";

/** The rail's width, and the floor it may not be squeezed below. */
const RAIL_WIDTH = 300;
const RAIL_MIN_WIDTH = 260;

/**
 * The column the screen's own content lives in: the fixed parts stacked from the
 * top and, on a list page, the table region taking what is left.
 *
 * `[&>*]:shrink-0` keeps the fixed parts at their natural height. A flex item
 * whose basis is 0 — the table region — has nothing to give back when the
 * window is too short, so without this the toolbar and the alerts above it
 * would be the things squeezed. With it, a window too short for the fixed parts
 * alone simply scrolls in the frame's body, as it did before — the frame's
 * root never overflows the shell's `<main>`, since the body below the sticky
 * band is `flex-1` with a basis of 0 and is always the one that gives.
 */
const LIST_COLUMN = "flex min-h-0 min-w-0 flex-1 flex-col gap-4 [&>*]:shrink-0";

interface ListPageFrameProps {
  title: string;
  /** The line under the accent rule: what is on screen, in words. */
  caption?: ReactNode;
  /** Book-level read-outs pinned to the right of the header band. */
  figures?: ReactNode;
  /** The `RibbonBar` for this screen. */
  ribbon: ReactNode;
  /** Breakdown cards for the right rail. Omitted screens simply have none. */
  rail?: ReactNode;
  children: ReactNode;
}

export function ListPageFrame({
  title,
  caption,
  figures,
  ribbon,
  rail,
  children,
}: ListPageFrameProps) {
  // `true` as the server value: a desktop browser — this app's primary target —
  // resolves to the wide layout on the very next paint, so rendering the narrow
  // one first would show a visible reflow.
  const wide = useMediaQuery(RAIL_QUERY, true);

  return (
    <div
      // `h-full` pins the frame to the shell's content area: the band stays
      // put and the body below it (`min-h-0 flex-1 overflow-y-auto`) is the
      // scroller. It must not be `min-h-full`: that let the frame grow to its
      // content, the shell's <main> scrolled the whole page, and the table
      // body measured its full content height, so nothing was pinned (owner
      // saw the column labels scroll away on Constants, 2026-09-12).
      className="flex h-full min-h-0 flex-col"
      style={{ backgroundColor: surfaceColors.page }}
    >
      {/* Header and ribbon glued into one sticky block, so they move as a unit
          instead of needing matched offsets against each other.

          Sticky from `lg` up only: on a phone the band is a third of the
          window, and a title that cannot be scrolled away is a third of the
          window the list never gets back. Below `lg` it is a plain static
          block that scrolls off with the body, which is also why `z-10` stops
          mattering there — a static box creates no stacking context. */}
      <div className="z-10 shrink-0 lg:sticky lg:top-0">
        <PageHeader title={title} caption={caption} actions={figures} />
        {ribbon}
      </div>

      {/* The body takes the rest of the frame's height — `min-h-0 flex-1`, so a
          `ListTableRegion` inside it can be given a definite one — and is the
          scroller for anything that does not fit: a stack of cards, a toolbar
          on a very short window. A rail taller than the window scrolls inside
          its own `aside` below instead, which is its own scroll container. The
          band above therefore never moves, whatever the screen puts here. */}
      {/* `p-3` up to `lg`, the desktop's `p-5` from there: 16 of a phone's
          ~390 horizontal pixels are worth more to a table than to a margin. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3 lg:p-5">
        {rail !== undefined && wide ? (
          <div className="flex min-h-0 flex-1 gap-4">
            <div className={LIST_COLUMN}>{children}</div>
            {/* Full height by default (stretch) with its own scrollbar, so a
                tall stack of breakdown cards cannot push the list off the
                bottom of a short window. `tabIndex` gives it keyboard reach
                as its own scroll container, the same reason `.ant-table-body`
                gets one in `useTableBodyHeight`. */}
            <aside
              tabIndex={0}
              className="shrink-0 overflow-y-auto"
              style={{ width: RAIL_WIDTH, minWidth: RAIL_MIN_WIDTH }}
              aria-label={`${title} breakdowns`}
            >
              {rail}
            </aside>
          </div>
        ) : (
          <>
            {/* Stacked above the list. Every rail in the app is already a
                single column of cards, and `max-lg:min-w-0` keeps it that way
                on a phone: a card that would rather be wider than the window
                shrinks instead of pushing the page sideways. */}
            {rail !== undefined && (
              <section
                className="shrink-0 max-lg:min-w-0"
                aria-label={`${title} breakdowns`}
              >
                {rail}
              </section>
            )}
            <div className={LIST_COLUMN}>{children}</div>
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The white tile a settings list sits on: the same surface every card in the
 * app uses, with the table drawn edge to edge inside it.
 */
export function ListPanel({ children }: { children: ReactNode }) {
  return (
    <div
      className="overflow-hidden rounded-lg"
      style={{
        backgroundColor: surfaceColors.card,
        border: `1px solid ${surfaceColors.separator}`,
      }}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Table region                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The part of a list page the rows scroll inside.
 *
 * Wrap the panel holding the antd `<Table>` in one of these and give the table
 * `scroll={{ x, y }}` with the height it reports: antd then draws a fixed
 * header, a body that scrolls to `y`, and the pager underneath, all inside the
 * space the ribbon, alerts and toolbar left over. Everything else about the
 * table — `scroll.x`, pagination, row selection, expandable rows, `loading` —
 * is untouched.
 *
 * Two ways to read the height, because a list's table is sometimes written
 * inline and sometimes a component of its own:
 *
 * ```tsx
 * <ListTableRegion>
 *   {(y) => (
 *     <ListPanel>
 *       <Table scroll={{ x: 1220, y }} … />
 *     </ListPanel>
 *   )}
 * </ListTableRegion>
 * ```
 *
 * ```tsx
 * <ListTableRegion>
 *   <ListPanel>
 *     <UsersTable … />   // calls useListTableBodyHeight() itself
 *   </ListPanel>
 * </ListTableRegion>
 * ```
 *
 * The region only clips once it has measured. Until then — and on a window too
 * short for a usable scroller — the table renders in full and scrolls in the
 * frame's body, which is the behaviour every one of these pages had before.
 *
 * `panelBorder` reserves the 2px a `ListPanel` draws around the table; it
 * defaults on because that is how every list page uses this. Turn it off for
 * a region that wraps a bare `<Table>` with no panel of its own — the runs
 * drawer, say — so the height it measures does not overshoot by those 2px.
 *
 * **On the compact layout the region pins nothing.** A phone has no room for a
 * scroller inside a scroller: the height it would hand out is a handful of
 * rows, and the two scroll gestures fight each other. So below `lg` the region
 * measures nothing, hands `undefined` to its function child and publishes
 * `undefined` on the context — which is exactly the "not measured yet" case
 * every table here already handles by rendering in full — and never clips
 * itself, so the frame's body scrolls the page as one. `ResponsiveTable`
 * (`src/components/responsive-table.tsx`) draws its cards in the same space.
 */
export function ListTableRegion({
  children,
  panelBorder = true,
}: {
  children: ReactNode | ((height: number | undefined) => ReactNode);
  /** Whether the region has a `ListPanel`'s border to account for. */
  panelBorder?: boolean;
}) {
  // Structural rather than cosmetic — the number handed to `scroll.y` decides
  // whether antd splits the table into a fixed header and a scrolling body at
  // all — so this is the hook and not a Tailwind variant.
  const compact = useCompactLayout();
  const { ref, height } = useTableBodyHeight({ panelBorder });
  const pinned = compact ? undefined : height;

  return (
    <div
      // The ref is only attached on the desktop layout: with no element to
      // watch, the hook's observers never attach and it never re-renders.
      ref={compact ? undefined : ref}
      // Same computed box as before from `lg` up. Below it the region is an
      // ordinary block in the body's column — content height, no clipping —
      // so the cards or the full table simply scroll with the page.
      className={`flex min-w-0 flex-col lg:min-h-0 lg:flex-1 ${pinned === undefined ? "" : "lg:overflow-hidden"}`}
    >
      <TableBodyHeightContext value={pinned}>
        {typeof children === "function" ? children(pinned) : children}
      </TableBodyHeightContext>
    </div>
  );
}
