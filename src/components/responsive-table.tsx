"use client";

/**
 * An antd `<Table>` that turns into a list of cards on the compact layout.
 *
 * A table is a grid of columns sized for a 1400px window. On a phone there are
 * two honest options — cut columns out, or stop drawing a grid — and the owner
 * has ruled that no column may be cut: everything a row says on a desktop must
 * still be readable on a phone. So below `lg` (`useCompactLayout`, 1024px) this
 * component stops rendering a table and renders one card per record instead,
 * with every column of that row as a label/value pair. Taller rows, all the
 * data, no horizontal scrolling.
 *
 * **From `lg` up it is the antd `<Table>` and nothing else.** Every prop is
 * forwarded untouched, so the desktop layout — column widths, the pinned body
 * from `ListPageBody`, selection, expansion, sorting, the pager — is byte for
 * byte what it was before the swap.
 *
 * ## Swapping a page's table over
 *
 * ```tsx
 * - <Table<Loan>
 * + <ResponsiveTable<Loan>
 *     dataSource={items}
 *     rowKey="id"
 *     columns={columns}
 *     size="middle"
 *     scroll={{ x: 1390, y: bodyHeight }}
 *     pagination={{ … }}
 * +   compact={{ title: (loan) => loan.name }}
 *   />
 * ```
 *
 * That is the whole change. Keep `scroll`, `size` and the rest exactly as they
 * are: they are desktop props and the card list ignores them.
 *
 * The optional `compact` prop is the only new surface:
 *
 * - `title(record, index)` — what the card is called. Without it the card takes
 *   the **first labelled column's** rendered content, with its label dropped,
 *   which is already the right answer for most lists here (Customers' email,
 *   a role's name, a service's key). Pass one when the first column is a
 *   status tag, a checkbox-ish flag or a date rather than the row's name.
 * - `titleColumn` — the key (or `dataIndex`) of the column the heading stands
 *   in for, which is then not printed again as a label/value row. Only worth
 *   passing when the automatic answer below is wrong.
 * - `hidden` — column keys (or `dataIndex`es) to leave off the cards. For a
 *   column that only repeats something the title already says. Use it
 *   sparingly: the point of the cards is that nothing is cut.
 * - `table` — keep the real table on compact; see "When the cards step aside".
 *
 * ### Which column the heading replaces
 *
 * A heading that is also printed as a field says everything twice, and when the
 * cell is interactive (the Rules name is a button) it costs a second tab stop
 * as well. So one column is treated as "already said by the heading" and left
 * out of the fields:
 *
 *   - with no `compact.title`, the first labelled column — it *is* the heading;
 *   - with `compact.titleColumn`, the column it names;
 *   - with `compact.title` and no `titleColumn`, the **first** column whose
 *     rendered text equals the heading's text **on every row of the page**.
 *     Every call site here passes a title that is the identity column's own
 *     renderer (the Rules name, a ledger row's payee, a valuation's amount), so
 *     the match is exact and the column drops out by itself. First, and one
 *     only: a page where two columns both read as an em dash throughout drops
 *     the earlier one, which is the one the heading is showing.
 *
 * Whole-column rather than per-row on purpose: a column that happens to repeat
 * one card's heading keeps its rows, because dropping it would take data off
 * the card, and the whole point of the cards is that nothing is cut. The first
 * labelled column is *not* assumed to be the one a `title` replaces — in this
 * app it is usually the date, and assuming it would delete the date column from
 * seven lists.
 * - `table` — keep the real table on compact. For a grid that is a table by
 *   nature (a grid with one column per period, say), where sideways scrolling
 *   reads better than one card per row.
 *
 * ## How it sits inside the list frame
 *
 * It needs no help. On compact `ListPageBody` measures nothing, hands
 * `undefined` to its function child and publishes `undefined` on
 * `TableBodyHeightContext`, so `scroll.y` is `undefined` and nothing is pinned;
 * the cards are an ordinary block in the frame's body and the pane scrolls as
 * one. On desktop the frame behaves exactly as it always has and the table
 * inside is pinned as before.
 *
 * ## When the cards step aside
 *
 * Some tables say things a card list cannot mirror: a `summary` row of totals,
 * a `footer` or `title` panel, custom `components`, antd's `virtual` body, a
 * `sticky` header. Rather than drop them, this renders the **real antd table**
 * on compact too, with every prop forwarded as on the desktop. It keeps its
 * `scroll.x` and scrolls sideways inside its container, so every column is
 * still reachable — just with a finger drag instead of a card.
 *
 * The trigger, exactly: `compact.table` true, `summary`, `footer`, `title` or
 * `components` present (not `undefined`), `virtual` true, or `sticky` anything
 * but `false`. The two booleans are read for their value rather than their
 * presence, because a table that computes `virtual={rows.length > 300}` or
 * `sticky={sticky}` is asking for neither when the answer is `false`. In this
 * app that is the import report's totals row (`summary`), the CSV preview's
 * `footer`, a long schedule's `virtual` and a grid that asks for
 * the table outright with `compact.table` — one column per month reads better
 * scrolled sideways than as a card, and asking through the prop rather than
 * through its measured `sticky` keeps it from flashing a list of cards for the
 * paint before the measurement lands.
 *
 * ## What the cards do
 *
 * **Sorting is the columns', not the header's.** A card list has no header to
 * click, so it honours what the columns already say:
 *
 *   - a column carrying an active `sortOrder` **and** a comparator is applied,
 *     the same way antd applies it on the desktop;
 *   - a column carrying an active `sortOrder` and **no** comparator (`sorter:
 *     true`, the pattern for a store that sorts the
 *     rows and the column only draws the arrow) means the rows arrived sorted,
 *     so they are left exactly as they came;
 *   - otherwise the first column with a `defaultSortOrder` and a comparator
 *     sorts a copy of the rows before they are paged, as antd would.
 *
 * Nothing on a card can re-sort the list; the page's own sort control, where it
 * has one, still can.
 *
 * Selection keeps both halves it has on the desktop: a checkbox per card, and
 * a "Select all on this page" line above the list — checked, indeterminate or
 * clear against the selectable rows of the current page, and leaving keys from
 * other pages alone, as `preserveSelectedRowKeys` asks. "This page" means every
 * row drawn from it, **tree children included**, which is the same reach the
 * table's header checkbox has. A string `rowSelection.columnTitle` — the word
 * the column header would have carried, "Cleared" on a reconciliation ledger, say
 * — names both: it becomes each checkbox's `aria-label` (unless
 * `getCheckboxProps` already gave one) and the parenthesis in "Select all on
 * this page (Cleared)".
 *
 * Expansion covers both shapes antd has. An `expandable.expandedRowRender` row
 * becomes a "Details" toggle on the card; **tree data** — records carrying a
 * `children` array, the way a categories tree nests subcategories —
 * becomes a "Show N" toggle that opens the child records as cards inside the
 * parent's. Controlled (`expandedRowKeys`) and uncontrolled forms both work,
 * `onExpand` and `onExpandedRowsChange` both fire, `showExpandColumn: false`
 * hides the toggle exactly as it hides the column (the import wizard's account
 * step opens its rows from its own select), and `expandRowByClick` makes a tap
 * on the card open it. An `expandIcon` is ignored: the toggle button replaces
 * it.
 *
 * ## What the cards do not do
 *
 * Interactive sorting, filtering, `fixed`/`width`/`align`/`ellipsis`, `scroll`,
 * `size`, `bordered` and `showHeader` are desktop affordances and are ignored
 * below `lg`. Selection must be the controlled `selectedRowKeys` form — the
 * only form used here — and there is no `radio` type. Columns must be the
 * `columns` prop: the `<Table><Column …/></Table>` children syntax is forwarded
 * on desktop but invisible to the cards, and nothing in this app writes columns
 * that way.
 *
 * Of `pagination` the cards read `current`, `pageSize`, `total`, `onChange`,
 * `onShowSizeChange`, `showSizeChanger`, `pageSizeOptions`, `showTotal`,
 * `hideOnSinglePage` and the `default*` pair. `size`, `position`, `simple`,
 * `showQuickJumper`, `itemRender`, `disabled`, `locale` and `showLessItems` are
 * not forwarded; none of them is used in this app, and the pager here is always
 * `size="small"` and `responsive`.
 *
 * Of `onRow`, a tap on the card runs `onClick` and then `onDoubleClick` — both,
 * in that order, which is what a desktop double-click produces and what the
 * lists that use both rely on (the click selects the row for the ribbon, the
 * double-click opens it). A table that declares only one gets that one. `style`
 * and `aria-selected` are applied to the card as well, since that is the only
 * way eight master/detail lists here mark the selected row; the card's own
 * surface is merged first, so the row's tint wins. `className`, `data-*`,
 * `onMouseEnter` and the rest are row decorations with no card equivalent and
 * are dropped; `rowClassName` *is* applied, to the card. And the `selectedRows`
 * handed to `rowSelection.onChange` holds only rows this `dataSource` can
 * resolve: keys selected on another page are kept in the key array, but their
 * records are not in it.
 *
 * The hook's server snapshot is `false`, so the server always renders the
 * table; a phone shows one table-shaped frame and then the cards on the next
 * paint. That, and the hook itself, is why this file is a Client Component.
 */

