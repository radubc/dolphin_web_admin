/**
 * The header band every page in the authenticated shell wears: title, a short
 * blue accent rule under it, an optional caption, and optional trailing actions.
 *
 * The accent is the app's signature colour — the same blue as the mac app —
 * and repeating it on every page (Overview, the stubs, the popover headings) is
 * what makes navigation feel like one product rather than a set of screens.
 *
 * Deliberately not a Client Component: it holds no state and renders no antd
 * component, so the server-rendered stub pages and the client-rendered Overview
 * can both use it.
 */

import type { ReactNode } from "react";
import { accentBlue, surfaceColors } from "@/lib/theme/colors";

/** Width of the accent rule. Short enough to read as an underline, not a border. */
const ACCENT_WIDTH = 28;

/**
 * The blue rule itself, exported so popover and drawer headings can carry the
 * same accent without duplicating the measurements.
 */
export function AccentRule({ width = ACCENT_WIDTH }: { width?: number }) {
  return (
    <span
      aria-hidden
      className="block rounded-full"
      style={{ width, height: 3, backgroundColor: accentBlue }}
    />
  );
}

/**
 * A heading with the accent underneath it, for popovers and other places that
 * want the treatment without the full page-header band.
 */
export function AccentHeading({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-start gap-1.5 ${className ?? ""}`}>
      <span
        className="text-base font-semibold"
        style={{ color: surfaceColors.text }}
      >
        {children}
      </span>
      <AccentRule />
    </div>
  );
}

interface PageHeaderProps {
  title: string;
  /** Secondary line under the accent, e.g. today's date or "Coming soon". */
  caption?: ReactNode;
  /**
   * Reserves the caption's line height even when there is no caption yet, so a
   * caption that arrives after hydration cannot shift the page.
   */
  reserveCaption?: boolean;
  /** Buttons pinned to the right of the band. */
  actions?: ReactNode;
  /**
   * Pins the band to the top of the nearest scrolling ancestor (the shell's
   * `<main>`) instead of letting it scroll away with the page's content.
   * Off by default so the stub pages keep their current, simpler behaviour;
   * pass `true` from any page whose content scrolls independently of its
   * header, as the Overview grid does.
   */
  sticky?: boolean;
}

export default function PageHeader({
  title,
  caption,
  reserveCaption = false,
  actions,
  sticky = false,
}: PageHeaderProps) {
  const showCaption = caption !== undefined || reserveCaption;

  return (
    <header
      className={`flex items-center gap-3 px-5 py-3 ${sticky ? "sticky top-0 z-10" : ""}`}
      style={{
        backgroundColor: surfaceColors.card,
        borderBottom: `1px solid ${surfaceColors.separator}`,
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <h1
          className="m-0 text-lg leading-tight font-semibold"
          style={{ color: surfaceColors.text }}
        >
          {title}
        </h1>
        <AccentRule />
        {showCaption && (
          <p
            className="m-0 text-xs"
            style={{ color: surfaceColors.textSecondary, minHeight: 16 }}
          >
            {caption}
          </p>
        )}
      </div>

      {actions}
    </header>
  );
}
