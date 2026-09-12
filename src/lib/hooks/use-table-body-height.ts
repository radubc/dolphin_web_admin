"use client";

/**
 * How tall an antd table's *body* may be so that the rows are the only thing
 * that scrolls on a list page.
 *
 * The owner's rule for every list: the ribbon, the alerts, the toolbar, the
 * table header and the pager stay on screen, and the rows scroll under them.
 * antd does that itself once `scroll.y` is a number — it then splits the table
 * into a fixed `.ant-table-header` and a scrolling `.ant-table-body` capped at
 * `y`, with the pager below both — so the only thing missing is the number,
 * which depends on the window. This hook measures it.
 *
 * The measurement is a subtraction: the height of the region the table has been
 * given, minus everything inside that region which is *not* rows — the table
 * header, the pager and anything marked `data-list-reserve` (a "load older"
 * strip, say) — minus a couple of pixels for the panel's border, when the
 * region has one. Heights are read from the DOM rather than estimated, because
 * a pager's height changes with the page-size picker and a header's with a
 * wrapped column title, and a stale estimate shows up as either a clipped
 * pager or a gap under the rows.
 *
 * `height` is `undefined` until the first measurement, and stays `undefined`
 * when the region is too short to be worth constraining (a very short window,
 * or a rail that has pushed the list off the bottom on a narrow one). An
 * unconstrained table renders in full, so the caller must not clip the region
 * while the height is unknown — `ListTableRegion` only adds `overflow-hidden`
 * once it has a number.
 *
 * Two ways to get the number to the `<Table>`: the region hands it to a
 * function child, and it is also published on `TableBodyHeightContext` so a
 * table in its own component (`UsersTable`, `ConstantsTable`) can read it with
 * `useListTableBodyHeight()` instead of having a prop threaded down to it.
 *
 * The same pass also makes `.ant-table-body` reachable from the keyboard: with
 * `scroll.y` set, antd puts the rows in that element and gives it no tabindex
 * of its own, which leaves a table with no focusable cell content — the audit
 * log, say — impossible to scroll without a mouse.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

/**
 * Inside the region, these are reserved rather than scrolled. The two antd
 * class names are the fixed header and the pager; `data-list-reserve` is the
 * escape hatch for anything a list adds of its own, such as the audit log's
 * "Load older events" strip under the table.
 */
const RESERVED_SELECTORS = [".ant-table-thead", ".ant-table-pagination"] as const;
const RESERVED_ATTRIBUTE = "[data-list-reserve]";

/**
 * The panel's top and bottom border. Part of the region's height but not of the
 * table, and too small to measure reliably.
 */
const PANEL_BORDERS = 2;

/**
 * Below this many pixels of room for rows the table is left unconstrained: a
 * three-row scroller inside a scrolling page is worse than a page that simply
 * scrolls, which is what an unconstrained table falls back to.
 */
const MIN_BODY_HEIGHT = 120;

export interface TableBodyHeightOptions {
  /**
   * Reserve {@link PANEL_BORDERS} for the panel's top and bottom border. On by
   * default, since most regions wrap a `ListPanel`; turn off for a region that
   * wraps a bare table with no panel of its own (a drawer, say), which has no
   * such border to account for.
   */
  panelBorder?: boolean;
  /** Room for rows below which the table is left unconstrained. */
  minBodyHeight?: number;
}

export interface TableBodyHeight {
  /** Attach to the element whose height the table body must fit inside. */
  ref: (node: HTMLElement | null) => void;
  /** Pixels available for rows, or `undefined` while that is not known. */
  height: number | undefined;
}

/** The reserved height of one element: its box plus its vertical margins. */
function outerHeight(element: Element): number {
  const { height } = element.getBoundingClientRect();
  if (height === 0) return 0;
  const style = window.getComputedStyle(element);
  const top = Number.parseFloat(style.marginTop) || 0;
  const bottom = Number.parseFloat(style.marginBottom) || 0;
  return height + Math.max(0, top) + Math.max(0, bottom);
}

function measure(
  container: HTMLElement,
  panelBorder: boolean,
  minBodyHeight: number,
): number | undefined {
  const available = container.clientHeight;
  // Zero while the element is detached or display:none — and, importantly, if
  // the height chain above it is not definite. Either way, do not constrain.
  if (available <= 0) return undefined;
  // A container taller than the viewport means the height chain is content-
  // sized, not pinned (a `min-h-full` ancestor, say): pinning `scroll.y` to
  // that number would constrain nothing and hide the bug. Fall back instead.
  if (typeof window !== "undefined" && available > window.innerHeight) return undefined;

  let reserved = panelBorder ? PANEL_BORDERS : 0;
  for (const selector of RESERVED_SELECTORS) {
    // The first match only: a table nested in an expanded row has a `thead` of
    // its own, and that one scrolls with the rows.
    const element = container.querySelector(selector);
    if (element !== null) reserved += outerHeight(element);
  }
  for (const element of container.querySelectorAll(RESERVED_ATTRIBUTE)) {
    reserved += outerHeight(element);
  }

  const forRows = Math.floor(available - reserved);
  return forRows < minBodyHeight ? undefined : forRows;
}