import { Fragment, isValidElement, useId, useState } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { Button, Checkbox, Empty, Pagination, Spin, Table } from "antd";
import type {
  TableColumnGroupType,
  TableColumnType,
  TableColumnsType,
  TableProps,
} from "antd";
import { useCompactLayout } from "@/lib/hooks/use-compact-layout";
import { surfaceColors } from "@/lib/theme/colors";

/* -------------------------------------------------------------------------- */
/* Props                                                                      */
/* -------------------------------------------------------------------------- */

export interface ResponsiveTableCompactOptions<RecordType> {
  /** The card's heading. Defaults to the first labelled column's content. */
  title?: (record: RecordType, index: number) => ReactNode;
  /**
   * The key (or `dataIndex`) of the column `title` stands in for, which is then
   * not printed again as a label/value row. Only needed when the content match
   * described in this file's header cannot find it.
   */
  titleColumn?: string;
  /** Column keys (or `dataIndex`es) to leave off the cards. */
  hidden?: string[];
  /**
   * Keep the real table on compact too. For a grid that is a table by nature
   * — a grid with one column per period — where a card per row would be
   * a worse reading than sideways scrolling, and where waiting for a
   * measured `sticky` to force the fallback would flash a list of cards for
   * one paint first.
   */
  table?: boolean;
}

