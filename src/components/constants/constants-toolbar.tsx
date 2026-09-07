"use client";

/**
 * The controls row over a catalog: a search box and the push-state segment.
 * Neither removes anything — "All" with an empty box is the whole catalog —
 * and the Retired segment only exists for categories, the one kind that keeps
 * its retired rows.
 */

import { useMemo } from "react";
import { Input, Segmented } from "antd";
import type { ConstantKind } from "@/lib/constants/types";
import { KIND_META, PUSH_STATE_META } from "./constants-meta";
import type { StateFilter } from "./use-constants-store";

interface ConstantsToolbarProps {
  kind: ConstantKind;
  search: string;
  stateFilter: StateFilter;
  onSearchChange: (search: string) => void;
  onStateFilterChange: (filter: StateFilter) => void;
}

export default function ConstantsToolbar({
  kind,
  search,
  stateFilter,
  onSearchChange,
  onStateFilterChange,
}: ConstantsToolbarProps) {
  const options = useMemo(() => {
    const base: Array<{ value: StateFilter; label: string }> = [
      { value: "all", label: "All" },
      { value: "new", label: PUSH_STATE_META.new.label },
      { value: "changed", label: PUSH_STATE_META.changed.label },
      { value: "synced", label: PUSH_STATE_META.synced.label },
    ];
    return kind === "categories" ? [...base, { value: "retired" as StateFilter, label: "Retired" }] : base;
  }, [kind]);

  const placeholder =
    kind === "countries"
      ? "Search name, ISO code or currency…"
      : kind === "currencies"
        ? "Search code, name or symbol…"
        : kind === "financial_institutions"
          ? "Search name, number or type…"
          : "Search category or parent…";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <Input.Search
        allowClear
        value={search}
        placeholder={placeholder}
        aria-label={`Search ${KIND_META[kind].plural}`}
        onChange={(event) => onSearchChange(event.target.value)}
        onSearch={onSearchChange}
        style={{ width: 320 }}
      />

      <span role="group" aria-label="Filter by push state">
        <Segmented<StateFilter>
          value={stateFilter}
          onChange={onStateFilterChange}
          options={options}
        />
      </span>
    </div>
  );
}
