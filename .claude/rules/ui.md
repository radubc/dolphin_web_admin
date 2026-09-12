---
paths:
  - "src/components/**"
  - "src/app/(app)/**"
---

# List pages: only the rows scroll

The owner's rule for every list in this app: the ribbon, the alerts, the toolbar and filters, the table header and the pager stay on screen; the table's rows are the only thing that scrolls. The page as a whole does not move with the list.

How it is done, and the only way it should be done:

- `ListPageFrame` (`src/components/list-page-frame.tsx`) is the page column. The fixed parts — switcher, alerts, toolbar — are plain children of it and keep their natural height.
- The panel holding the antd `<Table>` goes inside `ListTableRegion` (same file), which takes the height the fixed parts left over and measures how much of it is available for rows.
- The measurement is `useTableBodyHeight` (`src/lib/hooks/use-table-body-height.ts`): the region's height minus the rendered `.ant-table-thead`, `.ant-table-pagination` and anything marked `data-list-reserve` (mark any strip of your own that must stay put, as the audit log's "Load older events" does).
- Pass that number as `scroll={{ x, y }}` on the `<Table>` — keep the existing `x`, antd needs it for column widths. A table written inline takes `y` from the region's function child; a table in its own component reads it with `useListTableBodyHeight()`. Never hard-code a height or a `calc()`.
- The height is `undefined` until measured and on a window too short for a usable scroller; the table then renders in full and scrolls in the frame's body — the frame's root never overflows the shell's `<main>`, because the body below the sticky band is `flex-1` with a basis of 0, so it is always the one that gives. Keep that fallback — never clip a region whose height is unknown.
- Content that is not a table (a stack of cards) scrolls in the frame's body the same way, under the same fixed band. A rail taller than the window scrolls inside its own `aside` instead, which is its own scroll container. Pages outside `ListPageFrame` — Overview, the stubs — still scroll in the shell's `<main>`.
