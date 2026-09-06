/**
 * Colour roles shared by the whole app.
 *
 * Mirrors the feature-colour convention of the Penny Squeeze apps: every
 * domain has one accent that its tab, its quick action, and its cards all use,
 * so a colour alone tells the reader which part of the app they are looking
 * at. Values are the Apple system colours the native app renders, so the admin
 * console, the consumer web app and the mac app all read the same.
 */
export const featureColors = {
  /** Teal — overview-style summaries. */
  overview: "#30B0C7",
  /** Blue — banking, accounts, transactions, transfers. */
  banking: "#007AFF",
  /** Cyan — assets and investments. */
  asset: "#32ADE6",
  /** Green — loans. */
  loan: "#34C759",
  /** Orange — recurring income and bills. */
  incomeBills: "#FF9500",
  /** Purple — budgets. */
  budget: "#AF52DE",
  /** Indigo — subscriptions. */
  subscription: "#5856D6",
  /** Green — savings goals. */
  goal: "#34C759",
  /** Mint — tags and the calendar. */
  tag: "#00C7BE",
  /** Red — rules, alerts, and anything destructive. */
  rule: "#FF3B30",
  /** Neutral grey for secondary controls. */
  neutral: "#8E8E93",

  /* Admin console domains. */

  /** Purple — reference data and constants shared by every tenant. */
  constants: "#AF52DE",
  /** Blue — end users, tenants and admin operators. */
  users: "#007AFF",
  /** Orange — support tickets and the help desk. */
  support: "#FF9500",
} as const;

export type FeatureColor = keyof typeof featureColors;

/** Money-movement colours: inflow, outflow, and transfers between own accounts. */
export const flowColors = {
  inflow: "#34C759",
  outflow: "#FF3B30",
  transfer: "#007AFF",
} as const;

/** Surfaces and text, matching the light theme the auth pages already use. */
export const surfaceColors = {
  /** Page background behind cards. */
  page: "#f6f6f7",
  /** Cards, page headers, the nav bar, and the side rail. */
  card: "#ffffff",
  /** Card header bands and muted panels. */
  cardHeader: "#fafafa",
  /** Inset panels inside a card: stat chips, expanded lists, notification tiles. */
  panel: "#f4f5f7",
  /** Small neutral chips: the card caption pill and the month navigator. */
  chip: "#f1f2f4",
  /** Hairlines between rows and around cards. */
  separator: "rgba(0, 0, 0, 0.08)",
  /** Primary text. */
  text: "#141414",
  /** Secondary text. */
  textSecondary: "#6b6b6b",
  /** Tertiary text and disabled hints. */
  textTertiary: "#9a9a9a",
} as const;

/* -------------------------------------------------------------------------- */
/* Accent                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The app's UI accent: the same system blue as the mac app's default theme
 * (SwiftUI `.blue` / `#007AFF`, also `featureColors.banking` here). Also
 * antd's `colorPrimary`.
 */
export const accentBlue = "#007AFF";

/** One step darker, for hover on anything painted `accentBlue`. */
export const accentBlueDark = "#0066d6";

/** Two steps darker, for the pressed state. */
export const accentBlueDeep = "#0055b3";

/**
 * Blue tints, as rgba over whatever sits behind them. Used for the side rail's
 * active pill and other places where the accent has to register without
 * shouting.
 */
export const accentTints = {
  /** Barely-there wash behind the active rail tab. */
  soft: "rgba(0, 122, 255, 0.06)",
  /** Chip and badge backgrounds that still carry accent text. */
  medium: "rgba(0, 122, 255, 0.14)",
  /** Outline: accent at 50%. */
  outline: "rgba(0, 122, 255, 0.5)",
} as const;

/* -------------------------------------------------------------------------- */
/* Brand                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Brand red, the same red as the Canadian flag. Brand-only: the logo and the
 * login page's red left panel. Not the UI accent — see `accentBlue` for that.
 */
export const brandRed = "#ff0000";

/** One step darker, for hover on anything painted `brandRed`. Brand-only. */
export const brandRedDark = "#e60000";

/** Two steps darker, for the pressed state. Brand-only. */
export const brandRedDeep = "#cc0000";

/**
 * Red tints, as rgba over whatever sits behind them. Brand-only — used by the
 * login page's red left panel, not by the rest of the UI (see `accentTints`).
 */
export const brandRedTints = {
  /** Barely-there wash. */
  soft: "rgba(255, 0, 0, 0.06)",
  /** Chip and badge backgrounds that still carry red text. */
  medium: "rgba(255, 0, 0, 0.14)",
  /** Outline: red at 50%. */
  outline: "rgba(255, 0, 0, 0.5)",
} as const;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** `#007AFF` at 12% → `rgba(0, 122, 255, 0.12)`. Non-hex input is returned as is. */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.startsWith("#") ? color.slice(1) : null;
  if (!hex || (hex.length !== 3 && hex.length !== 6)) return color;
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The card surface every dashboard and rail card is drawn on. */
export const cardSurfaceStyle = {
  backgroundColor: surfaceColors.card,
  border: `1px solid ${surfaceColors.separator}`,
  boxShadow:
    "0 1px 2px rgba(16, 24, 40, 0.04), 0 10px 28px -14px rgba(16, 24, 40, 0.16)",
  borderRadius: 16,
} as const;
