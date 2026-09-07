"use client";

/**
 * Small shared pieces of the Integrations screen: the page colour, the run
 * status and trigger tags, the words a schedule is read out in, the timezone
 * list the schedule form offers, and the "is this from today" test the figures
 * use.
 *
 * Everything the three views must say the same way lives here, so a status
 * reads identically on a card, in the runs drawer and in a table cell.
 */

import { Tag, Tooltip } from "antd";
import dayjs from "dayjs";
import timezonePlugin from "dayjs/plugin/timezone";
import utcPlugin from "dayjs/plugin/utc";
import {
  DEFAULT_TIMEZONE,
  type IntegrationKey,
  type IntegrationProvider,
  type IntegrationSchedule,
  type QuoteKind,
  type RunStatus,
  type RunTrigger,
  type WatchSource,
} from "@/lib/integrations/types";
import { featureColors, flowColors, surfaceColors } from "@/lib/theme/colors";

dayjs.extend(utcPlugin);
dayjs.extend(timezonePlugin);

/** The Integrations tab's colour on the rail (amber), as `shell/definitions.ts` sets it. */
export const INTEGRATIONS_COLOR = featureColors.integrations;

/* -------------------------------------------------------------------------- */
/* Providers                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How each provider is spelled for a person. The stored value is a snake_case
 * key; nothing on screen should ever show it.
 */
export const PROVIDER_LABELS: Readonly<Record<IntegrationProvider, string>> = {
  twelvedata: "TwelveData",
  bank_of_canada: "Bank of Canada",
  iso20022: "ISO 20022",
  alpha_vantage: "Alpha Vantage",
};

/** The provider's name, falling back to the raw key for a value newer than this build. */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider as IntegrationProvider] ?? provider;
}

/**
 * A sentence a particular integration needs beside it when its seeded
 * description does not already say it. Empty today: the Alpha Vantage row's
 * description (docs/sql/009) explains that it is a fallback whose own
 * schedule is normally off, so repeating it here printed the same sentence
 * twice. The slot stays for the next integration that needs one.
 */
export const INTEGRATION_NOTES: Readonly<Partial<Record<IntegrationKey, string>>> = {};

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

export interface RunStatusMeta {
  label: string;
  /** antd `Tag` preset. */
  tagColor: string;
  /** Hex, for the rail card's dots and bars. */
  color: string;
  tooltip: string;
}

export const RUN_STATUS_META: Readonly<Record<RunStatus, RunStatusMeta>> = {
  queued: {
    label: "Queued",
    tagColor: "default",
    color: featureColors.neutral,
    tooltip: "Accepted and waiting to start.",
  },
  running: {
    label: "Running",
    tagColor: "processing",
    color: featureColors.banking,
    tooltip: "Working through its items now.",
  },
  succeeded: {
    label: "Succeeded",
    tagColor: "green",
    color: featureColors.loan,
    tooltip: "Finished; individual items it could not fetch are counted as failed.",
  },
  failed: {
    label: "Failed",
    tagColor: "red",
    color: featureColors.rule,
    tooltip: "Stopped before it finished. Whatever it had already written is kept.",
  },
  // Every batch commits on its own, so an interrupted run has lost nothing —
  // it only has to be started again.
  interrupted: {
    label: "Interrupted",
    tagColor: "orange",
    color: featureColors.incomeBills,
    tooltip: "The process restarted under it. Nothing already written is lost; run it again to finish.",
  },
};

export function RunStatusTag({ status }: { status: RunStatus }) {
  const meta = RUN_STATUS_META[status];
  return (
    <Tooltip title={meta.tooltip}>
      <Tag color={meta.tagColor} style={{ marginInlineEnd: 0 }}>
        {meta.label}
      </Tag>
    </Tooltip>
  );
}

export const TRIGGER_LABELS: Readonly<Record<RunTrigger, string>> = {
  scheduled: "Scheduled",
  manual: "Run now",
  on_demand: "On demand",
};

