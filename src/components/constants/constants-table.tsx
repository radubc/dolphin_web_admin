"use client";

/**
 * The catalog table: one component, four column sets.
 *
 * Every kind wants the same chrome — tick boxes that arm the ribbon, a push
 * state at the right, the same row actions, the same sideways scroll — and
 * only the middle columns differ, so the shape is shared here and each kind
 * contributes its own columns inside a `switch` that keeps its row type.
 *
 * Row actions are hidden, not disabled, for an operator without
 * `can_write_catalogs`: a control they may never use is noise, and the page
 * gate already let them read.
 */

import { Button, Popconfirm, Space, Table, Tag, Tooltip } from "antd";
import type { ColumnType, ColumnsType } from "antd/es/table";
import { CloudUploadOutlined, DeleteOutlined, EditOutlined } from "@ant-design/icons";
import type {
  CategoryRow,
  ConstantKind,
  ConstantRow,
  CountryRow,
  CurrencyRow,
  FinancialInstitutionRow,
} from "@/lib/constants/types";
import { flowColors, surfaceColors } from "@/lib/theme/colors";
import {
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

/** Above this many rows the table paginates rather than scrolling forever. */
const PAGE_SIZE = 25;

export interface ConstantsTableProps {
  /** Already filtered by the store; the union keeps each branch's row type. */
  list: ConstantList;
  /** Every currency, for the country column. */
  currencies: readonly CurrencyRow[];
  /** Every category, unfiltered, so a child can still name a hidden parent. */
  categories: readonly CategoryRow[];
  canWrite: boolean;
  /** A push is in flight: ticking rows would change what it is pushing. */
  busy: boolean;
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
  // Categories are retired rather than deleted, and the push carries the
  // retirement over; the wording follows.
  const retires = kind === "categories";

  return {
    title: "",
    key: "actions",
    width: 132,
    align: "right",
    render: (_value, row) => {
      const label = labelOf(row);
      // A category that is already retired can be retired again without harm;
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
  selectedIds: readonly string[];
  onSelectionChange: (ids: string[]) => void;
  onOpen: (row: T) => void;
}

function KindTable<T extends ConstantRow>({
  rows,
  columns,
  width,
  labelOf,
  canWrite,
  busy,
  selectedIds,
  onSelectionChange,
  onOpen,
}: KindTableProps<T>) {
  return (
    <Table<T>
      dataSource={[...rows]}
      rowKey={(row) => row.id}
      columns={columns}
      size="middle"
      scroll={{ x: width }}
      // Retired rows stay in the list — they are still pushed — but they are
      // history, so they read at half weight.
      rowClassName={(row) => (isRetired(row) ? "opacity-55" : "")}
      pagination={
        rows.length > PAGE_SIZE
          ? { pageSize: PAGE_SIZE, showSizeChanger: true, size: "small", hideOnSinglePage: true }
          : false
      }
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

const byText = (a: string, b: string) => a.localeCompare(b);

export default function ConstantsTable({
  list,
  currencies,
  categories,
  canWrite,
  busy,
  selectedIds,
  onSelectionChange,
  onEdit,
  onPush,
  onDelete,
}: ConstantsTableProps) {
  const width = KIND_META[list.kind].tableWidth;
  const shared = { canWrite, busy, selectedIds, onSelectionChange, width };

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
          sorter: (a, b) => byText(labelOf(a), labelOf(b)),
          defaultSortOrder: "ascend",
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
        {
          title: "Retired",
          key: "retired",
          width: 110,
          render: (_value, row) => (row.deletedAt === null ? <Muted>—</Muted> : <RetiredTag />),
        },
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
  }
}
