"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { accentBlue, accentTints, surfaceColors } from "@/lib/theme/colors";
import { primaryTabs, type TabDefinition } from "./definitions";

/** Width of the rail, matching the native app's 100pt tab bar. */
export const RAIL_WIDTH = 100;

/**
 * One tab. The active one is the accent blue — icon, label, a 3px rule down
 * its leading edge and a soft blue wash behind it — rather than the tab's own
 * feature colour: with several tabs, several active colours read as
 * decoration, while one colour reads as "you are here". The feature colours
 * are still carried by the quick actions, the settings rows and the cards, so
 * each domain keeps its identity where it actually helps.
 */
function RailTab({ tab, active }: { tab: TabDefinition; active: boolean }) {
  const { icon: Icon } = tab;
  const color = active ? accentBlue : surfaceColors.textSecondary;

  return (
    <Link
      href={tab.href}
      aria-current={active ? "page" : undefined}
      className="relative flex flex-col items-center gap-1 rounded-lg px-1.5 py-2 text-center transition-colors hover:bg-black/[0.04]"
      style={{
        color,
        backgroundColor: active ? accentTints.soft : undefined,
      }}
    >
      {active && (
        <span
          aria-hidden
          className="absolute top-1.5 bottom-1.5 left-0 rounded-full"
          style={{ width: 3, backgroundColor: accentBlue }}
        />
      )}
      <Icon style={{ fontSize: 20, color }} />
      {/* Two lines maximum, as in the native tab bar button. */}
      <span
        className="text-[12px] leading-[14px] font-medium"
        style={{ color }}
      >
        {tab.label}
      </span>
    </Link>
  );
}

/**
 * The vertical tab rail. Tabs are routes here rather than an index into a
 * switch, so the active one is whatever `usePathname()` reports.
 */
export default function SideRail() {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav
      aria-label="Main"
      className="flex shrink-0 flex-col gap-1 overflow-y-auto px-1.5 py-5"
      style={{
        width: RAIL_WIDTH,
        background: surfaceColors.card,
        borderInlineEnd: `1px solid ${surfaceColors.separator}`,
      }}
    >
      {primaryTabs.map((tab) => (
        <RailTab key={tab.href} tab={tab} active={isActive(tab.href)} />
      ))}
    </nav>
  );
}
