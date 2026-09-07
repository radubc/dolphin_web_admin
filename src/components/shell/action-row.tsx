"use client";

import Link from "next/link";
import { RightOutlined } from "@ant-design/icons";
import { featureColors, surfaceColors } from "@/lib/theme/colors";
import type { FeatureColor } from "@/lib/theme/colors";
import type { ShellIcon } from "./definitions";

interface ActionRowProps {
  icon: ShellIcon;
  title: string;
  subtitle: string;
  color: FeatureColor;
  /**
   * When the row goes somewhere, the route. Given one, the row *is* a link —
   * so the settings menu can be middle-clicked, copied and prefetched like the
   * rail tabs — and `onClick` only closes the popover behind it. Quick actions
   * open a drawer instead and pass no href.
   */
  href?: string;
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
  href,
  onClick,
}: ActionRowProps) {
  const body = (
    <>
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
    </>
  );

  const className =
    "flex w-full cursor-pointer items-center gap-3 rounded-lg border-0 bg-transparent px-2.5 py-2 text-left transition-colors hover:bg-black/[0.04]";

  return href === undefined ? (
    <button type="button" onClick={onClick} className={className}>
      {body}
    </button>
  ) : (
    <Link href={href} onClick={onClick} className={className}>
      {body}
    </Link>
  );
}
