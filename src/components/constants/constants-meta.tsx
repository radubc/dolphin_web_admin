"use client";

/**
 * Small shared pieces of the Constants screen: the page colour, the ten kinds
 * as the switcher shows them, the push-state tag, and the label helpers
 * (a currency read as `CAD · Canadian dollar`, a category read as
 * `Parent › Child`, an account base type read by name) that the table and the
 * drawer must say the same way.
 */

import { Tag, Tooltip } from "antd";
import {
  ApartmentOutlined,
  AppstoreOutlined,
  BankOutlined,
  DollarOutlined,
  FundOutlined,
  GlobalOutlined,
  ShopOutlined,
  StockOutlined,
  TransactionOutlined,
  WalletOutlined,
} from "@ant-design/icons";
import type {
  AccountBaseTypeRow,
  CategoryRow,
  CategoryType,
  ConstantKind,
  ConstantRow,
  CurrencyRow,
  PushState,
} from "@/lib/constants/types";
import { CATEGORY_TYPES, MAIN_TABLE_OF } from "@/lib/constants/types";
import { featureColors } from "@/lib/theme/colors";

/** The Constants tab's colour on the rail (purple), as `shell/definitions.ts` sets it. */
export const CONSTANTS_COLOR = featureColors.constants;

/* -------------------------------------------------------------------------- */
/* Kinds                                                                      */
/* -------------------------------------------------------------------------- */

export interface KindMeta {
  /** The switcher's label. */
  label: string;
  /** "country", for sentences about one row. */
  singular: string;
  /** "countries", for counts and empty states. */
  plural: string;
  icon: React.ReactNode;
  /**
   * The noun the ribbon's Add button uses. Usually the singular, shortened
   * where the full one would not fit the bar ("institution", "base type").
   */
  addLabel: string;
  /** What the catalog is for, shown in the empty state. */
  blurb: string;
  /** The toolbar's search box, naming the fields the search actually covers. */
  searchPlaceholder: string;
  /**
   * Whether a row of this kind is retired (soft-deleted) rather than removed.
   * Drives the Retired figure, filter, column and the delete wording, so the
   * table, the toolbar and the page all say the same thing about one kind.
   */
  retires: boolean;
  /** The sum of the table's column widths; below it the table scrolls sideways. */
  tableWidth: number;
}

export const KIND_META: Readonly<Record<ConstantKind, KindMeta>> = {
  countries: {
    label: "Countries",
    singular: "country",
    plural: "countries",
    icon: <GlobalOutlined />,
    addLabel: "country",
    blurb:
      "Countries the app offers when a user sets up their profile, each with its ISO codes and default currency.",
    searchPlaceholder: "Search name, ISO codes, currency code or name…",
    retires: false,
    tableWidth: 900,
  },
  currencies: {
    label: "Currencies",
    singular: "currency",
    plural: "currencies",
    icon: <DollarOutlined />,
    addLabel: "currency",
    blurb: "Currencies accounts and transactions can be denominated in.",
    searchPlaceholder: "Search code, name or symbol…",
    retires: false,
    tableWidth: 800,
  },
  financial_institutions: {
    label: "Financial institutions",
    singular: "financial institution",
    plural: "financial institutions",
    icon: <BankOutlined />,
    addLabel: "institution",
    blurb: "Banks and credit unions users pick when they add an account.",
    searchPlaceholder: "Search name, number or type…",
    retires: false,
    tableWidth: 860,
  },
  categories: {
    label: "Categories",
    singular: "category",
    plural: "categories",
    icon: <ApartmentOutlined />,
    addLabel: "category",
    blurb:
      "The default category tree every new tenant starts from: inflow and outflow, parents and children.",
    searchPlaceholder: "Search name, type or parent name…",
    retires: true,
    tableWidth: 1040,
  },
  account_base_types: {
    label: "Account base types",
    singular: "account base type",
    plural: "account base types",
    icon: <AppstoreOutlined />,
    addLabel: "base type",
    blurb:
      "The handful of groupings account types belong to — Assets, Banking, Investment and Retirement, Loans.",
    searchPlaceholder: "Search base type name…",
    retires: false,
    tableWidth: 640,
  },
  account_types: {
    label: "Account types",
    singular: "account type",
    plural: "account types",
    icon: <WalletOutlined />,
    addLabel: "account type",
    blurb:
      "The kinds of account a user can open — chequing, savings, credit card, mortgage — each in a base type and flagged as asset, banking or investment.",
    searchPlaceholder: "Search name, display name or base type…",
    retires: true,
    tableWidth: 1180,
  },
  cryptocurrencies: {
    label: "Cryptocurrencies",
    singular: "cryptocurrency",
    plural: "cryptocurrencies",
    icon: <TransactionOutlined />,
    addLabel: "cryptocurrency",
    blurb:
      `Tradable crypto pairs as the market-data feed describes them — symbol, base and quote currency, and the exchanges that list them. A push writes them into the main app's ${MAIN_TABLE_OF.cryptocurrencies} table.`,
    searchPlaceholder: "Search symbol, base, quote or exchanges…",
    retires: false,
    tableWidth: 1040,
  },
  etfs: {
    label: "ETFs",
    singular: "ETF",
    plural: "ETFs",
    icon: <FundOutlined />,
    addLabel: "ETF",
    blurb:
      `Listed exchange-traded funds, one row per symbol and exchange, with their identifiers. A push writes them into the main app's ${MAIN_TABLE_OF.etfs} table.`,
    searchPlaceholder: "Search symbol, name, exchange, MIC or country…",
    retires: false,
    tableWidth: 1300,
  },
  stocks: {
    label: "Stocks",
    singular: "stock",
    plural: "stocks",
    icon: <StockOutlined />,
    addLabel: "stock",
    blurb:
      `Listed equities, one row per symbol and exchange, with their instrument type and identifiers. A push writes them into the main app's ${MAIN_TABLE_OF.stocks} table.`,
    searchPlaceholder: "Search symbol, name, exchange, MIC, country or type…",
    retires: false,
    tableWidth: 1460,
  },
  markets: {
    label: "Markets",
    singular: "market",
    plural: "markets",
    icon: <ShopOutlined />,
    addLabel: "market",
    blurb:
      "Exchanges and market segments by ISO 10383 MIC — the venues the ETF and stock catalogs point at, each with its operating MIC, country and city.",
    searchPlaceholder: "Search MIC, operating MIC, name, country or city…",
    retires: true,
    tableWidth: 1220,
  },
};

