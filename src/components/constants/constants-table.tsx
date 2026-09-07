"use client";

/**
 * The catalog table: one component, one column set per kind.
 *
 * Every kind wants the same chrome — tick boxes that arm the ribbon, a push
 * state at the right, the same row actions, the same sideways scroll — and
 * only the middle columns differ, so the shape is shared here and each kind
 * contributes its own columns inside a `switch` that keeps its row type.
 *
 * The table draws *one page* the server sent: `dataSource` is that page,
 * `pagination` is fully controlled, and every page or page-size change is
 * handed back to the store, which fetches the next one. Tick boxes use
 * `preserveSelectedRowKeys`, so a selection survives paging and a push can act
 * on rows that are no longer on screen. Search and the push-state filter are
 * the server's too; the two things still done in the browser are the column
 * sorters and the expand panels, and a sorter therefore only reorders the page
 * in view — not the catalog behind it.
 *
 * Row actions are hidden, not disabled, for an operator without
 * `can_write_catalogs`: a control they may never use is noise, and the page
 * gate already let them read.
 */

import { Button, Popconfirm, Space, Table, Tag, Tooltip } from "antd";
import type { ColumnType, ColumnsType } from "antd/es/table";
import {
  CheckOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  EditOutlined,
} from "@ant-design/icons";
import type {
  AccountBaseTypeRow,
  AccountTypeRow,
  CategoryRow,
  ConstantKind,
  ConstantRow,
  CountryRow,
  CryptocurrencyRow,
  CurrencyRow,
  EtfRow,
  FinancialInstitutionRow,
  MarketRow,
  StockRow,
} from "@/lib/constants/types";
import { flowColors, surfaceColors } from "@/lib/theme/colors";
import {
  baseTypeLabel,
  categoryDepth,
  currencyLabel,
  isCategoryType,
  isRetired,
  KIND_META,
  PushStateTag,
  RetiredTag,
} from "./constants-meta";
import type { ConstantFormTarget } from "./constant-form-drawer";
import type { ConstantList } from "./use-constants-store";
import { PAGE_SIZE_OPTIONS } from "./use-constants-store";

export interface ConstantsTableProps {
  /** One page from the server; the union keeps each branch's row type. */
  list: ConstantList;
  /** Every currency, for the country column. */
  currencies: readonly CurrencyRow[];
  /** Every account base type, for the account-type column. */
  baseTypes: readonly AccountBaseTypeRow[];
  /** Every category, unfiltered, so a child can still name a hidden parent. */
  categories: readonly CategoryRow[];
  canWrite: boolean;
  /** A push is in flight: ticking rows would change what it is pushing. */
  busy: boolean;
  /** A page fetch is in flight; the table dims rather than emptying. */
  loading: boolean;
  /** 1-based, from the store: the table draws the page, it does not slice it. */
  page: number;
  pageSize: number;
  /** Rows the query matches, all pages — the pager's denominator. */
  total: number;
  onPagingChange: (page: number, pageSize: number) => void;
  /** Kept across pages (`preserveSelectedRowKeys`), so a selection can span them. */
  selectedIds: readonly string[];
  onSelectionChange: (ids: string[]) => void;
  onEdit: (target: ConstantFormTarget) => void;
  onPush: (row: ConstantRow, label: string) => void;
  onDelete: (row: ConstantRow, label: string) => void;
}

/* -------------------------------------------------------------------------- */
/* Shared columns                                                             */
/* -------------------------------------------------------------------------- */

function stateColumn<T extends ConstantRow>(): ColumnType<T> {
  return {
    title: "State",
    key: "state",
    width: 130,
    render: (_value, row) => <PushStateTag state={row.pushState} />,
  };
}

interface ActionsOptions<T extends ConstantRow> {
  kind: ConstantKind;
  busy: boolean;
  labelOf: (row: T) => string;
  onEdit: (row: T) => void;
  onPush: (row: ConstantRow, label: string) => void;
  onDelete: (row: ConstantRow, label: string) => void;
}