export interface ResponsiveTableProps<RecordType> extends TableProps<RecordType> {
  /** Card-list options. Everything else is an antd `<Table>` prop. */
  compact?: ResponsiveTableCompactOptions<RecordType>;
}

/* -------------------------------------------------------------------------- */
/* Reading a record the way antd does                                         */
/* -------------------------------------------------------------------------- */

/**
 * antd's key type, read back off its own props rather than imported from React,
 * so the two can never drift apart.
 *
 * Every array built out of these is annotated `RowKey[]` on the way in. React's
 * `Key` carries an experimental `unique symbol` member, and an array literal
 * widens that to plain `symbol` — which is then no longer assignable back to
 * `Key`. The annotation stops the widening; there is nothing else behind it.
 */
type RowKey = NonNullable<
  NonNullable<TableProps<Record<string, unknown>>["rowSelection"]>["selectedRowKeys"]
>[number];

/** What `rowSelection.getCheckboxProps` answers, for one record. */
type CheckboxPropsFor<RecordType> = ReturnType<
  NonNullable<NonNullable<TableProps<RecordType>["rowSelection"]>["getCheckboxProps"]>
>;

/** One card's worth of resolved row state, worked out once per render. */
interface CardRow<RecordType> {
  record: RecordType;
  /** The row's place within its own level, which is the index antd hands out. */
  index: number;
  key: RowKey;
  checkboxProps: CheckboxPropsFor<RecordType> | undefined;
}

/** antd's own default: the record's `key` property when no `rowKey` is given. */
const DEFAULT_ROW_KEY = "key";

/** antd's default page size when `pagination` asks for one but names none. */
const DEFAULT_PAGE_SIZE = 10;

/** antd's default property for tree data's child rows. */
const DEFAULT_CHILDREN_COLUMN = "children";

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** The record's key: a function, a property name, or the row's position. */
function resolveRowKey<RecordType>(
  record: RecordType,
  index: number,
  rowKey: TableProps<RecordType>["rowKey"],
): RowKey {
  if (typeof rowKey === "function") return rowKey(record, index);
  const name = typeof rowKey === "string" ? rowKey : DEFAULT_ROW_KEY;
  const value = asRecord(record)[name];
  if (typeof value === "string" || typeof value === "number") return value;
  return index;
}

/**
 * A cell's raw value, read through `dataIndex` — a property name, a number, or
 * an array walked one step at a time, as antd's `get` does.
 */
function readValue<RecordType>(
  record: RecordType,
  dataIndex: TableColumnType<RecordType>["dataIndex"],
): unknown {
  if (dataIndex === undefined || dataIndex === null) return undefined;
  const path: unknown[] = Array.isArray(dataIndex) ? [...dataIndex] : [dataIndex];
  let current: unknown = record;
  for (const step of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = asRecord(current)[String(step)];
  }
  return current;
}

/** The child records of a tree row, or an empty list for an ordinary one. */
function childRecords<RecordType>(
  record: RecordType,
  childrenColumn: string,
): readonly RecordType[] {
  const value = asRecord(record)[childrenColumn];
  return Array.isArray(value) ? (value as RecordType[]) : [];
}

/**
 * `render` may return either a node or antd's `{ children, props }` envelope
 * (the `colSpan` / `rowSpan` form). Only the children can mean anything on a
 * card, so the envelope is unwrapped.
 */
function unwrapRendered(rendered: unknown): ReactNode {
  if (
    rendered !== null &&
    typeof rendered === "object" &&
    !isValidElement(rendered) &&
    !Array.isArray(rendered) &&
    "children" in rendered
  ) {
    return (rendered as { children?: ReactNode }).children ?? null;
  }
  return rendered as ReactNode;
}

/** An em dash rather than an empty value, matching the cells in the tables. */
function Dash() {
  return <span style={{ color: surfaceColors.textTertiary }}>—</span>;
}

/** A raw value with no `render` behind it, made printable. `null` when empty. */
function printValue(value: unknown): ReactNode {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (isValidElement(value)) return value;
  return String(value);
}

/**
 * Whether a rendered cell says nothing. A label/value row prints an em dash for
 * one of these; an actions row is left out altogether, along with the rule
 * above it, so a card whose row offers no action has no empty strip.
 *
 * The element case is what makes that work: this app's actions cells are a
 * wrapping `<span>` around buttons a condition may have removed (a locked row,
 * a system category), so an element is empty when the children it *does*
 * declare are all empty. An element with no `children` prop at all — an
 * icon-only `<Button icon={…} />` — is a control, not a blank.
 */
function isBlankNode(node: ReactNode): boolean {
  if (node === null || node === undefined || node === false || node === "") return true;
  if (Array.isArray(node)) return node.every((child) => isBlankNode(child as ReactNode));
  if (isValidElement(node)) {
    const { children } = node.props as { children?: ReactNode };
    return children === undefined ? false : isBlankNode(children);
  }
  return false;
}

/**
 * The words a rendered cell says, with the mark-up dropped.
 *
 * Only the children an element *declares* are walked, which reaches the text
 * inside a plain tag and inside an app component alike. Text a component builds
 * for itself out of other props is invisible here and comes back empty — which
 * the heading match below reads as "cannot tell", and so as no match.
 */
