"use client";

/**
 * The permission audit trail, newest first: who did what to whom, and when.
 * Metadata is shown as compact key/value chips rather than raw JSON.
 */

import { Button, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { AuditEvent } from "@/lib/admin-access/types";
import { formatDateTime, formatRelativeTime, humaniseKey } from "@/lib/format";
import { useListTableBodyHeight } from "@/lib/hooks/use-table-body-height";
import { surfaceColors } from "@/lib/theme/colors";
import { AUDIT_ACTION_LABELS, auditTone } from "./access-meta";

const TABLE_MIN_WIDTH = 900;

interface AuditTableProps {
  rows: readonly AuditEvent[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

function describeMetadata(metadata: Record<string, unknown>): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    const rendered = Array.isArray(value)
      ? value.map(String).map(humaniseKey).join(", ")
      : typeof value === "boolean"
        ? value
          ? "yes"
          : "no"
        : String(value);
    parts.push(`${humaniseKey(key)}: ${rendered}`);
  }
  return parts;
}

export default function AuditTable({ rows, hasMore, loadingMore, onLoadMore }: AuditTableProps) {
  // Set inside a `ListTableRegion`: the rows scroll, the header and the
  // "load older" strip below stay.
  const bodyHeight = useListTableBodyHeight();

  const columns: ColumnsType<AuditEvent> = [
    {
      title: "When",
      dataIndex: "createdAt",
      width: 150,
      render: (value: string) => (
        <Tooltip title={formatDateTime(value)}>
          <span className="tabular-nums" style={{ color: surfaceColors.textSecondary }}>
            {formatRelativeTime(value)}
          </span>
        </Tooltip>
      ),
    },
    {
      title: "Actor",
      dataIndex: "actorEmail",
      width: 240,
      render: (value: string | null) =>
        value === null ? (
          <span style={{ color: surfaceColors.textTertiary }}>System</span>
        ) : (
          <span className="truncate" style={{ color: surfaceColors.text }}>
            {value}
          </span>
        ),
    },
    {
      title: "Action",
      dataIndex: "action",
      width: 200,
      render: (value: string) => (
        <Tag color={auditTone(value)} style={{ marginInlineEnd: 0 }}>
          {AUDIT_ACTION_LABELS[value] ?? humaniseKey(value)}
        </Tag>
      ),
    },
    {
      title: "Target",
      key: "target",
      width: 260,
      render: (_value, event) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate" style={{ color: surfaceColors.text }}>
            {event.targetLabel ?? event.targetId ?? "—"}
          </span>
          <span className="text-xs" style={{ color: surfaceColors.textTertiary }}>
            {humaniseKey(event.targetType)}
          </span>
        </span>
      ),
    },
    {
      title: "Details",
      key: "details",
      render: (_value, event) => {
        const parts = describeMetadata(event.metadata);
        return parts.length === 0 ? (
          <span style={{ color: surfaceColors.textTertiary }}>—</span>
        ) : (
          <span className="text-xs" style={{ color: surfaceColors.textSecondary }}>
            {parts.join(" · ")}
          </span>
        );
      },
    },
  ];

  return (
    <>
      <Table<AuditEvent>
        dataSource={[...rows]}
        rowKey={(event) => event.id}
        columns={columns}
        size="middle"
        scroll={{ x: TABLE_MIN_WIDTH, y: bodyHeight }}
        pagination={false}
      />
      {hasMore && (
        <div
          // Reserved, not scrolled: the region measures it and takes it off the
          // body height, so the button stays under the rows.
          data-list-reserve
          className="flex justify-center py-3"
          style={{ borderTop: `1px solid ${surfaceColors.separator}` }}
        >
          <Button type="link" loading={loadingMore} onClick={onLoadMore}>
            Load older events
          </Button>
        </div>
      )}
    </>
  );
}
