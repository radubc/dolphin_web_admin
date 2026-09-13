"use client";

/**
 * The users controls row: search, an enabled/disabled segment, and a role
 * filter. None of them removes anything: "All" with no role is the full list.
 */

import { useMemo } from "react";
import { Input, Segmented, Select } from "antd";
import {
  USER_STATUS_FILTERS,
  USER_STATUS_LABELS,
  type UserStatusFilter,
  type UsersFilters,
} from "@/lib/admin-access/store";
import type { AdminRole } from "@/lib/admin-access/types";

interface UsersToolbarProps {
  filters: UsersFilters;
  roles: readonly AdminRole[];
  onSearchChange: (search: string) => void;
  onStatusChange: (status: UserStatusFilter) => void;
  onRoleChange: (roleKey: string | null) => void;
}

export default function UsersToolbar({
  filters,
  roles,
  onSearchChange,
  onStatusChange,
  onRoleChange,
}: UsersToolbarProps) {
  const statusOptions = useMemo(
    () => USER_STATUS_FILTERS.map((key) => ({ value: key, label: USER_STATUS_LABELS[key] })),
    [],
  );
  const roleOptions = useMemo(
    () => roles.map((role) => ({ value: role.key, label: role.name })),
    [roles],
  );

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {/* The width lives on this plain wrapper, which the search box fills: antd's own
          full-width rule on the box is unlayered and would beat a Tailwind width
          set on the box itself. Row-wide on compact, the old fixed width on desktop. */}
      <div className="w-full lg:w-[300px]">
        <Input.Search
          allowClear
          value={filters.search}
          placeholder="Search by name, email or role…"
          aria-label="Search admin users"
          onChange={(event) => onSearchChange(event.target.value)}
          onSearch={onSearchChange}
        />
      </div>

      <span role="group" aria-label="Filter by status" className="max-lg:max-w-full max-lg:overflow-x-auto">
        <Segmented<UserStatusFilter>
          value={filters.status}
          onChange={onStatusChange}
          options={statusOptions}
        />
      </span>

      <Select<string | null>
        allowClear
        placeholder="Any role"
        value={filters.roleKey ?? undefined}
        onChange={(value) => onRoleChange(value ?? null)}
        options={roleOptions}
        aria-label="Filter by role"
        // On the box itself, unlike the search: antd sets no width on a Select
        // outside a Form.Item, so nothing outranks this. Wrap it if that changes.
        className="w-full lg:w-[220px]"
      />
    </div>
  );
}
