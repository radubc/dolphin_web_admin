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
 * from `ListTableRegion`, selection, expansion, the pager — is byte for byte
 * what it was before the swap.
 *
 * ## Swapping a page's table over
 *
 * ```tsx
 * - <Table<Customer>
 * + <ResponsiveTable<Customer>
 *     dataSource={items}
 *     rowKey="id"
 *     columns={columns}
 *     size="middle"
 *     scroll={{ x: 1390, y }}
 *     pagination={{ … }}
 * +   compact={{ title: (row) => row.email }}
 *   />
 * ```
 *
 * That is the whole change. Keep `scroll`, `size` and the rest exactly as they
 * are: they are desktop props and the card list ignores them.
 *
 * The optional `compact` prop is the only new surface:
 *
 * - `title(row, index)` — what the card is called. Without it the card takes
 *   the **first visible column's** rendered content, with its label dropped,
 *   which is already the right answer for most lists here (Customers' email,
 *   Constants' name, Services' key). Pass one when the first column is a
 *   status tag or a checkbox-ish flag rather than the row's name.
 * - `hidden` — column keys (or `dataIndex`es) to leave off the cards. For a
 *   column that only repeats something the title already says. Use it
 *   sparingly: the point of the cards is that nothing is cut.
 *
 * ## How it sits inside `ListTableRegion`
 *
 * It needs no help. On compact the region measures nothing, hands `undefined`
 * to its function child and publishes `undefined` on `TableBodyHeightContext`,
 * so `scroll.y` is `undefined` and nothing is pinned; the cards are an ordinary
 * block in the frame's body and the page scrolls as one. On desktop the region
 * behaves exactly as it always has and the table inside is pinned as before.
 *
 * ## What the cards do
 *
 * A card list has no column headers to click, so **`defaultSortOrder` is
 * honoured and interactive sorting is not**: the first column that asks for a
 * default order and carries a comparator (`sorter` as a function or as
 * `{ compare }`) sorts a copy of the rows before they are paged, which is what
 * antd does with the same columns on the desktop. Nothing can re-sort them
 * afterwards.
 *
 * Selection keeps both halves it has on the desktop: a checkbox per card, and
 * a "Select all on this page" line above the list — checked, indeterminate or
 * clear against the selectable rows of the current page, and leaving keys from
 * other pages alone, as `preserveSelectedRowKeys` asks.
 *
 * ## What the cards do not do
 *
 * Interactive sorting, filtering, `fixed`/`width`/`align`/`ellipsis`, `scroll`,
 * `sticky`, `summary` and the `title`/`footer` panels are desktop affordances
 * and are ignored below `lg`. Selection must be the controlled
 * `selectedRowKeys` form — the only form used here — and there is no `radio`
 * type. Columns must be the `columns` prop: the `<Table><Column …/></Table>`
 * children syntax is forwarded on desktop but invisible to the cards, and
 * nothing in this app writes columns that way.
 *
 * Of `pagination` the cards read `current`, `pageSize`, `total`, `onChange`,
 * `onShowSizeChange`, `showSizeChanger`, `pageSizeOptions`, `showTotal`,
 * `hideOnSinglePage` and the `default*` pair. `size`, `position`, `simple`,
 * `showQuickJumper`, `itemRender`, `disabled`, `locale` and `showLessItems` are
 * not forwarded; none of them is used in this app, and the pager here is always
 * `size="small"` and `responsive`.
 *
 * Of `onRow` only `onClick` — or `onDoubleClick` in its place — reaches a card.
 * `style`, `className`, `data-*`, `onMouseEnter` and the rest are row
 * decorations with no card equivalent and are dropped; `rowClassName` *is*
 * applied, to the card. And the `selectedRows` handed to `rowSelection.onChange`
 * holds only rows this `dataSource` can resolve: keys selected on another page
 * are kept in the key array, but their records are not in it.
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
  /** The card's heading. Defaults to the first visible column's content. */
  title?: (record: RecordType, index: number) => ReactNode;
  /** Column keys (or `dataIndex`es) to leave off the cards. */
  hidden?: string[];
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
  /** The row's place within the page, which is the index antd hands out. */
  index: number;
  key: RowKey;
  checkboxProps: CheckboxPropsFor<RecordType> | undefined;
}

/** antd's own default: the record's `key` property when no `rowKey` is given. */
const DEFAULT_ROW_KEY = "key";

