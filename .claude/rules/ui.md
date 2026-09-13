---
paths:
  - "src/components/**"
  - "src/app/**"
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

# Forms: no asterisks, and always say what is missing

The owner's rule for every add/edit form in the app — and the consumer app has
the identical one. The red asterisk is gone; in exchange a failed submit always
names the mandatory fields that were left empty.

- **The marking is global.** `src/app/providers.tsx` gives the antd
  `ConfigProvider` a `form` config: `requiredMark: false`, `scrollToFirstError`
  (smooth, centred) and `validateMessages` with `required` and `whitespace` set
  to `"${label} is required"` (`${label}` is antd's template variable, so the
  string is a plain quoted literal, never a JS template). **No form sets
  `requiredMark` or `scrollToFirstError` itself** — not `true`, not `false`, not
  `"optional"`. One place decides.
- **Mandatory means a rule.** Every mandatory field is a `Form.Item` with a
  `label` and `rules={[{ required: true }]}` (add `whitespace: true` for text,
  so spaces are not a value). No message: the global template writes it from the
  label. Give the rule its own message only when there is no label, or when the
  label makes bad English in the sentence ("Exchanges are required") — the
  summary understands both the singular and the plural tail.
- **Business rules are unchanged.** Patterns, ranges, cross-field checks and
  uniqueness stay exactly as they are, as extra rules or validators. The
  required rule only ever covers "this was left empty".
- **Save is not the signal.** A Save button is never disabled because a
  mandatory field is empty — pressing it is how the person is told. It may still
  be disabled while saving, while a capability is missing (`canSend`), or hidden
  in a read-only form.
- **The summary.** `src/components/form-error-summary.tsx` exports
  `useFormErrorSummary()` → `{ errorSummary, onFinishFailed, reset }` and the
  `FormErrorSummary` alert. Wire `onFinishFailed` on the `Form`, render
  `<FormErrorSummary summary={errorSummary} onClose={reset} />` as the first
  thing in the form body, and `reset()` on a successful submit and whenever the
  drawer is reopened (a body remounted by `key` + `destroyOnHidden` resets
  itself). It lists the field labels, in form order, under "Some required
  information is missing".
- **Server-side alerts stay.** The 409, the 503 and any other sentence the
  server sends keep their own alert below the summary; the summary is only ever
  about client-side validation.
- **A custom control is no exception.** Anything that is not a plain antd input
  still lives in a `Form.Item` with the same rules, so "X is required" appears
  under it like anywhere else.
