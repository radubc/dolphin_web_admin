/**
 * The browser's typed calls to `/api/v1/admin/*`. Client-safe: no `server-only`
 * imports, only `apiFetch` and the plain types.
 *
 * Every mutation ends by announcing a change on `window`, so a component that
 * did not make the call — the page behind the shell's "Invite user" drawer,
 * say — can reload without the two knowing about each other.
 */
import { apiFetch } from "@/lib/api/client";
import type {
  AdminAction,
  AdminCapabilities,
  AdminRole,
  AdminUser,
  AuditPage,
  CreateAdminUserInput,
  CreateRoleInput,
  EndpointRule,
  EndpointUsageSummary,
  PageRule,
  UpdateAdminUserInput,
  UpdateRoleInput,
  UpsertEndpointRuleInput,
  UpsertPageRuleInput,
} from "./types";

/** The rate-limit presets as the usage route reports them. */
export type RateLimitPresets = Record<string, { limit: number; windowMs: number }>;

const BASE = "/api/v1/admin";

/** Fired on `window` after any admin-access write succeeds. */
export const ADMIN_ACCESS_CHANGED_EVENT = "penny-squeeze:admin-access-changed";

export function notifyAdminAccessChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(ADMIN_ACCESS_CHANGED_EVENT));
  }
}

/** Subscribes to change announcements; returns the unsubscribe. */
export function onAdminAccessChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(ADMIN_ACCESS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(ADMIN_ACCESS_CHANGED_EVENT, listener);
}

export const adminAccessApi = {
  me: () => apiFetch<AdminCapabilities>(`${BASE}/me`),

  listUsers: () => apiFetch<AdminUser[]>(`${BASE}/users`),
  createUser: async (input: CreateAdminUserInput) => {
    const user = await apiFetch<AdminUser>(`${BASE}/users`, { method: "POST", json: input });
    notifyAdminAccessChanged();
    return user;
  },
  updateUser: async (id: string, input: UpdateAdminUserInput) => {
    const user = await apiFetch<AdminUser>(`${BASE}/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      json: input,
    });
    notifyAdminAccessChanged();
    return user;
  },

  listRoles: () => apiFetch<AdminRole[]>(`${BASE}/roles`),
  createRole: async (input: CreateRoleInput) => {
    const role = await apiFetch<AdminRole>(`${BASE}/roles`, { method: "POST", json: input });
    notifyAdminAccessChanged();
    return role;
  },
  updateRole: async (id: string, input: UpdateRoleInput) => {
    const role = await apiFetch<AdminRole>(`${BASE}/roles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      json: input,
    });
    notifyAdminAccessChanged();
    return role;
  },
  deleteRole: async (id: string) => {
    await apiFetch<void>(`${BASE}/roles/${encodeURIComponent(id)}`, { method: "DELETE" });
    notifyAdminAccessChanged();
  },

  listActions: () => apiFetch<AdminAction[]>(`${BASE}/actions`),

  listAudit: (limit = 50, cursor?: string | null) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    return apiFetch<AuditPage>(`${BASE}/audit?${params.toString()}`);
  },

  listPageRules: () => apiFetch<PageRule[]>(`${BASE}/pages`),
  upsertPageRule: async (key: string, input: UpsertPageRuleInput) => {
    const rule = await apiFetch<PageRule>(`${BASE}/pages/${encodeURIComponent(key)}`, {
      method: "PUT",
      json: input,
    });
    notifyAdminAccessChanged();
    return rule;
  },

  listEndpointRules: () => apiFetch<EndpointRule[]>(`${BASE}/endpoints`),
  upsertEndpointRule: async (key: string, input: UpsertEndpointRuleInput) => {
    const rule = await apiFetch<EndpointRule>(`${BASE}/endpoints/${encodeURIComponent(key)}`, {
      method: "PUT",
      json: input,
    });
    notifyAdminAccessChanged();
    return rule;
  },

  listUsage: () =>
    apiFetch<{ usage: EndpointUsageSummary[]; rateLimits: RateLimitPresets }>(`${BASE}/usage`),
};
