"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { accentBlue, accentTints, surfaceColors } from "@/lib/theme/colors";
import { presentationFor, type ShellTab } from "./definitions";

/** Width of the rail, matching the consumer app's 100pt tab bar. */
export const RAIL_WIDTH = 100;

/**
 * Whether a tab is the one being looked at, given what `usePathname()` reports.
 * Overview is an exact match — everything is "under" `/` — and any other tab
 * also owns its sub-paths, so `/customers/42` still lights Customers.
 *
 * Exported because the compact layout's bottom tab bar has to agree with the
 * rail on this; two copies would be two chances to drift apart.
 */
export function isTabActive(pathname: string, href: string): boolean {
  return href === "/"
    ? pathname === "/"
    : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * One tab. The active one is the accent blue — icon, label, a 3px rule down
 * its leading edge and a soft blue wash behind it — rather than the tab's own
 * feature colour: one colour reads as "you are here".
 */
function RailTab({ tab, active }: { tab: ShellTab; active: boolean }) {
  const { icon: Icon } = presentationFor(tab.key);
  const color = active ? accentBlue : surfaceColors.textSecondary;

  return (
    <Link
      href={tab.href}
      aria-current={active ? "page" : undefined}
      className="relative flex flex-col items-center gap-1 rounded-lg px-1.5 py-2 text-center transition-colors hover:bg-black/[0.04]"
      style={{ color, backgroundColor: active ? accentTints.soft : undefined }}
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
      <span className="text-[12px] leading-[14px] font-medium" style={{ color }}>
        {tab.label}
      </span>
    </Link>
  );
}

/**
 * The vertical tab rail, the desktop layout's navigation. The tabs arrive from
 * the layout already filtered by the access map — what a person cannot open is
 * not drawn — so the rail is the permission model made visible. The active one
 * is whatever `usePathname()` reports.
 *
 * Hidden below `lg`, where `./bottom-tab-bar.tsx` draws the same list along
 * the bottom of the window.
 */
export default function SideRail({ tabs }: { tabs: readonly ShellTab[] }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      // Below `lg` the bottom tab bar carries these same tabs instead.
      className="flex shrink-0 flex-col gap-1 overflow-y-auto px-1.5 py-5 max-lg:hidden"
      style={{
        width: RAIL_WIDTH,
        background: surfaceColors.card,
        borderInlineEnd: `1px solid ${surfaceColors.separator}`,
      }}
    >
      {tabs.map((tab) => (
        <RailTab key={tab.key} tab={tab} active={isTabActive(pathname, tab.href)} />
      ))}
    </nav>
  );
}
