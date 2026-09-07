"use client";

/**
 * The controls row over a catalog: a search box and the push-state segment.
 *
 * Both are *server* filters now — a catalog of 300,000 rows is never in the
 * browser to sift — so each change becomes a query and the table comes back on
 * page 1. Neither removes anything: "All" with an empty box is the whole
 * catalog, retired rows included — every push-state segment now carries
 * retired rows along with live ones; only "Retired" itself splits on
 * retirement and shows nothing else. The Retired segment only exists for the
 * kinds that retire rather than delete (categories, account types, markets),
 * which are the ones that keep their retired rows, and Unknown only means
 * "no compare has reached this row yet".
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
  /** A query is in flight; the search box says so rather than the page going blank. */
  searching: boolean;
  /** Held only while a push or compare request is on its way out. */
  disabled?: boolean;
  onSearchChange: (search: string) => void;
  onStateFilterChange: (filter: StateFilter) => void;
}

export default function ConstantsToolbar({
  kind,
  search,
  stateFilter,
  searching,
  disabled = false,
  onSearchChange,
  onStateFilterChange,
}: ConstantsToolbarProps) {
  const options = useMemo(() => {
    const base: Array<{ value: StateFilter; label: string; title: string }> = [
      { value: "all", label: "All", title: "Every live row. State filters also carry retired rows; Retired shows only those" },
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
    ];
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