/**
 * A label for `.ant-table-body`'s `aria-label`, best one available: a
 * `<caption>` inside the region beats an explicit `aria-label` on the
 * `<table>` element, and a generic fallback beats neither existing.
 */
function tableBodyLabel(container: HTMLElement): string {
  const caption = container.querySelector("caption")?.textContent?.trim();
  if (caption) return caption;
  const labelled = container.querySelector("table[aria-label]");
  const label = labelled?.getAttribute("aria-label")?.trim();
  return label && label.length > 0 ? label : "Table rows";
}

/**
 * Gives `.ant-table-body` keyboard reach: a `tabindex` so it can be focused
 * and scrolled with the arrow keys, and a role and label so a screen reader
 * announces what the region is. A no-op once the attribute is there, so this
 * never fights whatever a caller may have set by hand.
 */
function labelTableBody(container: HTMLElement): void {
  const body = container.querySelector<HTMLElement>(".ant-table-body");
  if (body === null || body.hasAttribute("tabindex")) return;
  body.tabIndex = 0;
  body.setAttribute("role", "region");
  body.setAttribute("aria-label", tableBodyLabel(container));
}

/** Ignore differences this small: sub-pixel layout must not cause a re-render. */
const TOLERANCE = 2;

export function useTableBodyHeight({
  panelBorder = true,
  minBodyHeight = MIN_BODY_HEIGHT,
}: TableBodyHeightOptions = {}): TableBodyHeight {
  // The element in state, not a ref, so the effect below re-runs when it
  // arrives — a ref would leave the observer attached to nothing.
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);

  const apply = useCallback(() => {
    if (container === null) return;
    const next = measure(container, panelBorder, minBodyHeight);
    setHeight((current) =>
      current !== undefined && next !== undefined && Math.abs(current - next) < TOLERANCE
        ? current
        : next,
    );
    labelTableBody(container);
  }, [container, panelBorder, minBodyHeight]);

  // Two things to watch, both of them the browser's business rather than
  // React's, which is why the measuring happens in their callbacks and never in
  // the effect body:
  //
  // *Size*, for a window resize, the side rail folding, the browser's chrome
  // growing a bar. A width change counts too: it is what makes a column title
  // wrap and the header a line taller. The observer also delivers once as soon
  // as it is attached, which is the first measurement. The header and the
  // pager are watched the same way, once found, so a change to *their* size
  // alone — a pager's total wrapping to a second line — is caught even though
  // the region itself has not resized.
  //
  // *Structure*, for the parts that come and go without the region ever
  // changing size — a pager that appears once there is a second page, the audit
  // log's "load older" strip when there is nothing older left, and antd's own
  // switch from one table to a fixed header plus a scrolling body the moment
  // `scroll.y` is set. `characterData` too, so text growing in place — the
  // pager's total gaining a digit — is not missed just because no node was
  // added or removed.
  //
  // Every callback schedules through one pending `requestAnimationFrame`
  // rather than measuring synchronously: several observers can fire for the
  // same render, and this collapses them into one measurement per frame.
  useEffect(() => {
    if (container === null) return;

    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        apply();
      });
    };

    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(container);

    // Re-run the lookup and (re-)observe whatever it finds. Observing an
    // element already being observed just replaces its box options — it does
    // not add a second callback — so calling this again each time the
    // region's children change is harmless.
    const observeReserved = () => {
      if (resize === null) return;
      for (const selector of RESERVED_SELECTORS) {
        const element = container.querySelector(selector);
        if (element !== null) resize.observe(element);
      }
    };
    observeReserved();

    const structure =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((mutations) => {
            schedule();
            if (mutations.some((mutation) => mutation.type === "childList")) {
              observeReserved();
            }
          });
    structure?.observe(container, { childList: true, subtree: true, characterData: true });

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      resize?.disconnect();
      structure?.disconnect();
    };
  }, [container, apply]);

  return { ref: setContainer, height };
}

/**
 * The measured body height, published by `ListTableRegion`. `undefined`
 * anywhere else — a drawer, a dashboard card — which is exactly what a table
 * outside a list region wants.
 */
export const TableBodyHeightContext = createContext<number | undefined>(undefined);

/** For a table component rendered inside a `ListTableRegion`. */
export function useListTableBodyHeight(): number | undefined {
  return useContext(TableBodyHeightContext);
}
