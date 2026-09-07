"use client";

/**
 * Small shared pieces of the Customers screen: the page colour, the two status
 * tags, the colours their breakdowns are drawn in, and the cells that repeat
 * across the two tables and the detail drawer.
 *
 * Kept together so a status reads the same in the table, on the rail card and
 * in the drawer — the same reason the Integrations and User Management screens
 * each have one of these.
 */

import { Tag, Tooltip } from "antd";
import type { CustomerCognitoAccount, CustomerStatus, InviteStatus } from "@/lib/customers/types";
import { featureColors, surfaceColors } from "@/lib/theme/colors";

/** The Customers entry's colour in the gear menu and on its cards. */
export const CUSTOMERS_COLOR = featureColors.users;

/* -------------------------------------------------------------------------- */
/* Customer status                                                            */
/* -------------------------------------------------------------------------- */

interface StatusMeta {
  label: string;
  /** antd `Tag` preset. */
  tagColor: string;
  /** Hex, for the rail card's dots and bars. */
  color: string;
  tooltip: string;
}

export const CUSTOMER_STATUS_META: Readonly<Record<CustomerStatus, StatusMeta>> = {
  active: {
    label: "Active",
    tagColor: "green",
    color: featureColors.loan,
    tooltip: "Has signed in and set their own password; the pool account is confirmed and enabled.",
  },
  invited: {
    label: "Invited",
    tagColor: "gold",
    color: "#D4A017",
    tooltip: "The pool account exists but the temporary password has never been changed.",
  },
  disabled: {
    label: "Disabled",
    tagColor: "red",
    color: featureColors.rule,
    tooltip: "The pool account is switched off; the person cannot sign in.",
  },
  no_account: {
    label: "No account",
    tagColor: "default",
    color: featureColors.neutral,
    tooltip: "A row in the app database with no matching account in the customer pool.",
  },
  unknown: {
    label: "Unknown",
    tagColor: "default",
    color: surfaceColors.textTertiary,
    tooltip: "The customer pool was not consulted, so the account state is not known.",
  },
};

/** The order the status filter and the rail card list them in. */
export const CUSTOMER_STATUSES: readonly CustomerStatus[] = [
  "active",
  "invited",
  "disabled",
  "no_account",
  "unknown",
];

export function CustomerStatusTag({ status }: { status: CustomerStatus }) {
  const meta = CUSTOMER_STATUS_META[status];
  return (
    <Tooltip title={meta.tooltip}>
      <Tag
        color={meta.tagColor === "default" ? undefined : meta.tagColor}
        style={{ marginInlineEnd: 0 }}
      >
        {meta.label}
      </Tag>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/* Invite status                                                              */
/* -------------------------------------------------------------------------- */

export const INVITE_STATUS_META: Readonly<Record<InviteStatus, StatusMeta>> = {
  invited: {
    label: "Invited",
    tagColor: "gold",
    color: "#D4A017",
    tooltip: "Sent, and waiting for the person to sign in for the first time.",
  },
  accepted: {
    label: "Accepted",
    tagColor: "green",
    color: featureColors.loan,
    tooltip: "The person has signed in; the consumer app has created their row.",
  },
  revoked: {
    label: "Revoked",
    tagColor: "default",
    color: featureColors.neutral,
    tooltip: "Withdrawn before it was accepted; the pool account was deleted.",
  },
  failed: {
    label: "Failed",
    tagColor: "red",
    color: featureColors.rule,
    tooltip: "Cognito refused the account; the reason is in the error column.",
  },
};

export const INVITE_STATUSES: readonly InviteStatus[] = [
  "invited",
  "accepted",
  "revoked",
  "failed",
];

export function InviteStatusTag({ status }: { status: InviteStatus }) {
  const meta = INVITE_STATUS_META[status];
  return (
    <Tooltip title={meta.tooltip}>
      <Tag
        color={meta.tagColor === "default" ? undefined : meta.tagColor}
        style={{ marginInlineEnd: 0 }}
      >
        {meta.label}
      </Tag>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/* Cells                                                                      */
/* -------------------------------------------------------------------------- */

/** An em dash rather than an empty cell, so a blank column still looks deliberate. */
export function Dash() {
  return <span style={{ color: surfaceColors.textTertiary }}>—</span>;
}

/** Optional free text: the note on an invitation, a tenant that is not there. */
export function TextCell({ value }: { value: string | null }) {
  if (value === null || value === "") return <Dash />;
  return (
    <Tooltip title={value}>
      <span className="block max-w-full truncate" style={{ color: surfaceColors.text }} tabIndex={0}>
        {value}
      </span>
    </Tooltip>
  );
}

/** A provider's refusal: red, one line, the whole of it on hover. */
export function ErrorCell({ error }: { error: string | null }) {
  if (error === null || error === "") return <Dash />;
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

/** How the customer pool spells an account's own state, for the detail drawer. */
export const COGNITO_STATUS_LABELS: Readonly<Record<CustomerCognitoAccount["status"], string>> = {
  confirmed: "Confirmed",
  force_change_password: "Temporary password not yet changed",
  unconfirmed: "Unconfirmed",
  reset_required: "Password reset required",
  unknown: "Unknown",
};