function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return (node as ReactNode[]).map(nodeText).join(" ");
  if (isValidElement(node)) {
    const { children } = node.props as { children?: ReactNode };
    return nodeText(children);
  }
  return "";
}

/** {@link nodeText}, normalised, so a line break cannot fail a comparison. */
function textKey(node: ReactNode): string {
  return nodeText(node).replace(/\s+/g, " ").trim();
}

/* -------------------------------------------------------------------------- */
/* Reading the column definitions                                             */
/* -------------------------------------------------------------------------- */

/**
 * Column groups exist to span a header across several columns, which a card has
 * no use for, so a group is replaced by the columns underneath it.
 */
function flattenColumns<RecordType>(
  columns: TableColumnsType<RecordType> | undefined,
): TableColumnType<RecordType>[] {
  if (columns === undefined) return [];
  const flat: TableColumnType<RecordType>[] = [];
  for (const column of columns) {
    const children = (column as TableColumnGroupType<RecordType>).children;
    if (Array.isArray(children)) {
      flat.push(...flattenColumns<RecordType>(children));
    } else {
      flat.push(column as TableColumnType<RecordType>);
    }
  }
  return flat;
}

/** How `compact.hidden` names a column: its `key`, else its `dataIndex`. */
function identifyColumn<RecordType>(
  column: TableColumnType<RecordType>,
  index: number,
): string {
  if (column.key !== undefined) return String(column.key);
  const dataIndex: unknown = column.dataIndex;
  if (Array.isArray(dataIndex)) return dataIndex.join(".");
  if (dataIndex !== undefined && dataIndex !== null) return String(dataIndex);
  return `column-${index}`;
}

/**
 * The column's label. antd allows a function there, handed the current sort and
 * filter state; nothing in this app uses one, and a card has no sort state to
 * describe, so it is called with an empty description.
 */
function columnLabel<RecordType>(column: TableColumnType<RecordType>): ReactNode {
  const { title } = column;
  if (typeof title === "function") return title({ sortColumns: [], filters: {} });
  return title;
}

/** A column with no label is this app's convention for a row's actions. */
function isActionColumn<RecordType>(column: TableColumnType<RecordType>): boolean {
  const label = columnLabel(column);
  return label === undefined || label === null || label === "";
}

/**
 * The comparator a column carries, in either spelling antd accepts: the
 * function form, and the `{ compare, multiple }` object the multi-sort form
 * uses. `sorter: true` is a sort the caller performs and has no comparator.
 */
function columnComparator<RecordType>(
  column: TableColumnType<RecordType>,
): ((a: RecordType, b: RecordType, order?: "ascend" | "descend") => number) | undefined {
  const { sorter } = column;
  if (typeof sorter === "function") return sorter;
  if (typeof sorter === "object" && sorter !== null) return sorter.compare;
  return undefined;
}

/**
 * The rows in the order antd would have put them in.
 *
 * A card list has no header to click, so the only sort it can honour is the one
 * the columns ask for themselves — and there are two ways they ask:
 *
 *   - a **controlled** `sortOrder`, the pattern for a store-sorted list:
 *     the store sorts the rows and the column carries `sorter: true` only to
 *     draw the arrow. There is no comparator to run and the rows are already in
 *     the right order, so they are handed back untouched. Running something
 *     else over them would undo the page's own sort;
 *   - a `defaultSortOrder` with a real comparator, which antd applies itself on
 *     the desktop. Several lists lean on it, and without this the cards would
 *     come out in whatever order the repository happened to hand over.
 *
 * `descend` negates the comparator rather than reversing the sorted array, so
 * rows that compare equal keep the order they arrived in, as a stable sort in
 * either direction should.
 */
function applyColumnSort<RecordType>(
  data: readonly RecordType[],
  columns: readonly TableColumnType<RecordType>[],
): readonly RecordType[] {
  const controlled = columns.find(
    (candidate) => candidate.sortOrder === "ascend" || candidate.sortOrder === "descend",
  );
  if (controlled !== undefined) {
    const compare = columnComparator(controlled);
    if (compare === undefined) return data;
    return sortCopy(data, compare, controlled.sortOrder === "descend");
  }

  const column = columns.find(
    (candidate) =>
      (candidate.defaultSortOrder === "ascend" || candidate.defaultSortOrder === "descend") &&
      columnComparator(candidate) !== undefined,
  );
  if (column === undefined) return data;
  const compare = columnComparator(column);
  if (compare === undefined) return data;
  return sortCopy(data, compare, column.defaultSortOrder === "descend");
}

function sortCopy<RecordType>(
  data: readonly RecordType[],
  compare: (a: RecordType, b: RecordType, order?: "ascend" | "descend") => number,
  descending: boolean,
): readonly RecordType[] {
  const order = descending ? "descend" : "ascend";
  const sign = descending ? -1 : 1;
  return [...data].sort((a, b) => sign * compare(a, b, order));
}

/**
 * Whether the cards can stand in for this table at all. See the file's header:
 * a totals row, a panel, custom components, a virtual body or a sticky header
 * have no card equivalent, so such a table is rendered as a table on compact
 * too and scrolls sideways instead.
 */
