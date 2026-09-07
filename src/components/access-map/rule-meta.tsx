"use client";

/**
 * Shared pieces of the Access Map and Services pages: how a rule is summarised
 * in one line, the method badge, and the status tag for registered / not
 * registered / disabled rows.
 */

import { Tag, Tooltip } from "antd";
import { CrownFilled, LockOutlined } from "@ant-design/icons";
import type { AccessRule, AdminAction, EndpointAuthKind } from "@/lib/admin-access/types";
import { humaniseKey } from "@/lib/format";
import { featureColors, surfaceColors } from "@/lib/theme/colors";

export const ACCESS_MAP_COLOR = featureColors.accessMap;
export const SERVICES_COLOR = featureColors.services;

const METHOD_COLORS: Readonly<Record<string, string>> = {
  GET: "blue",
  POST: "green",
  PUT: "gold",
  PATCH: "orange",
  DELETE: "red",
};

export function MethodTag({ method }: { method: string }) {
  return (
    <Tag color={METHOD_COLORS[method] ?? "default"} style={{ marginInlineEnd: 0, fontFamily: "var(--font-geist-mono)", fontWeight: 600, width: 64, textAlign: "center" }}>
      {method}
    </Tag>
  );
}

export const AUTH_KIND_LABELS: Readonly<Record<EndpointAuthKind, string>> = {
  public: "Public",
  session: "Signed in",
  admin: "Operator",
  service: "API key",
};

export const AUTH_KIND_HELP: Readonly<Record<EndpointAuthKind, string>> = {
  public: "No credential needed. The rule below is informational; nothing gates a public endpoint.",
  session: "Any signed-in user of the admin Cognito pool, allowlisted or not. The rule below is not applied.",
  admin: "Requires an enabled admin user, then the rule below.",
  service: "Machine client with an API key (API_KEYS); the access-map rule is not applied.",
};

/**
 * The one-line explanation for an endpoint the access map does not gate. Only
 * `admin` endpoints are evaluated against a rule; the other three credentials
 * each have their own reason, and saying "any signed-in Cognito user" about a
 * machine client would be plainly wrong.
 */
export function authKindNotGatedHelp(kind: EndpointAuthKind): string {
  switch (kind) {
    case "public":
      return "No credential; the rule is not applied.";
    case "service":
      return "API-key machine client; the rule is not applied.";
    default:
      return "Any signed-in Cognito user; the rule is not applied.";
  }
}

/**
 * The rule in words: "Super-admin only", "Any operator", or the list of actions
 * of which one is enough. Disabled and unregistered are said first.
 */
export function RuleSummary({
  rule,
  registered,
  actions,
}: {
  rule: AccessRule;
  registered: boolean;
  actions: readonly AdminAction[];
}) {
  if (!registered) {
    return (
      <Tooltip title="No row in the database yet: super-admins only until registered. Shown with the code's defaults.">
        <Tag color="warning" style={{ marginInlineEnd: 0 }}>
          Not registered
        </Tag>
      </Tooltip>
    );
  }
  if (!rule.isEnabled) {
    return (
      <Tooltip title="Switched off: hidden from everyone but super-admins, who still see it so it can be turned back on.">
        <Tag icon={<LockOutlined />} style={{ marginInlineEnd: 0 }}>
          Disabled
        </Tag>
      </Tooltip>
    );
  }
  if (rule.requireSuperAdmin) {
    return (
      <Tag icon={<CrownFilled />} color="gold" style={{ marginInlineEnd: 0, fontWeight: 600 }}>
        Super-admin only
      </Tag>
    );
  }
  if (rule.actionKeys.length === 0) {
    return (
      <Tooltip title="No action required: every enabled operator may use it.">
        <Tag color="success" style={{ marginInlineEnd: 0 }}>
          Any operator
        </Tag>
      </Tooltip>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {rule.actionKeys.map((key, index) => {
        const action = actions.find((candidate) => candidate.key === key);
        return (
          <span key={key} className="flex items-center gap-1">
            {index > 0 && (
              <span className="text-[11px]" style={{ color: surfaceColors.textTertiary }}>
                or
              </span>
            )}
            <Tooltip title={action?.description ?? key}>
              <Tag style={{ marginInlineEnd: 0 }}>{humaniseKey(key.replace(/^can_/, ""))}</Tag>
            </Tooltip>
          </span>
        );
      })}
    </span>
  );
}
