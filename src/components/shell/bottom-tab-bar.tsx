"use client";

import { useEffect, useRef, type Ref } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { accentBlue, accentTints, surfaceColors } from "@/lib/theme/colors";
import { presentationFor, type ShellTab } from "./definitions";
import { isTabActive } from "./side-rail";

/**
 * One tab. Same treatment as the rail's — accent blue icon, label and wash for
 * the active one — with the 3px rule moved from the leading edge to the top
 * edge, because that is the edge this bar shares with the content above it.
 */
function BottomTab({
  tab,
  active,
  activeRef,
}: {
  tab: ShellTab;
  active: boolean;
  /** Set on the active tab only, so the bar can scroll it into view. */
  activeRef: Ref<HTMLAnchorElement>;
}) {
  const { icon: Icon } = presentationFor(tab.key);
  const color = active ? accentBlue : surfaceColors.textSecondary;

  return (
    <Link
      ref={active ? activeRef : undefined}
      href={tab.href}
      aria-current={active ? "page" : undefined}
      // `min-h-[44px]` is the floor a finger needs; the icon, the gap and the
      // label already clear it, so it only matters if the label ever goes.
      className="relative flex min-h-[44px] min-w-[72px] shrink-0 flex-col items-center justify-center gap-1 rounded-lg px-2 py-2 text-center transition-colors"
      style={{ color, backgroundColor: active ? accentTints.soft : undefined }}
    >
      {active && (
        <span
          aria-hidden
          className="absolute inset-x-2 top-0 rounded-full"
          style={{ height: 3, backgroundColor: accentBlue }}
        />
      )}
      <Icon style={{ fontSize: 20, color }} />
      {/* One line: the strip scrolls sideways, so a long label widens its tab
          rather than wrapping into a ragged second row. */}
      <span
        className="text-[11px] leading-[13px] font-medium whitespace-nowrap"
        style={{ color }}
      >
        {tab.label}
      </span>
    </Link>
  );
}

/**
 * The compact layout's tab bar: the side rail laid on its side along the
 * bottom of the window, shown below `lg` and hidden at and above it, where the
 * rail takes over. Both are rendered by the server and CSS picks — nothing
 * here waits for a media query, so there is no reflow on first paint.
 *
 * It is the last child of the shell's column rather than a fixed overlay, so
 * `<main>` keeps its own scroll and the bar can never sit on top of the last
 * row of a list.
 *
 * Ten tabs do not fit across a phone, so the strip scrolls horizontally and
 * brings the active tab into view on mount and on every navigation. The tabs
 * arrive already filtered by the access map, exactly as the rail's do; this
 * component never decides who sees what.
 */
export default function BottomTabBar({ tabs }: { tabs: readonly ShellTab[] }) {
  const pathname = usePathname();
  const activeTabRef = useRef<HTMLAnchorElement>(null);

  // Not state, so this is not the `setState`-in-an-effect the repo forbids:
  // it reads the DOM the render just produced and scrolls it. On desktop the
  // bar is `display: none` and the call is a no-op.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [pathname]);

  return (
    <nav
      // The rail is already "Main". Two navs with the same name would both be
      // announced, even though only one is ever visible, so this one says
      // which layout it belongs to.
      aria-label="Main, compact"
      className="flex shrink-0 gap-1 overflow-x-auto overscroll-x-contain px-2 pt-1 [scrollbar-width:none] lg:hidden"
      style={{
        background: surfaceColors.card,
        borderTop: `1px solid ${surfaceColors.separator}`,
        // The home indicator's strip on a phone, zero everywhere else. Needs
        // `viewportFit: "cover"` in the root layout to be anything but zero.
        paddingBottom: "calc(0.25rem + env(safe-area-inset-bottom))",
      }}
    >
      {tabs.map((tab) => (
        <BottomTab
          key={tab.key}
          tab={tab}
          active={isTabActive(pathname, tab.href)}
          activeRef={activeTabRef}
        />
      ))}
    </nav>
  );
}