function cardsCanMirror<RecordType>(props: ResponsiveTableProps<RecordType>): boolean {
  if (props.compact?.table === true) return false;
  if (props.summary !== undefined) return false;
  if (props.footer !== undefined) return false;
  if (props.title !== undefined) return false;
  if (props.components !== undefined) return false;
  if (props.virtual === true) return false;
  if (props.sticky !== undefined && props.sticky !== false) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/* ResponsiveTable                                                            */
/* -------------------------------------------------------------------------- */

export default function ResponsiveTable<RecordType = Record<string, unknown>>(
  props: ResponsiveTableProps<RecordType>,
) {
  const compactLayout = useCompactLayout();
  // Prefix for the per-card ids that tie an "Open" button to its heading.
  const idPrefix = useId();

  const {
    compact,
    columns,
    dataSource,
    rowKey,
    rowSelection,
    expandable,
    onRow,
    pagination,
    loading,
    locale,
    caption,
    rowClassName,
    className,
    style,
    ...rest
  } = props;

  // Hooks first, unconditionally: the desktop branch below is an early return.
  const [openKeys, setOpenKeys] = useState<readonly RowKey[]>(
    () => expandable?.defaultExpandedRowKeys ?? [],
  );
  const pager = pagination === false ? undefined : pagination;
  const [innerPage, setInnerPage] = useState(() => pager?.defaultCurrent ?? 1);
  const [innerPageSize, setInnerPageSize] = useState(
    () => pager?.defaultPageSize ?? pager?.pageSize ?? DEFAULT_PAGE_SIZE,
  );

  if (!compactLayout || !cardsCanMirror(props)) {
    // Exactly the element antd would have rendered from the same props: the
    // only thing taken out is `compact`, which is ours.
    return (
      <Table<RecordType>
        {...rest}
        columns={columns}
        dataSource={dataSource}
        rowKey={rowKey}
        rowSelection={rowSelection}
        expandable={expandable}
        onRow={onRow}
        pagination={pagination}
        loading={loading}
        locale={locale}
        caption={caption}
        rowClassName={rowClassName}
        className={className}
        style={style}
      />
    );
  }

  /* ---------------------------------------------------------------------- */
  /* The card list                                                          */
  /* ---------------------------------------------------------------------- */

  const data: readonly RecordType[] = dataSource ?? [];
  const hidden = new Set(compact?.hidden ?? []);
  // Named once, while the whole list is in hand: a column with neither a `key`
  // nor a `dataIndex` is named by its position among all of them.
  const identified = flattenColumns<RecordType>(columns).map((column, index) => ({
    column,
    id: identifyColumn(column, index),
  }));
  const flatColumns = identified.map((entry) => entry.column);
  const visibleColumns = identified.filter(
    ({ column, id }) => column.hidden !== true && !hidden.has(id),
  );
  // A column with no label is this app's actions cell: a control, not a name.
  const labelledColumns = visibleColumns.filter(({ column }) => !isActionColumn(column));
  const actionColumns = visibleColumns.filter(({ column }) => isActionColumn(column));

  const childrenColumn = expandable?.childrenColumnName ?? DEFAULT_CHILDREN_COLUMN;

  /* Sorting, then paging — antd's order, and the reason the pager can be left
     alone: a server-paged list is sorted within the page it was sent, exactly
     as antd sorts it there. The sort reads every column, including one the
     cards hide, since hiding a column does not unsort the list. */
  const sorted = applyColumnSort(data, flatColumns);

  /* A pager carrying a `total` is the server-side form: the rows handed in are
     already the page. Anything else is sliced here, the way antd slices it. */
  const serverPaged = pager !== undefined && typeof pager.total === "number";
  const current = pager?.current ?? innerPage;
  const pageSize = pager?.pageSize ?? innerPageSize;
  const total = pager?.total ?? sorted.length;
  const rows =
    pagination === false || serverPaged
      ? sorted
      : sorted.slice((current - 1) * pageSize, current * pageSize);

  const changePage = (page: number, size: number) => {
    setInnerPage(page);
    setInnerPageSize(size);
    pager?.onChange?.(page, size);
    if (size !== pageSize) pager?.onShowSizeChange?.(page, size);
  };

  /* One level of rows, resolved: antd hands rc-table only the rows of the
     current page, so the index a cell, `onRow`, `rowClassName` and `rowKey` are
     given is the row's place *within its own level* — in the server-paged case
     and the client-sliced one alike. */
  const buildRows = (records: readonly RecordType[]): CardRow<RecordType>[] =>
    records.map((record, position) => ({
      record,
      index: position,
      key: resolveRowKey(record, position, rowKey),
      checkboxProps: rowSelection?.getCheckboxProps?.(record),
    }));

  const cardRows = buildRows(rows);

  /* Every row the page draws, tree children included. Select-all works from
     this rather than from the top level, because the table's own header
     checkbox reaches a nested child too. */
  const collectRows = (list: CardRow<RecordType>[], into: CardRow<RecordType>[]) => {
    for (const row of list) {
      into.push(row);
      collectRows(buildRows(childRecords(row.record, childrenColumn)), into);
    }
    return into;
  };
  const pageRows = collectRows(cardRows, []);

  /* Which column the heading stands in for, so the card never prints the same
     thing twice. See this file's header: named, matched by content over the
     whole page, or — with no `compact.title` — simply the first labelled
     column, which *is* the heading. No match means nothing is dropped. */
  const titleOf = compact?.title;
  let headingId: string | undefined;
  if (titleOf === undefined) {
    headingId = labelledColumns[0]?.id;
  } else if (compact?.titleColumn !== undefined) {
    headingId = compact.titleColumn;
  } else if (cardRows.length > 0) {
    const headings = cardRows.map(({ record, index }) => textKey(titleOf(record, index)));
    headingId = labelledColumns.find(({ column }) =>
      cardRows.every(({ record, index }, position) => {
        const cell = textKey(renderCell(column, record, index));
        return cell !== "" && cell === headings[position];
      }),
    )?.id;
  }
  const headingColumn = labelledColumns.find(({ id }) => id === headingId);
  const fieldColumns = labelledColumns.filter(({ id }) => id !== headingId);

  /* Selection. Controlled only: the keys handed back are the whole selection —
     keys from other pages included, which is what `preserveSelectedRowKeys`
     asks for — and the rows are the ones this `dataSource` can resolve. */
  // The word the selection column's header would have carried, when it is a
  // plain string: the only part of `columnTitle` a card can speak.
  const selectionLabel =
    typeof rowSelection?.columnTitle === "string" ? rowSelection.columnTitle : undefined;
  const selectedKeys: readonly RowKey[] = rowSelection?.selectedRowKeys ?? [];
  const selectedLookup = new Set(selectedKeys.map(String));
  const keyOfRow = new Map<string, RecordType>();
  const registerRows = (records: readonly RecordType[]) => {
    records.forEach((record, index) => {
      keyOfRow.set(String(resolveRowKey(record, index, rowKey)), record);
      registerRows(childRecords(record, childrenColumn));
    });
  };
  registerRows(sorted);
  // The page's own keys win: with no `rowKey` a record's key is its position,
  // and the position within the page is the one the cards are drawn with.
  for (const row of pageRows) keyOfRow.set(String(row.key), row.record);

  const resolveRows = (keys: readonly RowKey[]) =>
    keys
      .map((candidate) => keyOfRow.get(String(candidate)))
      .filter((row): row is RecordType => row !== undefined);

  const toggleSelection = (record: RecordType, key: RowKey, checked: boolean, event: Event) => {
    if (rowSelection === undefined) return;
    const nextKeys: RowKey[] = checked
      ? [...selectedKeys, key]
      : selectedKeys.filter((candidate) => String(candidate) !== String(key));
    const nextRows = resolveRows(nextKeys);
    rowSelection.onChange?.(nextKeys, nextRows, { type: "single" });
    rowSelection.onSelect?.(record, checked, nextRows, event);
  };

  /* Select-all, over the rows of this page only — the same scope as the table's
     header checkbox, which never reaches another page either. Rows whose
     `getCheckboxProps` disables them are left out of both the answer and the
     count, so a page of disabled rows cannot report itself as fully selected. */
  const selectableRows = pageRows.filter((row) => row.checkboxProps?.disabled !== true);
  const selectedOnPage = selectableRows.filter((row) => selectedLookup.has(String(row.key)));
  const allSelected = selectableRows.length > 0 && selectedOnPage.length === selectableRows.length;
  const someSelected = selectedOnPage.length > 0 && !allSelected;

  const toggleAll = (checked: boolean) => {
    if (rowSelection === undefined) return;
    const pageKeys = new Set(selectableRows.map((row) => String(row.key)));
    // Everything from other pages survives untouched; only this page's keys
    // are rewritten.
    const kept: RowKey[] = selectedKeys.filter((candidate) => !pageKeys.has(String(candidate)));
    const nextKeys: RowKey[] = checked
      ? [...kept, ...selectableRows.map((row) => row.key)]
      : kept;
    const nextRows = resolveRows(nextKeys);
    const changedRows = (
      checked
        ? selectableRows.filter((row) => !selectedLookup.has(String(row.key)))
        : selectedOnPage
    ).map((row) => row.record);
    rowSelection.onChange?.(nextKeys, nextRows, { type: "all" });
    rowSelection.onSelectAll?.(checked, nextRows, changedRows);
  };

  /* Expansion. Uncontrolled unless the caller controls it, as antd is. */
  const expandedRowRender = expandable?.expandedRowRender;
  const controlledExpansion = expandable?.expandedRowKeys !== undefined;
  const expandedKeys: readonly RowKey[] = controlledExpansion
    ? (expandable?.expandedRowKeys ?? [])
    : openKeys;

  const toggleExpansion = (record: RecordType, key: RowKey, open: boolean) => {
    const nextKeys: RowKey[] = open
      ? [...expandedKeys, key]
      : expandedKeys.filter((candidate) => String(candidate) !== String(key));
    if (!controlledExpansion) setOpenKeys(nextKeys);
    expandable?.onExpand?.(open, record);
    expandable?.onExpandedRowsChange?.(nextKeys);
  };

  const spinning =
    typeof loading === "object" && loading !== null ? (loading.spinning ?? true) : loading === true;

  const emptyText = typeof locale?.emptyText === "function" ? locale.emptyText() : locale?.emptyText;

  const cardStyle: CSSProperties = {
    backgroundColor: surfaceColors.card,
    border: `1px solid ${surfaceColors.separator}`,
  };

  /**
   * One record as a card, and — when it is a tree row the reader has opened —
   * its children as cards inside it. `path` only feeds the ids that tie an
   * "Open" button to its heading, so it has to be unique down the tree rather
   * than merely within a level.
   */
  const renderCard = ({ record, index, key, checkboxProps }: CardRow<RecordType>, path: string) => {
    const rowProps = onRow?.(record, index);
    // Desktop opens a row with a double-click; a finger has no such gesture, so
    // one tap produces what a double-click produces: `onClick` and then
    // `onDoubleClick`, in that order. Four lists here declare both and split
    // the work between them — the click selects the row for the ribbon, the
    // double-click opens it — and running only one of them would either fail
    // to open the row or open it with nothing selected. A list that declares
    // one handler gets that one.
    const rowClick = rowProps?.onClick;
    const rowDoubleClick = rowProps?.onDoubleClick;
    const activate =
      rowClick === undefined && rowDoubleClick === undefined
        ? undefined
        : (event: MouseEvent<HTMLElement>) => {
            rowClick?.(event);
            rowDoubleClick?.(event);
          };
    const extraClass =
      typeof rowClassName === "function"
        ? rowClassName(record, index, 0)
        : (rowClassName ?? "");

    const expanded = expandedKeys.some((candidate) => String(candidate) === String(key));
    const children = childRecords(record, childrenColumn);
    const canExpand =
      (expandedRowRender !== undefined && (expandable?.rowExpandable?.(record) ?? true)) ||
      children.length > 0;
    // `showExpandColumn: false` takes the toggle away exactly as it takes the
    // column away on the desktop: the rows that open are decided elsewhere, by
    // the controlled `expandedRowKeys`.
    const showToggle = canExpand && expandable?.showExpandColumn !== false;
    const expandByTap = canExpand && expandable?.expandRowByClick === true;

    // Rendered once, so an actions strip that came out empty — every button
    // behind a condition the row fails — takes its rule with it instead of
    // drawing a bare line under the card.
    const actions = actionColumns
      .map(({ column, id }) => ({ id, node: renderCell(column, record, index) }))
      .filter((action) => !isBlankNode(action.node));

    const heading =
      titleOf !== undefined
        ? titleOf(record, index)
        : headingColumn === undefined
          ? null
          : renderCell(headingColumn.column, record, index);

    const handleClick = (event: MouseEvent<HTMLDivElement>) => {
      // A tap that landed on a control inside the card — an action button, the
      // checkbox, a link — belongs to that control.
      const target = event.target as HTMLElement | null;
      const inner = target?.closest("button, a, input, select, textarea, [role='button']");
      if (inner !== null && inner !== undefined && inner !== event.currentTarget) return;
      if (expandByTap) toggleExpansion(record, key, !expanded);
      activate?.(event);
    };

    const tappable = activate !== undefined || expandByTap;

    // The row's own decorations. A master/detail list marks its selected row
    // with nothing but these, so the card wears them too: the tint is merged
    // after the card's own surface, which is what lets it win.
    const cardSurface: CSSProperties = {
      ...cardStyle,
      ...(tappable ? { cursor: "pointer" } : null),
      ...rowProps?.style,
    };

    return (
      <li key={String(key)}>
        {/* Not a `role="button"`: a widget role may not contain the checkbox,
            the Details toggle and the action buttons this card contains, and a
            screen reader would announce the whole card as one control. The tap
            target stays — it is what a finger expects — and the keyboard gets
            the "Open" button in the header instead. */}
        <div
          className={`rounded-lg p-3 ${extraClass}`}
          style={cardSurface}
          aria-selected={rowProps?.["aria-selected"]}
          onClick={tappable ? handleClick : undefined}
        >
          <div className="flex items-start gap-2">
            {rowSelection !== undefined && (
              <Checkbox
                {...checkboxProps}
                // What `getCheckboxProps` said, else the selection column's own
                // header word, else nothing — a checkbox in a card that names
                // the row beside it is not silent either way.
                aria-label={checkboxLabel(checkboxProps) ?? selectionLabel}
                className="mt-0.5 shrink-0"
                checked={selectedLookup.has(String(key))}
                onChange={(event) =>
                  toggleSelection(record, key, event.target.checked, event.nativeEvent)
                }
              />
            )}

            <div
              id={`${idPrefix}h${path}`}
              className="min-w-0 flex-1 text-sm font-semibold break-words"
              style={{ color: surfaceColors.text }}
            >
              {heading}
            </div>

            {activate !== undefined && (
              // What the desktop's double-click (or row click) does, as a
              // control a keyboard can reach. Most lists also have an action
              // button that opens the row; some do not, so here this is the
              // only door. Named "Open <heading>" so a page of cards does not
              // announce twenty-five identical links.
              <Button
                type="link"
                size="small"
                className="shrink-0"
                id={`${idPrefix}o${path}`}
                aria-labelledby={`${idPrefix}o${path} ${idPrefix}h${path}`}
                onClick={(event) => activate(event)}
              >
                Open
              </Button>
            )}

            {showToggle && (
              <Button
                type="link"
                size="small"
                className="shrink-0"
                aria-expanded={expanded}
                onClick={() => toggleExpansion(record, key, !expanded)}
              >
                {expandedRowRender !== undefined
                  ? expanded
                    ? "Hide details"
                    : "Details"
                  : expanded
                    ? "Hide"
                    : `Show ${children.length}`}
              </Button>
            )}
          </div>

          {fieldColumns.length > 0 && (
            <dl className="m-0 mt-2 grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              {fieldColumns.map(({ column, id }) => (
                <Fragment key={id}>
                  <dt
                    className="min-w-0 text-[11px] tracking-wide break-words uppercase"
                    style={{ color: surfaceColors.textSecondary }}
                  >
                    {columnLabel(column)}
                  </dt>
                  <dd
                    className="m-0 min-w-0 text-sm break-words"
                    style={{ color: surfaceColors.text }}
                  >
                    {fieldCell(column, record, index)}
                  </dd>
                </Fragment>
              ))}
            </dl>
          )}

          {actions.length > 0 && (
            <div
              className="mt-2 flex items-center justify-end gap-1 pt-2"
              style={{ borderTop: `1px solid ${surfaceColors.separator}` }}
            >
              {actions.map((action) => (
                <Fragment key={action.id}>{action.node}</Fragment>
              ))}
            </div>
          )}

          {expanded && expandedRowRender !== undefined && (
            <div
              className="mt-2 pt-2"
              style={{ borderTop: `1px solid ${surfaceColors.separator}` }}
            >
              {expandedRowRender(record, index, 0, true)}
            </div>
          )}

          {/* Tree data: the child records as cards of their own, nested inside
              the parent's, which is the card equivalent of antd's indent. */}
          {expanded && expandedRowRender === undefined && children.length > 0 && (
            <ul
              // `list-none` strips the list semantics with the bullets in
              // Safari, so the role is put back by hand.
              role="list"
              className="m-0 mt-2 flex list-none flex-col gap-2 p-0 pt-2"
              style={{ borderTop: `1px solid ${surfaceColors.separator}` }}
            >
              {buildRows(children).map((child, childIndex) =>
                renderCard(child, `${path}-${childIndex}`),
              )}
            </ul>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className={className} style={style}>
      {caption !== undefined && caption !== null && <h3 className="sr-only">{caption}</h3>}

      <Spin spinning={spinning}>
        {cardRows.length === 0 ? (
          <div className="py-6">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />
          </div>
        ) : (
          <>
            {rowSelection !== undefined && (
              // The header checkbox the table has, on a line of its own: taking
              // it away on a phone would take select-all off the settings
              // screens altogether.
              <div className="mb-2 flex items-center px-1">
                <Checkbox
                  checked={allSelected}
                  indeterminate={someSelected}
                  disabled={selectableRows.length === 0}
                  onChange={(event) => toggleAll(event.target.checked)}
                >
                  <span
                    className="text-[11px] tracking-wide uppercase"
                    style={{ color: surfaceColors.textSecondary }}
                  >
                    {selectionLabel === undefined
                      ? "Select all on this page"
                      : `Select all on this page (${selectionLabel})`}
                  </span>
                </Checkbox>
              </div>
            )}

            {/* `role="list"`: `list-none` takes the list semantics away with
                the bullets in Safari, and a card list that announces no count
                is a page of anonymous groups in VoiceOver. */}
            <ul role="list" className="m-0 flex list-none flex-col gap-2 p-0">
              {cardRows.map((row, position) => renderCard(row, String(position)))}
            </ul>
          </>
        )}
      </Spin>

      {/* antd's own condition: a pager for as long as there is anything to
          page. Not `rows.length`, or a reader whose page came back empty —
          the last row of the last page deleted, a filter narrowed — would be
          left on it with no way back. */}
      {pagination !== false && total > 0 && (
        <div className="mt-3 flex justify-end">
          <Pagination
            size="small"
            responsive
            current={current}
            pageSize={pageSize}
            total={total}
            showSizeChanger={pager?.showSizeChanger}
            pageSizeOptions={pager?.pageSizeOptions}
            showTotal={pager?.showTotal}
            hideOnSinglePage={pager?.hideOnSinglePage}
            onChange={changePage}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The `aria-label` a row's `getCheckboxProps` already gave, if any. antd types
 * the answer as a checkbox's props, which carry every ARIA attribute, so the
 * read is narrowed here rather than asserted at the call site.
 */
function checkboxLabel(props: { "aria-label"?: string } | undefined): string | undefined {
  return props?.["aria-label"];
}

/**
 * One cell's content: the column's `render` when it has one, else the value.
 * Empty is left empty here — the caller decides whether that reads as an em
 * dash (a label/value row) or as nothing at all (an actions row).
 */
function renderCell<RecordType>(
  column: TableColumnType<RecordType>,
  record: RecordType,
  index: number,
): ReactNode {
  const value = readValue(record, column.dataIndex);
  if (column.render === undefined) return printValue(value);
  return unwrapRendered(column.render(value, record, index));
}

/** A labelled cell: an em dash rather than a blank, as the table's cells do. */
function fieldCell<RecordType>(
  column: TableColumnType<RecordType>,
  record: RecordType,
  index: number,
): ReactNode {
  const rendered = renderCell(column, record, index);
  return isBlankNode(rendered) ? <Dash /> : rendered;
}

export { ResponsiveTable };