function actionsColumn<T extends ConstantRow>({
  kind,
  busy,
  labelOf,
  onEdit,
  onPush,
  onDelete,
}: ActionsOptions<T>): ColumnType<T> {
  // Some kinds are retired rather than deleted, and the push carries the
  // retirement over; the wording follows what the kind's meta declares.
  const retires = KIND_META[kind].retires;

  return {
    title: "",
    key: "actions",
    width: 132,
    align: "right",
    render: (_value, row) => {
      const label = labelOf(row);
      // A row that is already retired can be retired again without harm;
      // the confirmation says so rather than the button refusing.
      const alreadyRetired = retires && isRetired(row);
      return (
        <Space size={0}>
          <Tooltip title={`Edit ${label}`}>
            <Button
              type="text"
              size="small"
              aria-label={`Edit ${label}`}
              icon={<EditOutlined />}
              disabled={busy}
              onClick={() => onEdit(row)}
            />
          </Tooltip>

          <Popconfirm
            title="Push to the main app"
            description={`Upsert ${label} into the main app database. Nothing is deleted there.`}
            okText="Push"
            cancelText="Cancel"
            disabled={busy}
            onConfirm={() => onPush(row, label)}
          >
            <Tooltip title={`Push ${label} to the main app`}>
              <Button
                type="text"
                size="small"
                aria-label={`Push ${label}`}
                icon={<CloudUploadOutlined />}
                disabled={busy}
              />
            </Tooltip>
          </Popconfirm>

          <Popconfirm
            title={
              alreadyRetired
                ? `${label} is already retired`
                : retires
                  ? `Retire ${label}?`
                  : `Delete ${label}?`
            }
            description={
              alreadyRetired
                ? "Retiring it again changes nothing but the timestamp."
                : retires
                  ? "It stays in the catalog, marked retired, and the next push carries that over."
                  : "It is removed from the admin catalog. The main app keeps its copy until someone removes it there."
            }
            okText={retires ? "Retire" : "Delete"}
            okButtonProps={{ danger: true }}
            cancelText="Cancel"
            disabled={busy}
            onConfirm={() => onDelete(row, label)}
          >
            <Tooltip title={retires ? `Retire ${label}` : `Delete ${label}`}>
              <Button
                type="text"
                size="small"
                danger
                aria-label={retires ? `Retire ${label}` : `Delete ${label}`}
                icon={<DeleteOutlined />}
                disabled={busy}
              />
            </Tooltip>
          </Popconfirm>
        </Space>
      );
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The table itself                                                           */
/* -------------------------------------------------------------------------- */

interface KindTableProps<T extends ConstantRow> {
  rows: readonly T[];
  columns: ColumnsType<T>;
  width: number;
  labelOf: (row: T) => string;
  canWrite: boolean;
  busy: boolean;
  loading: boolean;
  page: number;
  pageSize: number;
  total: number;
  onPagingChange: (page: number, pageSize: number) => void;
  selectedIds: readonly string[];
  onSelectionChange: (ids: string[]) => void;
  onOpen: (row: T) => void;
  /**
   * The panel an expanded row shows. Only the kinds with more fields than a
   * readable row can hold (ETFs, stocks) pass one; without it the table has no
   * expand column at all.
   */
  expandedRowRender?: (row: T) => React.ReactNode;
}

function KindTable<T extends ConstantRow>({
  rows,
  columns,
  width,
  labelOf,
  canWrite,
  busy,
  loading,
  page,
  pageSize,
  total,
  onPagingChange,
  selectedIds,
  onSelectionChange,
  onOpen,
  expandedRowRender,
}: KindTableProps<T>) {
  return (
    <Table<T>
      dataSource={[...rows]}
      rowKey={(row) => row.id}
      columns={columns}
      size="middle"
      scroll={{ x: width }}
      loading={loading}
      // Retired rows stay in the list — they are still pushed — but they are
      // history, so they read at half weight.
      rowClassName={(row) => (isRetired(row) ? "opacity-55" : "")}
      // Controlled: `rows` is the page the server sent and `total` is the whole
      // result, so antd draws the pager without slicing anything itself. Every
      // change goes back to the store, which fetches the next page.
      pagination={{
        current: page,
        pageSize,
        total,
        showSizeChanger: true,
        pageSizeOptions: [...PAGE_SIZE_OPTIONS],
        size: "small",
        onChange: onPagingChange,
        showTotal: (count, range) =>
          `${range[0].toLocaleString()}–${range[1].toLocaleString()} of ${count.toLocaleString()}`,
      }}
      expandable={expandedRowRender === undefined ? undefined : { expandedRowRender }}
      rowSelection={{
        selectedRowKeys: [...selectedIds],
        preserveSelectedRowKeys: true,
        onChange: (keys) => onSelectionChange(keys.map(String)),
        getCheckboxProps: (row) => ({ disabled: busy, "aria-label": `Select ${labelOf(row)}` }),
      }}
      onRow={(row) => ({
        onDoubleClick: () => {
          if (canWrite && !busy) onOpen(row);
        },
      })}
    />
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span style={{ color: surfaceColors.textSecondary }}>{children}</span>;
}

/**
 * One boolean of an account type. A tick reads faster than "Yes" across three
 * adjacent columns, and the em dash keeps an unset column from looking empty.
 */
function FlagCell({ on, label }: { on: boolean; label: string }) {
  return on ? (
    <Tooltip title={label}>
      <CheckOutlined aria-label={label} style={{ color: flowColors.inflow }} />
    </Tooltip>
  ) : (
    <Muted>—</Muted>
  );
}

/** The Retired column both retiring kinds show. */
function retiredColumn<T extends ConstantRow & { deletedAt: string | null }>(): ColumnType<T> {
  return {
    title: "Retired",
    key: "retired",
    width: 110,
    render: (_value, row) => (row.deletedAt === null ? <Muted>—</Muted> : <RetiredTag />),
  };
}

/**
 * One cell of free text that can run long — a crypto pair's exchange list — kept
 * to its column and readable in full on hover.
 */
function Truncated({ text, width }: { text: string; width: number }) {
  if (text.trim() === "") return <Muted>—</Muted>;
  return (
    <Tooltip title={text}>
      <span
        className="block truncate"
        style={{ color: surfaceColors.textSecondary, maxWidth: width }}
      >
        {text}
      </span>
    </Tooltip>
  );
}

/**
 * The columns an ETF and a stock share. Both rows carry the same fields — a
 * stock only adds `type` — so the middle of the table is written once and each
 * kind appends what is its own.
 */
function instrumentColumns<T extends EtfRow>(): ColumnsType<T> {
  return [
    {
      title: "Symbol",
      dataIndex: "symbol",
      width: 130,
      // No default order: the server lists these two kinds preferred markets
      // first (Canada, then United States, then the rest), and a default
      // client sort by symbol would undo that on every page. The sorter is
      // still there for an operator who wants the page by symbol.
      sorter: (a, b) => byText(a.symbol, b.symbol),
      render: (value: string) => <code style={{ fontWeight: 600 }}>{value}</code>,
    },
    {
      title: "Name",
      dataIndex: "name",
      sorter: (a, b) => byText(a.name, b.name),
      render: (value: string) => <span style={{ color: surfaceColors.text }}>{value}</span>,
    },
    {
      title: "Exchange",
      key: "exchange",
      width: 190,
      sorter: (a, b) => byText(a.exchange, b.exchange),
      render: (_value, row) => (
        <span className="flex flex-col leading-tight">
          <span style={{ color: surfaceColors.text }}>{row.exchange}</span>
          {/* The MIC is what the market catalog keys on, so it stays in sight
              next to the exchange it names. */}
          <code className="text-xs" style={{ color: surfaceColors.textTertiary }}>
            {row.micCode === "" ? "—" : row.micCode}
          </code>
        </span>
      ),
    },
    {
      title: "Currency",
      dataIndex: "currency",
      width: 110,
      render: (value: string) => (value === "" ? <Muted>—</Muted> : <code>{value}</code>),
    },
    {
      title: "Country",
      dataIndex: "country",
      width: 170,
      render: (value: string) => <Muted>{value === "" ? "—" : value}</Muted>,
    },
  ];
}

/**
 * The four identifiers an ETF or a stock carries. They are reference numbers
 * nobody scans a table for, so they live in the expanded row and leave the
 * columns to what an operator reads.
 */
function IdentifierPanel({ row }: { row: EtfRow }) {
  const identifiers: Array<[string, string]> = [
    ["FIGI", row.figiCode],
    ["CFI", row.cfiCode],
    ["ISIN", row.isin],
    ["CUSIP", row.cusip],
  ];
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-1 py-1 text-sm">
      {identifiers.map(([label, value]) => (
        <span key={label} className="flex items-center gap-2">
          <span className="text-xs" style={{ color: surfaceColors.textTertiary }}>
            {label}
          </span>
          {value.trim() === "" ? (
            <Muted>—</Muted>
          ) : (
            <code style={{ color: surfaceColors.textSecondary }}>{value}</code>
          )}
        </span>
      ))}
    </div>
  );
}

const byText = (a: string, b: string) => a.localeCompare(b);

export default function ConstantsTable({
  list,
  currencies,
  baseTypes,
  categories,
  canWrite,
  busy,
  loading,
  page,
  pageSize,
  total,
  onPagingChange,
  selectedIds,
  onSelectionChange,
  onEdit,
  onPush,
  onDelete,
}: ConstantsTableProps) {
  const width = KIND_META[list.kind].tableWidth;
  const shared = {
    canWrite,
    busy,
    loading,
    page,
    pageSize,
    total,
    onPagingChange,
    selectedIds,
    onSelectionChange,
    width,
  };

  switch (list.kind) {
    case "countries": {
      const labelOf = (row: CountryRow) => row.name;
      const open = (row: CountryRow) => onEdit({ kind: "countries", row });
      const columns: ColumnsType<CountryRow> = [
        {
          title: "Name",
          dataIndex: "name",
          sorter: (a, b) => byText(a.name, b.name),
          defaultSortOrder: "ascend",
          render: (value: string) => <span style={{ color: surfaceColors.text }}>{value}</span>,
        },
        {
          title: "Alpha-2",
          dataIndex: "alpha2Code",
          width: 100,
          render: (value: string) => <code>{value}</code>,
        },
        {
          title: "Alpha-3",
          dataIndex: "alpha3Code",
          width: 100,
          render: (value: string) => <code>{value}</code>,
        },
        {
          title: "Currency",
          key: "currency",
          width: 230,
          render: (_value, row) => <Muted>{currencyLabel(row.currencyId, currencies)}</Muted>,
        },
        stateColumn<CountryRow>(),
        ...(canWrite
          ? [
              actionsColumn<CountryRow>({
                kind: "countries",
                busy,
                labelOf,
                onEdit: open,
                onPush,
                onDelete,
              }),
            ]
          : []),
      ];
      return (
        <KindTable<CountryRow>
          {...shared}
          rows={list.rows}
          columns={columns}
          labelOf={labelOf}
          onOpen={open}
        />
      );
    }

    case "currencies": {
      const labelOf = (row: CurrencyRow) => `${row.code} · ${row.name}`;
      const open = (row: CurrencyRow) => onEdit({ kind: "currencies", row });
      const columns: ColumnsType<CurrencyRow> = [
        {
          title: "Code",
          dataIndex: "code",
          width: 110,
          sorter: (a, b) => byText(a.code, b.code),
          defaultSortOrder: "ascend",
          render: (value: string) => <code style={{ fontWeight: 600 }}>{value}</code>,
        },
        {
          title: "Name",
          dataIndex: "name",
          sorter: (a, b) => byText(a.name, b.name),
          render: (value: string) => <span style={{ color: surfaceColors.text }}>{value}</span>,
        },
        {
          title: "Symbol",
          dataIndex: "symbol",
          width: 110,
          render: (value: string | null) => <Muted>{value ?? "—"}</Muted>,
        },
        stateColumn<CurrencyRow>(),
        ...(canWrite
          ? [
              actionsColumn<CurrencyRow>({
                kind: "currencies",
                busy,
                labelOf,
                onEdit: open,
                onPush,
                onDelete,
              }),
            ]
          : []),
      ];
      return (
        <KindTable<CurrencyRow>
          {...shared}
          rows={list.rows}
          columns={columns}
          labelOf={labelOf}
          onOpen={open}
        />
      );
    }

    case "financial_institutions": {
      const labelOf = (row: FinancialInstitutionRow) => row.name;
      const open = (row: FinancialInstitutionRow) =>
        onEdit({ kind: "financial_institutions", row });
      const columns: ColumnsType<FinancialInstitutionRow> = [
        {
          title: "Name",
          dataIndex: "name",
          sorter: (a, b) => byText(a.name, b.name),
          defaultSortOrder: "ascend",
          render: (value: string) => <span style={{ color: surfaceColors.text }}>{value}</span>,
        },
        {
          title: "Institution #",
          dataIndex: "institutionNumber",
          width: 150,
          sorter: (a, b) => byText(a.institutionNumber, b.institutionNumber),
          render: (value: string) => <code className="tabular-nums">{value}</code>,
        },
        {
          title: "Type",
          dataIndex: "type",
          width: 170,
          render: (value: string) => <Tag style={{ marginInlineEnd: 0 }}>{value}</Tag>,
        },
        stateColumn<FinancialInstitutionRow>(),
        ...(canWrite
          ? [
              actionsColumn<FinancialInstitutionRow>({
                kind: "financial_institutions",
                busy,
                labelOf,
                onEdit: open,
                onPush,
                onDelete,
              }),
            ]
          : []),
      ];
      return (
        <KindTable<FinancialInstitutionRow>
          {...shared}
          rows={list.rows}
          columns={columns}
          labelOf={labelOf}
          onOpen={open}
        />
      );
    }

    case "categories": {
      const parentName = (row: CategoryRow) =>
        categories.find((candidate) => candidate.id === row.parentId)?.name ?? null;
      const labelOf = (row: CategoryRow) => {
        const parent = parentName(row);
        return parent === null ? row.name : `${parent} › ${row.name}`;
      };
      const open = (row: CategoryRow) => onEdit({ kind: "categories", row });
      const columns: ColumnsType<CategoryRow> = [
        {
          title: "Name",
          key: "name",
          // No default order: this sorter reorders the *page* by the
          // `Parent › Child` path in the browser, while the server pages the
          // catalog by name, so defaulting it to ascend would disagree with
          // the server's own order at every page boundary. The sorter still
          // works on demand; it just is not the page's resting state.
          sorter: (a, b) => byText(labelOf(a), labelOf(b)),
          render: (_value, row) => {
            const parent = parentName(row);
            return (
              <span
                className="flex items-center gap-1"
                style={{ paddingInlineStart: categoryDepth(row, categories) * 14 }}
              >
                {parent !== null && (
                  <span style={{ color: surfaceColors.textTertiary }}>{parent} ›</span>
                )}
                <span style={{ color: surfaceColors.text }}>{row.name}</span>
              </span>
            );
          },
        },
        {
          title: "Type",
          dataIndex: "type",
          width: 120,
          render: (value: CategoryRow["type"]) => {
            if (value === null) return <Muted>—</Muted>;
            if (isCategoryType(value)) {
              return (
                <Tag
                  style={{ marginInlineEnd: 0 }}
                  color={value === "Inflow" ? flowColors.inflow : flowColors.outflow}
                >
                  {value}
                </Tag>
              );
            }
            // Free text on both databases: an unexpected spelling is carried
            // through verbatim rather than forced into an inflow/outflow color.
            return (
              <Tooltip title="Not one of the types the form offers; kept as stored.">
                <Tag style={{ marginInlineEnd: 0 }}>{value}</Tag>
              </Tooltip>
            );
          },
        },
        {
          title: "Discretionary",
          dataIndex: "isDiscretionary",
          width: 140,
          render: (value: boolean | null) => (
            <Muted>{value === null ? "—" : value ? "Yes" : "No"}</Muted>
          ),
        },
        retiredColumn<CategoryRow>(),
        stateColumn<CategoryRow>(),
        ...(canWrite
          ? [
              actionsColumn<CategoryRow>({
                kind: "categories",
                busy,
                labelOf,
                onEdit: open,
                onPush,
                onDelete,
              }),
            ]
          : []),
      ];
      return (
        <KindTable<CategoryRow>
          {...shared}
          rows={list.rows}
          columns={columns}
          labelOf={labelOf}
          onOpen={open}
        />
      );
    }

    case "account_base_types": {
      const labelOf = (row: AccountBaseTypeRow) => row.name;
      const open = (row: AccountBaseTypeRow) => onEdit({ kind: "account_base_types", row });
      const columns: ColumnsType<AccountBaseTypeRow> = [
        {
          title: "Name",
          dataIndex: "name",
          sorter: (a, b) => byText(a.name, b.name),
          defaultSortOrder: "ascend",
          render: (value: string) => <span style={{ color: surfaceColors.text }}>{value}</span>,
        },
        stateColumn<AccountBaseTypeRow>(),
        ...(canWrite
          ? [
              actionsColumn<AccountBaseTypeRow>({
                kind: "account_base_types",
                busy,
                labelOf,
                onEdit: open,
                onPush,
                onDelete,
              }),
            ]
          : []),
      ];
      return (
        <KindTable<AccountBaseTypeRow>
          {...shared}
          rows={list.rows}
          columns={columns}
          labelOf={labelOf}
          onOpen={open}
        />
      );
    }

    case "account_types": {
      const labelOf = (row: AccountTypeRow) => row.displayName;
      const open = (row: AccountTypeRow) => onEdit({ kind: "account_types", row });
      const columns: ColumnsType<AccountTypeRow> = [
        {
          title: "Display name",
          key: "displayName",
          sorter: (a, b) => byText(a.displayName, b.displayName),
          defaultSortOrder: "ascend",
          render: (_value, row) => (
            <span className="flex flex-col leading-tight">
              <span style={{ color: surfaceColors.text }}>{row.displayName}</span>
              {/* The machine name is what the main app stores and matches on,
                  so it stays visible even when it reads the same. */}
              <code className="text-xs" style={{ color: surfaceColors.textTertiary }}>
                {row.name}
              </code>
            </span>
          ),
        },
        {
          title: "Base type",
          key: "baseType",
          width: 200,
          sorter: (a, b) =>
            byText(baseTypeLabel(a.baseTypeId, baseTypes), baseTypeLabel(b.baseTypeId, baseTypes)),
          render: (_value, row) => <Muted>{baseTypeLabel(row.baseTypeId, baseTypes)}</Muted>,
        },
        {
          title: "Asset",
          dataIndex: "isAsset",
          width: 90,
          render: (value: boolean) => <FlagCell on={value} label="Counts as an asset" />,
        },
        {
          title: "Banking",
          dataIndex: "isBanking",
          width: 100,
          render: (value: boolean) => <FlagCell on={value} label="A banking account" />,
        },
        {
          title: "Investment",
          dataIndex: "isInvestment",
          width: 120,
          render: (value: boolean) => <FlagCell on={value} label="An investment account" />,
        },
        retiredColumn<AccountTypeRow>(),
        stateColumn<AccountTypeRow>(),
        ...(canWrite
          ? [
              actionsColumn<AccountTypeRow>({
                kind: "account_types",
                busy,
                labelOf,
                onEdit: open,
                onPush,
                onDelete,
              }),
            ]
          : []),
      ];
      return (
        <KindTable<AccountTypeRow>
          {...shared}
          rows={list.rows}
          columns={columns}
          labelOf={labelOf}
          onOpen={open}
        />
      );
    }

    case "cryptocurrencies": {
      const labelOf = (row: CryptocurrencyRow) => row.symbol;
      const open = (row: CryptocurrencyRow) => onEdit({ kind: "cryptocurrencies", row });
      const columns: ColumnsType<CryptocurrencyRow> = [
        {
          title: "Symbol",
          dataIndex: "symbol",
          width: 160,
          sorter: (a, b) => byText(a.symbol, b.symbol),
          defaultSortOrder: "ascend",
          render: (value: string) => <code style={{ fontWeight: 600 }}>{value}</code>,
        },
        {
          title: "Base",
          dataIndex: "currencyBase",
          width: 150,
          sorter: (a, b) => byText(a.currencyBase, b.currencyBase),
          render: (value: string) => (
            <span style={{ color: surfaceColors.text }}>{value === "" ? "—" : value}</span>
          ),
        },
        {
          title: "Quote",
          dataIndex: "currencyQuote",
          width: 150,
          sorter: (a, b) => byText(a.currencyQuote, b.currencyQuote),
          render: (value: string) => (
            <span style={{ color: surfaceColors.text }}>{value === "" ? "—" : value}</span>
          ),
        },
        {
          title: "Exchanges",
          dataIndex: "availableExchanges",
          // Free text from the feed: often a long comma-separated list, so the
          // column shows what fits and the tooltip carries the rest.
          render: (value: string) => <Truncated text={value} width={300} />,
        },
        stateColumn<CryptocurrencyRow>(),
        ...(canWrite
          ? [
              actionsColumn<CryptocurrencyRow>({
                kind: "cryptocurrencies",
                busy,
                labelOf,
                onEdit: open,
                onPush,
                onDelete,
              }),
            ]
          : []),
      ];
      return (
        <KindTable<CryptocurrencyRow>
          {...shared}
          rows={list.rows}
          columns={columns}
          labelOf={labelOf}
          onOpen={open}
        />
      );
    }

    case "etfs": {
      const labelOf = (row: EtfRow) => `${row.symbol} · ${row.name}`;
      const open = (row: EtfRow) => onEdit({ kind: "etfs", row });
      const columns: ColumnsType<EtfRow> = [
        ...instrumentColumns<EtfRow>(),
        stateColumn<EtfRow>(),
        ...(canWrite
          ? [
              actionsColumn<EtfRow>({
                kind: "etfs",
                busy,
                labelOf,
                onEdit: open,
                onPush,
                onDelete,
              }),
            ]
          : []),
      ];
      return (
        <KindTable<EtfRow>
          {...shared}
          rows={list.rows}
          columns={columns}
          labelOf={labelOf}
          onOpen={open}
          expandedRowRender={(row) => <IdentifierPanel row={row} />}
        />
      );
    }

    case "stocks": {
      const labelOf = (row: StockRow) => `${row.symbol} · ${row.name}`;
      const open = (row: StockRow) => onEdit({ kind: "stocks", row });
      const columns: ColumnsType<StockRow> = [
        ...instrumentColumns<StockRow>(),
        {
          title: "Type",
          dataIndex: "type",
          width: 180,
          sorter: (a, b) => byText(a.type, b.type),
          render: (value: string) =>
            value === "" ? <Muted>—</Muted> : <Tag style={{ marginInlineEnd: 0 }}>{value}</Tag>,
        },
        stateColumn<StockRow>(),
        ...(canWrite
          ? [
              actionsColumn<StockRow>({
                kind: "stocks",
                busy,
                labelOf,
                onEdit: open,
                onPush,
                onDelete,
              }),
            ]
          : []),
      ];
      return (
        <KindTable<StockRow>
          {...shared}
          rows={list.rows}
          columns={columns}
          labelOf={labelOf}
          onOpen={open}
          expandedRowRender={(row) => <IdentifierPanel row={row} />}
        />
      );
    }

    case "markets": {
      const labelOf = (row: MarketRow) => `${row.micCode} · ${row.marketName}`;
      const open = (row: MarketRow) => onEdit({ kind: "markets", row });
      const columns: ColumnsType<MarketRow> = [
        {
          title: "MIC",
          dataIndex: "micCode",
          width: 110,
          sorter: (a, b) => byText(a.micCode, b.micCode),
          defaultSortOrder: "ascend",
          render: (value: string) => <code style={{ fontWeight: 600 }}>{value}</code>,
        },
        {
          title: "Name",
          dataIndex: "marketName",
          sorter: (a, b) => byText(a.marketName, b.marketName),
          render: (value: string) => <span style={{ color: surfaceColors.text }}>{value}</span>,
        },
        {
          title: "Operating MIC",
          dataIndex: "operatingMic",
          width: 150,
          sorter: (a, b) => byText(a.operatingMic, b.operatingMic),
          // The venue a segment operates under; equal to the MIC for an
          // operating market itself, which is worth seeing rather than hiding.
          render: (value: string) => (value === "" ? <Muted>—</Muted> : <code>{value}</code>),
        },
        {
          title: "Country",
          dataIndex: "isoCountryCode",
          width: 110,
          render: (value: string) => (value === "" ? <Muted>—</Muted> : <code>{value}</code>),
        },
        {
          title: "City",
          dataIndex: "city",
          width: 170,
          render: (value: string) => <Muted>{value === "" ? "—" : value}</Muted>,
        },
        retiredColumn<MarketRow>(),
        stateColumn<MarketRow>(),
        ...(canWrite
          ? [
              actionsColumn<MarketRow>({
                kind: "markets",
                busy,
                labelOf,
                onEdit: open,
                onPush,
                onDelete,
              }),
            ]
          : []),
      ];
      return (
        <KindTable<MarketRow>
          {...shared}
          rows={list.rows}
          columns={columns}
          labelOf={labelOf}
          onOpen={open}
        />
      );
    }
  }
}
