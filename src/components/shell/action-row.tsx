"use client";

import { RightOutlined } from "@ant-design/icons";
import { featureColors, surfaceColors } from "@/lib/theme/colors";
import type { FeatureColor } from "@/lib/theme/colors";
import type { ShellIcon } from "./definitions";

interface ActionRowProps {
  icon: ShellIcon;
  title: string;
  subtitle: string;
  color: FeatureColor;
  onClick: () => void;
}

/**
 * The row shared by the quick-action and settings popovers: coloured icon,
 * bold title, secondary subtitle, chevron. The native app draws both lists with
 * the same control (`QuickActionButton` / `SettingsButton`), so they are one
 * component here too.
 */
export default function ActionRow({
  icon: Icon,
  title,
  subtitle,
  color,
  onClick,
}: ActionRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-3 rounded-lg border-0 bg-transparent px-2.5 py-2 text-left transition-colors hover:bg-black/[0.04]"
    >
      <Icon
        style={{ fontSize: 20, color: featureColors[color], flexShrink: 0 }}
      />
      <span className="flex min-w-0 flex-col">
        <span
          className="text-sm font-semibold"
          style={{ color: surfaceColors.text }}
        >
          {title}
        </span>
        <span className="text-xs" style={{ color: surfaceColors.textSecondary }}>
          {subtitle}
        </span>
      </span>
      <RightOutlined
        className="ms-auto"
        style={{ fontSize: 11, color: surfaceColors.textTertiary }}
      />
    </button>
  );
}
