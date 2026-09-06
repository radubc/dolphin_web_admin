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
 * The band is `sticky top-0` inside the shell's scrolling content area,
 * so it stays put while a long list scrolls under it. Below 1100px the rail
 * would squeeze the list to an unreadable width, so its cards move above the
 * content instead.
 */

import type { ReactNode } from "react";
import PageHeader from "@/components/page-header";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { surfaceColors } from "@/lib/theme/colors";

/** Where the right rail stops paying for itself. */
const RAIL_QUERY = "(min-width: 1100px)";

/** The rail's width, and the floor it may not be squeezed below. */
const RAIL_WIDTH = 300;
const RAIL_MIN_WIDTH = 260;

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
      className="flex min-h-full flex-col"
      style={{ backgroundColor: surfaceColors.page }}
    >
      {/* Header and ribbon glued into one sticky block, so they move as a unit
          instead of needing matched offsets against each other. */}
      <div className="sticky top-0 z-10">
        <PageHeader title={title} caption={caption} actions={figures} />
        {ribbon}
      </div>

      <div className="flex flex-col gap-4 p-5">
        {rail !== undefined && wide ? (
          <div className="flex items-start gap-4">
            <div className="flex min-w-0 flex-1 flex-col gap-4">{children}</div>
            <aside
              className="shrink-0 self-start"
              style={{ width: RAIL_WIDTH, minWidth: RAIL_MIN_WIDTH }}
              aria-label={`${title} breakdowns`}
            >
              {rail}
            </aside>
          </div>
        ) : (
          <>
            {rail !== undefined && (
              <section aria-label={`${title} breakdowns`}>{rail}</section>
            )}
            <div className="flex min-w-0 flex-col gap-4">{children}</div>
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
