/**
 * The Overview's card shell and the handful of read-out primitives its six
 * cards are built from.
 *
 * **Server Components, deliberately.** Nothing on the Overview is
 * interactive: every card is a read-out of something the page already
 * fetched, so none of this needs state, an effect or an event handler. That
 * rules out Ant Design (its components are client components, and
 * `@ant-design/icons` uses React context) and it means the dashboard ships no
 * JavaScript of its own. The look still comes from the shared tokens —
 * `cardSurfaceStyle`, `surfaceColors`, `featureColors` — so a card here and a
 * `StatCard` on a settings rail are the same object.
 *
 * Every card takes its data as a `Loaded<T>` and renders {@link NotAvailable}
 * when it is a failure, which is the whole of the Overview's error handling:
 * one card degrades, the page does not.
 */

import type { ReactNode } from "react";
import { cardSurfaceStyle, surfaceColors, withAlpha } from "@/lib/theme/colors";

/* -------------------------------------------------------------------------- */
/*                                  The card                                  */
/* -------------------------------------------------------------------------- */

interface OverviewCardProps {
  title: string;
  /** The card's feature colour: the accent rule and any bar inside it. */
  accent: string;
  /** Small print pinned to the right of the title, e.g. how fresh the data is. */
  badge?: ReactNode;
  children: ReactNode;
  /** Small print under the content: definitions, caveats, thresholds. */
  footnote?: ReactNode;
  className?: string;
}

export function OverviewCard({
  title,
  accent,
  badge,
  children,
  footnote,
  className,
}: OverviewCardProps) {
  return (
    <section
      className={`flex min-w-0 flex-col p-4 ${className ?? ""}`}
      style={cardSurfaceStyle}
      aria-label={title}
    >
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          <h2
            className="m-0 text-[11px] font-semibold tracking-wide uppercase"
            style={{ color: surfaceColors.textSecondary }}
          >
            {title}
          </h2>
          <span
            aria-hidden
            className="block rounded-full"
            style={{ width: 24, height: 3, backgroundColor: accent }}
          />
        </div>
        {badge !== undefined && (
          <span
            className="shrink-0 text-right text-[11px] leading-tight"
            style={{ color: surfaceColors.textTertiary }}
          >
            {badge}
          </span>
        )}
      </header>

      <div className="flex min-w-0 flex-1 flex-col gap-3">{children}</div>

      {footnote !== undefined && (
        <p className="mt-3 mb-0 text-[11px] leading-snug" style={{ color: surfaceColors.textTertiary }}>
          {footnote}
        </p>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Failure and absence                           */
/* -------------------------------------------------------------------------- */

/**
 * The one line a card shows instead of its content when its read failed.
 *
 * The reason comes from `loadedFrom` (`src/lib/ops/types.ts`) and is printed
 * verbatim, because this console has one audience — operators — and "Not
 * available: Could not load credentials from any providers" is the sentence
 * that ends the investigation, where "something went wrong" starts one.
 *
 * What `loadedFrom` hands over differs by source, and that decision lives
 * there rather than here: an AWS failure is AWS's own message, while a
 * **database** failure is the flat sentence "The admin database could not be
 * read" / "The main database could not be read", with the ORM's own paragraph
 * logged server-side instead. A card renders whichever it is given; it never
 * inspects or rewrites a reason.
 */
export function NotAvailable({ reason }: { reason: string }) {
  return (
    <p className="m-0 text-sm leading-snug" style={{ color: surfaceColors.textSecondary }}>
      <span style={{ color: surfaceColors.text }}>Not available:</span> {reason}
    </p>
  );
}

/** The same line, for "there is nothing to show yet" rather than a failure. */
export function Waiting({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 text-sm leading-snug" style={{ color: surfaceColors.textSecondary }}>
      {children}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Read-outs                                 */
/* -------------------------------------------------------------------------- */

interface FigureProps {
  label: string;
  value: string;
  /** Defaults to the primary text colour. */
  color?: string;
  /** A second line under the value: a comparison, a date, a unit. */
  hint?: ReactNode;
  /** `title` rather than a tooltip component, so this stays a Server Component. */
  help?: string;
}

/** One number with its label above it. The Overview's unit of measurement. */
export function Figure({ label, value, color, hint, help }: FigureProps) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" title={help}>
      <span
        className="text-[11px] font-medium tracking-wide uppercase"
        style={{ color: surfaceColors.textSecondary }}
      >
        {label}
      </span>
      <span
        className="text-xl leading-tight font-semibold tabular-nums"
        style={{ color: color ?? surfaceColors.text }}
      >
        {value}
      </span>
      {hint !== undefined && (
        <span className="text-[11px] leading-snug" style={{ color: surfaceColors.textTertiary }}>
          {hint}
        </span>
      )}
    </div>
  );
}

/** A row of figures that wraps rather than squeezing on a narrow card. */
export function FigureRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-start gap-x-6 gap-y-3">{children}</div>;
}

/**
 * A share bar: the chip colour as the track, the accent as the fill.
 *
 * `share` is clamped to 0..1 so an over-budget month draws a full bar rather
 * than one that escapes its track; the figure beside it carries the overage.
 */
export function ShareBar({
  share,
  color,
  label,
}: {
  share: number;
  color: string;
  label?: string;
}) {
  const clamped = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0;
  return (
    <span
      aria-hidden
      title={label}
      className="block overflow-hidden rounded-full"
      style={{ height: 6, backgroundColor: surfaceColors.chip }}
    >
      <span
        className="block h-full rounded-full"
        style={{ width: `${clamped * 100}%`, backgroundColor: color }}
      />
    </span>
  );
}

/**
 * One labelled row with a value on the right and an optional bar under it —
 * the funnel's steps, a tenant's size, a service's task counts.
 */
export function BarRow({
  label,
  sublabel,
  value,
  share,
  color,
  help,
}: {
  label: ReactNode;
  sublabel?: ReactNode;
  value: ReactNode;
  /** Omit to draw the row without a bar. */
  share?: number;
  color: string;
  help?: string;
}) {
  return (
    <div className="flex flex-col gap-1" title={help}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-baseline gap-2 text-sm">
          <span className="truncate" style={{ color: surfaceColors.text }}>
            {label}
          </span>
          {sublabel !== undefined && (
            <span className="shrink-0 text-[11px]" style={{ color: surfaceColors.textTertiary }}>
              {sublabel}
            </span>
          )}
        </span>
        <span
          className="shrink-0 text-sm font-semibold tabular-nums"
          style={{ color: surfaceColors.text }}
        >
          {value}
        </span>
      </div>
      {share !== undefined && <ShareBar share={share} color={color} />}
    </div>
  );
}

/** A small state pill: a rollout state, an environment, a status word. */
export function Pill({ children, color }: { children: ReactNode; color: string }) {
  return (
    <span
      className="inline-block rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={{ color, backgroundColor: withAlpha(color, 0.14) }}
    >
      {children}
    </span>
  );
}

/** A hairline between groups of rows inside a card. */
export function Divider() {
  return (
    <span
      aria-hidden
      className="block"
      style={{ height: 1, backgroundColor: surfaceColors.separator }}
    />
  );
}