const TRIGGER_HELP: Readonly<Record<RunTrigger, string>> = {
  scheduled: "The scheduler started it at its appointed time.",
  manual: "An operator pressed Run now on this page.",
  on_demand: "The consumer app asked for something the cache did not have yet.",
};

export function TriggerTag({ trigger }: { trigger: RunTrigger }) {
  return (
    <Tooltip title={TRIGGER_HELP[trigger]}>
      <Tag style={{ marginInlineEnd: 0 }}>{TRIGGER_LABELS[trigger]}</Tag>
    </Tooltip>
  );
}

/** `2 m 14 s`, or an em dash while a run has not finished. */
export function formatDuration(startedAt: string | null, finishedAt: string | null): string {
  if (startedAt === null || finishedAt === null) return "—";
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (Number.isNaN(started) || Number.isNaN(finished) || finished < started) return "—";
  const seconds = Math.round((finished - started) / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
}

/* -------------------------------------------------------------------------- */
/* Schedules                                                                  */
/* -------------------------------------------------------------------------- */

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** `1` → `1st`, `22` → `22nd`. Only ever asked about 1..28. */
export function ordinal(day: number): string {
  const rest = day % 100;
  if (rest >= 11 && rest <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/** `02:00`, from the schedule's wall-clock hour and minute. */
export function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * The schedule in one line: "Daily at 02:00 America/Toronto", "Weekly on Monday
 * at 02:00 America/Toronto", "Monthly on the 1st at 02:00 America/Toronto",
 * "Off". The timezone is always named — a time without one is the single
 * easiest thing to misread on this page.
 */
export function scheduleSummary(schedule: IntegrationSchedule): string {
  if (schedule.frequency === "off") return "Off";
  const at = `at ${formatClock(schedule.hour, schedule.minute)} ${schedule.timezone}`;
  switch (schedule.frequency) {
    case "daily":
      return `Daily ${at}`;
    case "weekly":
      return `Weekly on ${WEEKDAY_NAMES[schedule.weekday] ?? "Sunday"} ${at}`;
    case "monthly":
      return `Monthly on the ${ordinal(schedule.dayOfMonth)} ${at}`;
  }
}

/**
 * The zones the schedule form suggests. Free text is still accepted — the field
 * is an `AutoComplete`, not a closed list — because the server takes any IANA
 * name and a deployment may well want one that is not here.
 */
export const TIMEZONE_OPTIONS = [
  "America/Toronto",
  "America/Vancouver",
  "America/Edmonton",
  "America/Winnipeg",
  "America/Halifax",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "UTC",
  "Europe/London",
  "Europe/Paris",
  "Europe/Zurich",
  "Asia/Tokyo",
  "Asia/Hong_Kong",
  "Australia/Sydney",
] as const;

/* -------------------------------------------------------------------------- */
/* Watch lists                                                                */
/* -------------------------------------------------------------------------- */

export const QUOTE_KIND_LABELS: Readonly<Record<QuoteKind, string>> = {
  stock: "Stock",
  etf: "ETF",
  crypto: "Crypto",
};

const QUOTE_KIND_TAG_COLORS: Readonly<Record<QuoteKind, string>> = {
  stock: "blue",
  etf: "cyan",
  crypto: "purple",
};

/** Hex per kind, for the rail card's dots and bars. */
export const QUOTE_KIND_COLORS: Readonly<Record<QuoteKind, string>> = {
  stock: featureColors.banking,
  etf: featureColors.asset,
  crypto: featureColors.budget,
};

export function QuoteKindTag({ kind }: { kind: QuoteKind }) {
  return (
    <Tag color={QUOTE_KIND_TAG_COLORS[kind]} style={{ marginInlineEnd: 0 }}>
      {QUOTE_KIND_LABELS[kind]}
    </Tag>
  );
}

const SOURCE_HELP: Readonly<Record<WatchSource, string>> = {
  manual: "Added by hand on this page.",
  request: "Added the first time the consumer app asked for it.",
};

export function SourceTag({ source }: { source: WatchSource }) {
  return (
    <Tooltip title={SOURCE_HELP[source]}>
      <Tag style={{ marginInlineEnd: 0 }}>{source === "manual" ? "Manual" : "Requested"}</Tag>
    </Tooltip>
  );
}

const QUOTE_PROVIDER_TAG_COLORS: Readonly<Record<IntegrationProvider, string>> = {
  twelvedata: "blue",
  alpha_vantage: "gold",
  // Neither quotes anything; listed so the record is total and a stray value
  // still renders as a tag rather than as nothing.
  bank_of_canada: "default",
  iso20022: "default",
};

/**
 * Which provider last served a watched symbol, and why that is worth a column.
 *
 * It is not decoration: the value decides who is asked next time. A symbol
 * marked Alpha Vantage is not sent to TwelveData at all (its free plan refuses
 * non-US listings, for a credit), and one marked TwelveData never spends one
 * of Alpha Vantage's 25 daily requests.
 */
export function QuoteProviderTag({ provider }: { provider: IntegrationProvider | null }) {
  if (provider === null) {
    return (
      <Tooltip title="No quote has been saved for this symbol yet, so no provider owns it.">
        <span tabIndex={0} style={{ color: surfaceColors.textTertiary }}>
          —
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip
      title={
        provider === "alpha_vantage"
          ? "Alpha Vantage last served this symbol, so the run asks it first and spends no TwelveData credit on it."
          : `${providerLabel(provider)} last served this symbol, so the Alpha Vantage fallback is not spent on it.`
      }
    >
      <Tag color={QUOTE_PROVIDER_TAG_COLORS[provider] ?? "default"} style={{ marginInlineEnd: 0 }}>
        {providerLabel(provider)}
      </Tag>
    </Tooltip>
  );
}

/** `boc` reads as the Bank of Canada's own series; `derived` as the CAD ratio. */
export function RateSourceTag({ source }: { source: "boc" | "derived" }) {
  return (
    <Tooltip
      title={
        source === "boc"
          ? "Read straight from the Bank of Canada's series for this currency against CAD."
          : "Neither side is CAD, so the rate is the ratio of the two CAD series."
      }
    >
      <Tag color={source === "boc" ? "green" : "default"} style={{ marginInlineEnd: 0 }}>
        {source === "boc" ? "Bank of Canada" : "Derived"}
      </Tag>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/* Small formatters                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Whether an ISO timestamp falls on today's date, in `DEFAULT_TIMEZONE`
 * (`America/Toronto`) — the same zone the server uses to decide "today"
 * (`src/lib/integrations/dates.ts`), not UTC. A quote fetched at 20:00
 * Toronto time is already tomorrow in UTC.
 */
export function isToday(iso: string | null | undefined): boolean {
  if (iso === null || iso === undefined || iso === "") return false;
  const time = dayjs(iso);
  if (!time.isValid()) return false;
  const today = dayjs().tz(DEFAULT_TIMEZONE).format("YYYY-MM-DD");
  return time.tz(DEFAULT_TIMEZONE).format("YYYY-MM-DD") === today;
}

/** `+0.64 %` in green, `-1.20 %` in red, an em dash when the provider sent none. */
export function PercentChange({ fraction }: { fraction: number | null }) {
  if (fraction === null) return <span style={{ color: surfaceColors.textTertiary }}>—</span>;
  const percent = fraction * 100;
  const colour =
    percent > 0 ? flowColors.inflow : percent < 0 ? flowColors.outflow : surfaceColors.textSecondary;
  const sign = percent > 0 ? "+" : "";
  return (
    <span className="tabular-nums" style={{ color: colour }}>
      {sign}
      {percent.toFixed(2)} %
    </span>
  );
}

/** The last error, one line, with the whole thing on hover. */
export function ErrorCell({ error }: { error: string | null }) {
  if (error === null || error === "") {
    return <span style={{ color: surfaceColors.textTertiary }}>—</span>;
  }
  return (
    <Tooltip title={error}>
      <span
        className="block max-w-full truncate text-xs"
        style={{ color: featureColors.rule }}
        tabIndex={0}
      >
        {error}
      </span>
    </Tooltip>
  );
}
