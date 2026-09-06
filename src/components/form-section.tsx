"use client";

/**
 * One bordered block of a settings form, with its icon in the screen's feature
 * colour — the same chrome the Subscriptions and Assets forms wear, shared here
 * so the four settings forms cannot drift from each other.
 */

import type { ReactNode } from "react";
import { Typography } from "antd";
import { surfaceColors } from "@/lib/theme/colors";

export default function FormSection({
  title,
  icon,
  color,
  extra,
  children,
}: {
  title: string;
  icon: ReactNode;
  /** The screen's accent, for the icon. */
  color: string;
  /** Controls at the right of the section heading. */
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className="flex flex-col gap-3 rounded-lg p-4"
      style={{
        backgroundColor: surfaceColors.card,
        border: `1px solid ${surfaceColors.separator}`,
      }}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden style={{ color }}>
          {icon}
        </span>
        <Typography.Text strong>{title}</Typography.Text>
        {extra !== undefined && <span className="ml-auto">{extra}</span>}
      </div>
      {children}
    </section>
  );
}
