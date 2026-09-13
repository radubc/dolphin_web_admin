"use client";

/**
 * Whether the shell is in its *compact* layout: a phone, or a tablet held
 * upright. One breakpoint for the whole app, so the shell, the list frame,
 * the ribbon and the tables all fold on the same pixel.
 *
 * The boundary is Tailwind's `lg` (1024px). Below it the side rail becomes a
 * bottom tab bar, the nav bar collapses, the ribbon scrolls sideways, list
 * pages scroll as a whole instead of pinning their table, and a table is
 * drawn as a list of cards. At `lg` and above **nothing changes**: the
 * desktop layout is the owner's and is left byte for byte as it was.
 *
 * Two ways to use it, and which one matters:
 *
 * - **CSS first.** Anything that is only *shown or hidden* per layout uses
 *   the matching Tailwind variants — `max-lg:hidden` for desktop-only chrome,
 *   `lg:hidden` for compact-only — so the server renders both and the browser
 *   picks without a reflow. `COMPACT_QUERY` and Tailwind's `lg` must agree,
 *   which is why the query is written in `rem` and not in pixels: Tailwind's
 *   `lg` is `64rem`, and `rem` in a media query is the browser's *initial*
 *   font size. For an operator who has set that to anything but 16px, a
 *   pixel query and the `lg` variant fold on different window widths — the
 *   band would go static while the table was still pinned, or the other way
 *   round.
 * - **This hook** for anything whose *structure* differs (a table drawn as
 *   cards, a drawer placed at the bottom). The server snapshot is `false`:
 *   the desktop layout is this app's primary target and resolves on the next
 *   paint; a phone sees one desktop-shaped frame before the cards arrive.
 */

import { useMediaQuery } from "./use-media-query";

/**
 * Exactly Tailwind's `max-lg` variant, `@media (width < 64rem)`: the same unit
 * and the same range syntax, so the two can never disagree at any zoom level.
 */
export const COMPACT_QUERY = "(width < 64rem)";

export function useCompactLayout(): boolean {
  return useMediaQuery(COMPACT_QUERY, false);
}
