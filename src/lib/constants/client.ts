/**
 * The browser's typed calls to `/api/v1/admin/constants/*`. Client-safe: no
 * `server-only` imports, only `apiFetch` and the plain types.
 *
 * Every mutation announces a change on `window`, the same way the admin-access
 * client does, so a table that did not make the call can reload.
 */
import { apiFetch } from "@/lib/api/client";
import type {
  ConstantInputOf,
  ConstantKind,
  ConstantListResponse,
  ConstantPatchOf,
  ConstantRowOf,
  PushInput,
  PushResponse,
} from "./types";

const BASE = "/api/v1/admin/constants";

/** Fired on `window` after any constants write or push succeeds. */
export const CONSTANTS_CHANGED_EVENT = "penny-squeeze:constants-changed";

export function notifyConstantsChanged(kind: ConstantKind): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<ConstantKind>(CONSTANTS_CHANGED_EVENT, { detail: kind }));
  }
}

/** Subscribes to change announcements; returns the unsubscribe. */
export function onConstantsChanged(listener: (kind: ConstantKind) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => listener((event as CustomEvent<ConstantKind>).detail);
  window.addEventListener(CONSTANTS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(CONSTANTS_CHANGED_EVENT, handler);
}

const kindPath = (kind: ConstantKind) => `${BASE}/${encodeURIComponent(kind)}`;
const rowPath = (kind: ConstantKind, id: string) => `${kindPath(kind)}/${encodeURIComponent(id)}`;

export const constantsApi = {
  list: <K extends ConstantKind>(kind: K) => apiFetch<ConstantListResponse<K>>(kindPath(kind)),

  get: <K extends ConstantKind>(kind: K, id: string) => apiFetch<ConstantRowOf<K>>(rowPath(kind, id)),

  create: async <K extends ConstantKind>(kind: K, input: ConstantInputOf<K>) => {
    const row = await apiFetch<ConstantRowOf<K>>(kindPath(kind), { method: "POST", json: input });
    notifyConstantsChanged(kind);
    return row;
  },

  update: async <K extends ConstantKind>(kind: K, id: string, input: ConstantPatchOf<K>) => {
    const row = await apiFetch<ConstantRowOf<K>>(rowPath(kind, id), { method: "PATCH", json: input });
    notifyConstantsChanged(kind);
    return row;
  },

  /** Categories are retired (soft-deleted); the other kinds are removed from the admin catalog. */
  remove: async (kind: ConstantKind, id: string) => {
    await apiFetch<void>(rowPath(kind, id), { method: "DELETE" });
    notifyConstantsChanged(kind);
  },

  /** Pushes the given ids, or every row of the kind when `ids` is omitted. An empty array is refused (422). */
  push: async (kind: ConstantKind, input: PushInput = {}) => {
    const result = await apiFetch<PushResponse>(`${kindPath(kind)}/push`, { method: "POST", json: input });
    notifyConstantsChanged(kind);
    return result;
  },
};