/** antd's default page size when `pagination` asks for one but names none. */
const DEFAULT_PAGE_SIZE = 10;

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

/** An em dash rather than an empty value, matching the cells in `customers-meta`. */
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
 * above it, so a card for an operator who may do nothing has no empty strip.
 *
 * The element case is what makes that work: this app's actions cells are a
 * wrapping `<span>` around buttons that a permission check may have removed
 * (the Access Map's `rowActions`), so an element is empty when the children it
 * *does* declare are all empty. An element with no `children` prop at all — an
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
 * uses. `sorter: true` is a server-side sort and has no comparator to run.
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
 * the columns ask for themselves: the first column with a `defaultSortOrder`
 * and a comparator. Several of these lists lean on it — the cost breakdowns are
 * biggest-spend-first, Countries and Currencies are alphabetical — and without
 * this the cards would come out in whatever order the server happened to send.
 *
 * `descend` negates the comparator rather than reversing the sorted array, so
 * rows that compare equal keep the order they arrived in, as a stable sort in
 * either direction should.
 */
function applyDefaultSort<RecordType>(
  data: readonly RecordType[],
  columns: readonly TableColumnType<RecordType>[],
): readonly RecordType[] {
  const column = columns.find(
    (candidate) =>
      (candidate.defaultSortOrder === "ascend" || candidate.defaultSortOrder === "descend") &&
      columnComparator(candidate) !== undefined,
  );
  if (column === undefined) return data;
  const compare = columnComparator(column);
  if (compare === undefined) return data;
  const order = column.defaultSortOrder === "descend" ? "descend" : "ascend";
  const sign = order === "descend" ? -1 : 1;
  return [...data].sort((a, b) => sign * compare(a, b, order));
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

  if (!compactLayout) {
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
  const flatColumns = flattenColumns<RecordType>(columns);
  const allColumns = flatColumns.filter(
    (column, index) => column.hidden !== true && !hidden.has(identifyColumn(column, index)),
  );
  // Without `compact.title` the first column that says something about the row
  // becomes the heading, and is then not repeated as a label/value row
  // underneath. An unlabelled actions column is skipped over: it is a control,
  // not a name.
  const titleColumn =
    compact?.title === undefined
      ? allColumns.find((column) => !isActionColumn(column))
      : undefined;
  const fieldColumns = allColumns.filter(
    (column) => column !== titleColumn && !isActionColumn(column),
  );
  const actionColumns = allColumns.filter(
    (column) => column !== titleColumn && isActionColumn(column),
  );

  /* Sorting, then paging — antd's order, and the reason the pager can be left
     alone: a server-paged list is sorted within the page it was sent, exactly
     as antd sorts it there. The sort reads every column, including one the
     cards hide, since hiding a column does not unsort the list. */
  const sorted = applyDefaultSort(data, flatColumns);

  /* A pager carrying a `total` is the server-side form used by most of these
     lists: the rows handed in are already the page. Anything else is sliced
     here, the way antd slices it itself. */
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

  /* The page, resolved once: antd hands rc-table only the rows of the current
     page, so the index a cell, `onRow`, `rowClassName` and `rowKey` are given
     is the row's place *within the page* — in the server-paged case and the
     client-sliced one alike. */
  const cardRows: CardRow<RecordType>[] = rows.map((record, position) => ({
    record,
    index: position,
    key: resolveRowKey(record, position, rowKey),
    checkboxProps: rowSelection?.getCheckboxProps?.(record),
  }));

  /* Selection. Controlled only: the keys handed back are the whole selection —
     keys from other pages included, which is what `preserveSelectedRowKeys`
     asks for — and the rows are the ones this `dataSource` can resolve. */
  const selectedKeys: readonly RowKey[] = rowSelection?.selectedRowKeys ?? [];
  const selectedLookup = new Set(selectedKeys.map(String));
  const keyOfRow = new Map<string, RecordType>(
    sorted.map((record, index) => [String(resolveRowKey(record, index, rowKey)), record]),
  );
  // The page's own keys win: with no `rowKey` a record's key is its position,
  // and the position within the page is the one the cards are drawn with.
  for (const row of cardRows) keyOfRow.set(String(row.key), row.record);

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
  const selectableRows = cardRows.filter((row) => row.checkboxProps?.disabled !== true);
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
              // it away on a phone would take select-all off Users, Roles and
              // Constants altogether.
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
                    Select all on this page
                  </span>
                </Checkbox>
              </div>
            )}

            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {cardRows.map(({ record, index, key, checkboxProps }) => {
                const rowProps = onRow?.(record, index);
                // Desktop opens a row with a double-click; a finger has no such
                // gesture, so on compact a single tap does what it did.
                const activate = rowProps?.onClick ?? rowProps?.onDoubleClick;
                const extraClass =
                  typeof rowClassName === "function"
                    ? rowClassName(record, index, 0)
                    : (rowClassName ?? "");

                const expanded = expandedKeys.some((candidate) => String(candidate) === String(key));
                const canExpand =
                  expandedRowRender !== undefined &&
                  (expandable?.rowExpandable?.(record) ?? true);

                // Rendered once, so an actions strip that came out empty — every
                // button behind a permission the operator lacks — takes its rule
                // with it instead of drawing a bare line under the card.
                const actions = actionColumns
                  .map((column, columnIndex) => ({
                    id: identifyColumn(column, columnIndex),
                    node: renderCell(column, record, index),
                  }))
                  .filter((action) => !isBlankNode(action.node));

                const heading =
                  compact?.title !== undefined
                    ? compact.title(record, index)
                    : titleColumn === undefined
                      ? null
                      : renderCell(titleColumn, record, index);

                const handleClick = (event: MouseEvent<HTMLDivElement>) => {
                  if (activate === undefined) return;
                  // A tap that landed on a control inside the card — an action
                  // button, the checkbox, a link — belongs to that control.
                  const target = event.target as HTMLElement | null;
                  const inner = target?.closest(
                    "button, a, input, select, textarea, [role='button']",
                  );
                  if (inner !== null && inner !== undefined && inner !== event.currentTarget) return;
                  activate(event);
                };

                return (
                  <li key={String(key)}>
                    {/* Not a `role="button"`: a widget role may not contain the
                        checkbox, the Details toggle and the action buttons this
                        card contains, and a screen reader would announce the
                        whole card as one control. The tap target stays — it is
                        what a finger expects — and the keyboard gets the "Open"
                        button in the header instead. */}
                    <div
                      className={`rounded-lg p-3 ${extraClass}`}
                      style={
                        activate === undefined ? cardStyle : { ...cardStyle, cursor: "pointer" }
                      }
                      onClick={activate === undefined ? undefined : handleClick}
                    >
                      <div className="flex items-start gap-2">
                        {rowSelection !== undefined && (
                          <Checkbox
                            {...checkboxProps}
                            className="mt-0.5 shrink-0"
                            checked={selectedLookup.has(String(key))}
                            onChange={(event) =>
                              toggleSelection(
                                record,
                                key,
                                event.target.checked,
                                event.nativeEvent,
                              )
                            }
                          />
                        )}

                        <div
                          id={`${idPrefix}h${index}`}
                          className="min-w-0 flex-1 text-sm font-semibold break-words"
                          style={{ color: surfaceColors.text }}
                        >
                          {heading}
                        </div>

                        {activate !== undefined && (
                          // What the desktop's double-click (or row click) does, as a
                          // control a keyboard can reach. Most lists also have an action
                          // button that opens the row; Customers does not, so there this
                          // is the only door. Named "Open <heading>" so a page of cards
                          // does not announce twenty-five identical links.
                          <Button
                            type="link"
                            size="small"
                            className="shrink-0"
                            id={`${idPrefix}o${index}`}
                            aria-labelledby={`${idPrefix}o${index} ${idPrefix}h${index}`}
                            onClick={(event) => activate(event)}
                          >
                            Open
                          </Button>
                        )}

                        {canExpand && (
                          <Button
                            type="link"
                            size="small"
                            className="shrink-0"
                            aria-expanded={expanded}
                            onClick={() => toggleExpansion(record, key, !expanded)}
                          >
                            {expanded ? "Hide details" : "Details"}
                          </Button>
                        )}
                      </div>

                      {fieldColumns.length > 0 && (
                        <dl className="m-0 mt-2 grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
                          {fieldColumns.map((column, columnIndex) => (
                            <Fragment key={identifyColumn(column, columnIndex)}>
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

                      {canExpand && expanded && (
                        <div
                          className="mt-2 pt-2"
                          style={{ borderTop: `1px solid ${surfaceColors.separator}` }}
                        >
                          {expandedRowRender(record, index, 0, true)}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Spin>

      {/* antd's own condition: a pager for as long as there is anything to
          page. Not `rows.length`, or an operator whose page came back empty —
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
