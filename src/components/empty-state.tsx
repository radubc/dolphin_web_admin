"use client";

/**
 * The two empty states a settings list can be in, kept apart because they are
 * different problems with different answers.
 *
 * `ListEmpty` is the true empty: there is nothing of this kind at all, so
 * the screen makes its pitch and offers the one action that fixes it.
 * `ListNoResults` is a filter that matches nothing, which is not an empty
 * list — it is a list you cannot see — so it offers to clear the filters
 * instead of offering to add another record.
 */

import type { ReactNode } from "react";
import { Button, Empty, Typography } from "antd";
import { ClearOutlined, PlusOutlined } from "@ant-design/icons";
import { withAlpha } from "@/lib/theme/colors";
import { surfaceColors } from "@/lib/theme/colors";

interface ListEmptyProps {
  icon: ReactNode;
  /** The screen's feature colour, for the icon disc. */
  color: string;
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}

export function ListEmpty({
  icon,
  color,
  title,
  description,
  actionLabel,
  onAction,
}: ListEmptyProps) {
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-lg px-6 py-14 text-center"
      style={{
        backgroundColor: surfaceColors.card,
        border: `1px solid ${surfaceColors.separator}`,
      }}
    >
      <span
        aria-hidden
        className="flex items-center justify-center rounded-full text-2xl"
        style={{ width: 56, height: 56, backgroundColor: withAlpha(color, 0.12), color }}
      >
        {icon}
      </span>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {title}
      </Typography.Title>
      <Typography.Text type="secondary" style={{ maxWidth: 420 }}>
        {description}
      </Typography.Text>
      <Button type="primary" icon={<PlusOutlined />} onClick={onAction} className="mt-2">
        {actionLabel}
      </Button>
    </div>
  );
}

export function ListNoResults({
  what,
  onClearFilters,
}: {
  /** Plural noun, e.g. "categories". */
  what: string;
  onClearFilters: () => void;
}) {
  return (
    <div
      className="flex flex-col items-center gap-2 rounded-lg px-6 py-10"
      style={{
        backgroundColor: surfaceColors.card,
        border: `1px solid ${surfaceColors.separator}`,
      }}
    >
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <Typography.Text type="secondary">No {what} match these filters.</Typography.Text>
        }
      />
      <Button icon={<ClearOutlined />} onClick={onClearFilters}>
        Clear filters
      </Button>
    </div>
  );
}
