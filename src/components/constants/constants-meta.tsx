"use client";

/**
 * Small shared pieces of the Constants screen: the page colour, the four kinds
 * as the switcher shows them, the push-state tag, and the two label helpers
 * (a currency read as `CAD · Canadian dollar`, a category read as
 * `Parent › Child`) that the table and the drawer must say the same way.
 */

import { Tag, Tooltip } from "antd";
import {
  ApartmentOutlined,
  BankOutlined,
  DollarOutlined,
  GlobalOutlined,
} from "@ant-design/icons";
import type {
  CategoryRow,
  CategoryType,
  ConstantKind,
  ConstantRow,
  CurrencyRow,
  PushState,
} from "@/lib/constants/types";
import { CATEGORY_TYPES } from "@/lib/constants/types";
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
  /** What the catalog is for, shown in the empty state. */
  blurb: string;
  /** The sum of the table's column widths; below it the table scrolls sideways. */
  tableWidth: number;
}

export const KIND_META: Readonly<Record<ConstantKind, KindMeta>> = {
  countries: {
    label: "Countries",
    singular: "country",
    plural: "countries",
    icon: <GlobalOutlined />,
    blurb:
      "Countries the app offers when a user sets up their profile, each with its ISO codes and default currency.",
    tableWidth: 900,
  },
  currencies: {
    label: "Currencies",
    singular: "currency",
    plural: "currencies",
    icon: <DollarOutlined />,
    blurb: "Currencies accounts and transactions can be denominated in.",
    tableWidth: 800,
  },
  financial_institutions: {
    label: "Financial institutions",
    singular: "financial institution",
    plural: "financial institutions",
    icon: <BankOutlined />,
    blurb: "Banks and credit unions users pick when they add an account.",
    tableWidth: 860,
  },
  categories: {
    label: "Categories",
    singular: "category",
    plural: "categories",
    icon: <ApartmentOutlined />,
    blurb:
      "The default category tree every new tenant starts from: inflow and outflow, parents and children.",
    tableWidth: 1040,
  },
};

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
};

/** Grey, for a retired category. */
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

/** Whether a row carries a retirement stamp. Only categories ever do. */
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