/**
 * `1 stock` / `300,000 stocks`. The catalogs are big enough that a bare digit
 * string is unreadable, so every count an operator is asked to act on carries
 * its thousands separators.
 */
export function countOfKind(count: number, kind: ConstantKind): string {
  const meta = KIND_META[kind];
  return `${count.toLocaleString()} ${count === 1 ? meta.singular : meta.plural}`;
}

/** The same for rows of no particular kind: `1 row` / `12,345 rows`. */
export function countOfRows(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "row" : "rows"}`;
}

/* -------------------------------------------------------------------------- */
/* Push state                                                                 */
/* -------------------------------------------------------------------------- */

export interface PushStateMeta {
  label: string;
  /** antd `Tag` preset. */
  tagColor: string;
  /** Hex, for the rail card's dots and bars. */
  color: string;
  tooltip: string;
}

export const PUSH_STATE_META: Readonly<Record<PushState, PushStateMeta>> = {
  new: {
    label: "Not pushed",
    tagColor: "blue",
    color: featureColors.banking,
    tooltip: "No row with this id in the main app database yet.",
  },
  changed: {
    label: "Changed",
    tagColor: "orange",
    color: featureColors.incomeBills,
    tooltip: "The main app has this row, but at least one pushed field differs.",
  },
  synced: {
    label: "In sync",
    tagColor: "green",
    color: featureColors.loan,
    tooltip: "The main app's row is identical to this one.",
  },
  // A catalog of hundreds of thousands of rows is not re-compared on every
  // read: a row that no compare job has reached yet says so plainly rather
  // than claiming a state the ledger does not have.
  unknown: {
    label: "Not compared",
    tagColor: "default",
    color: featureColors.neutral,
    tooltip: "This row has never been compared with the main app. Run Compare to find out.",
  },
};

/** Grey, for a retired row of a kind that retires rather than deletes. */
export const RETIRED_COLOR = featureColors.neutral;

export function PushStateTag({ state }: { state: PushState }) {
  const meta = PUSH_STATE_META[state];
  return (
    <Tooltip title={meta.tooltip}>
      <Tag color={meta.tagColor} style={{ marginInlineEnd: 0 }}>
        {meta.label}
      </Tag>
    </Tooltip>
  );
}

export function RetiredTag() {
  return (
    <Tooltip title="Retired in the admin catalog. A push carries the retirement to the main app; nothing is deleted there.">
      <Tag style={{ marginInlineEnd: 0, color: RETIRED_COLOR }}>Retired</Tag>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                     */
/* -------------------------------------------------------------------------- */

/** Whether a row carries a retirement stamp. Only categories, account types and markets ever do. */
export function isRetired(row: ConstantRow): boolean {
  return "deletedAt" in row && row.deletedAt !== null;
}

/**
 * Whether a category's stored `type` is one the form offers. The column is
 * free text on both databases, so a value the seed never wrote (an import, a
 * hand edit) is still carried through rather than forced into Inflow/Outflow.
 */
export function isCategoryType(value: string | null): value is CategoryType {
  return value !== null && (CATEGORY_TYPES as readonly string[]).includes(value);
}

/** `CAD · Canadian dollar`, or an em dash when the country carries no currency. */
export function currencyLabel(
  currencyId: string | null,
  currencies: readonly CurrencyRow[],
): string {
  if (currencyId === null) return "—";
  const currency = currencies.find((candidate) => candidate.id === currencyId);
  // A currency the list does not carry (deleted under us, or not loaded) still
  // has to show something the operator can act on.
  return currency === undefined ? currencyId : `${currency.code} · ${currency.name}`;
}

/** The base type's name, or an em dash when the account type carries none. */
export function baseTypeLabel(
  baseTypeId: string | null,
  baseTypes: readonly AccountBaseTypeRow[],
): string {
  if (baseTypeId === null) return "—";
  const baseType = baseTypes.find((candidate) => candidate.id === baseTypeId);
  // A base type the list does not carry (deleted under us, or not loaded)
  // still has to show something the operator can act on.
  return baseType === undefined ? baseTypeId : baseType.name;
}

/** `Housing › Rent`, walking up the tree; cycles cannot loop forever. */
export function categoryPath(row: CategoryRow, categories: readonly CategoryRow[]): string {
  const names = [row.name];
  const seen = new Set<string>([row.id]);
  let parentId = row.parentId;
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = categories.find((candidate) => candidate.id === parentId);
    if (parent === undefined) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names.join(" › ");
}

/** How deep a category sits, for the table's indent. */
export function categoryDepth(row: CategoryRow, categories: readonly CategoryRow[]): number {
  let depth = 0;
  const seen = new Set<string>([row.id]);
  let parentId = row.parentId;
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = categories.find((candidate) => candidate.id === parentId);
    if (parent === undefined) break;
    depth += 1;
    parentId = parent.parentId;
  }
  return depth;
}
