"use client";

/**
 * The controls row over a catalog: a search box, the push-state segment and,
 * for the two listed-instrument catalogs, a Market filter.
 *
 * They are all *server* filters — a catalog of 300,000 rows is never in the
 * browser to sift — so each change becomes a query and the table comes back on
 * page 1. None of them removes anything: "All" with an empty box is the whole
 * catalog, retired rows included — every push-state segment now carries
 * retired rows along with live ones; only "Retired" itself splits on
 * retirement and shows nothing else. The Retired segment only exists for the
 * kinds that retire rather than delete (categories, account types, markets),
 * which are the ones that keep their retired rows, and Unknown only means
 * "no compare has reached this row yet". For the two pulled kinds
 * (`isPulledKind`: categories, financial institutions) the push-state options
 * beyond "All" and "Retired" drop out entirely — they carry no push state to
 * filter on.
 *
 * The Market Select only exists for ETFs and stocks, the two catalogs that
 * carry a listing country. It defaults to "All markets", which is not a
 * problem to leave alone: those two kinds already list Canadian and then US
 * rows first (`PREFERRED_COUNTRIES`), so the wanted listing is at the top of
 * page 1 rather than buried among the same ticker's world exchanges. The
 * options are the countries the feed spells that way, since the filter is an
 * exact match; a market the list does not offer is still reachable through the
 * search box.
 */

import { useMemo } from "react";
import { Input, Segmented, Select } from "antd";
import type { ConstantKind } from "@/lib/constants/types";
import { MARKET_FILTER_COUNTRIES, isMarketKind, isPulledKind } from "@/lib/constants/types";
import { KIND_META, PUSH_STATE_META } from "./constants-meta";
import { ALL_MARKETS, type MarketFilter, type StateFilter } from "./use-constants-store";

/** "All markets" plus the countries the two catalogs list the most of. */
const MARKET_OPTIONS: Array<{ value: MarketFilter; label: string }> = [
  { value: ALL_MARKETS, label: "All markets" },
  ...MARKET_FILTER_COUNTRIES.map((country) => ({ value: country as MarketFilter, label: country })),
];

interface ConstantsToolbarProps {
  kind: ConstantKind;
  search: string;
  stateFilter: StateFilter;
  /** ETFs and stocks only; `""` is every market. */
  market: MarketFilter;
  /** A query is in flight; the search box says so rather than the page going blank. */
  searching: boolean;
  /** Held only while a push or compare request is on its way out. */
  disabled?: boolean;
  onSearchChange: (search: string) => void;
  onStateFilterChange: (filter: StateFilter) => void;
  onMarketChange: (market: MarketFilter) => void;
}

export default function ConstantsToolbar({
  kind,
  search,
  stateFilter,
  market,
  searching,
  disabled = false,
  onSearchChange,
  onStateFilterChange,
  onMarketChange,
}: ConstantsToolbarProps) {
  const options = useMemo(() => {
    const base: Array<{ value: StateFilter; label: string; title: string }> = [
      { value: "all", label: "All", title: "Every live row. State filters also carry retired rows; Retired shows only those" },
    ];
    // Categories and financial institutions are pulled by the consumer app
    // rather than pushed, so they carry no push state worth filtering on
    // (`isPulledKind`, `service.ts`'s `updateWithState` / `removeConstant`
    // never compare them against the main database). Only "All" and, for
    // categories, "Retired" still mean anything.
    if (!isPulledKind(kind)) {
      base.push(
        { value: "new", label: PUSH_STATE_META.new.label, title: PUSH_STATE_META.new.tooltip },
        {
          value: "changed",
          label: PUSH_STATE_META.changed.label,
          title: PUSH_STATE_META.changed.tooltip,
        },
        {
          value: "synced",
          label: PUSH_STATE_META.synced.label,
          title: PUSH_STATE_META.synced.tooltip,
        },
        {
          value: "unknown",
          label: PUSH_STATE_META.unknown.label,
          title: PUSH_STATE_META.unknown.tooltip,
        },
        { value: "pending", label: "Pending", title: "Everything new or changed: what a push would write" },
      );
    }
    return KIND_META[kind].retires
      ? [
          ...base,
          {
            value: "retired" as StateFilter,
            label: "Retired",
            title: "Retired here; a push carries the retirement over",
          },
        ]
      : base;
  }, [kind]);

  const placeholder = KIND_META[kind].searchPlaceholder;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <Input.Search
        allowClear
        value={search}
        loading={searching}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={`Search ${KIND_META[kind].plural}`}
        // The query follows the box after a 300 ms pause; Enter only asks for
        // the same query sooner, so both handlers set the same state.
        onChange={(event) => onSearchChange(event.target.value)}
        onSearch={onSearchChange}
        style={{ width: 320 }}
      />

      {isMarketKind(kind) && (
        <span
          role="group"
          aria-label="Filter by market"
          title="Canadian and US listings come first whatever this is set to"
        >
          <Select<MarketFilter>
            value={market}
            disabled={disabled}
            onChange={onMarketChange}
            options={MARKET_OPTIONS}
            style={{ width: 170 }}
          />
        </span>
      )}

      <span role="group" aria-label="Filter by push state">
        <Segmented<StateFilter>
          value={stateFilter}
          disabled={disabled}
          onChange={onStateFilterChange}
          options={options}
        />
      </span>
    </div>
  );
}
