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
  ConstantJob,
  ConstantKind,
  ConstantListResponse,
  ConstantPatchOf,
  ConstantRowOf,
  JobResponse,
  ListQuery,
  PushInput,
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

function listSearch(query: ListQuery): string {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
  if (query.q !== undefined && query.q.trim() !== "") params.set("q", query.q.trim());
  if (query.state !== undefined && query.state !== "all") params.set("state", query.state);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

export const constantsApi = {
  /** One page of a catalog; see `ListQuery` for paging, search and the state filter. */
  list: <K extends ConstantKind>(kind: K, query: ListQuery = {}) =>
    apiFetch<ConstantListResponse<K>>(`${kindPath(kind)}${listSearch(query)}`),

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

  /** Categories, account types and markets are retired (soft-deleted); the other kinds are removed from the admin catalog. */
  remove: async (kind: ConstantKind, id: string) => {
    await apiFetch<void>(rowPath(kind, id), { method: "DELETE" });
    notifyConstantsChanged(kind);
  },

  /**
   * Starts a push: `{ ids }` for chosen rows, `{ scope: "pending" }` for
   * everything new or changed, `{ scope: "all" }` for the whole catalog. Small
   * requests come back already finished; large ones come back `running` and
   * are followed with `job()`.
   */
  push: async (kind: ConstantKind, input: PushInput) => {
    const { job } = await apiFetch<JobResponse>(`${kindPath(kind)}/push`, { method: "POST", json: input });
    if (job.status === "succeeded" || job.status === "failed") notifyConstantsChanged(kind);
    return job;
  },

  /** Starts a compare job that rebuilds the sync ledger for the kind. */
  compare: async (kind: ConstantKind) => {
    const { job } = await apiFetch<JobResponse>(`${kindPath(kind)}/compare`, { method: "POST", json: {} });
    if (job.status === "succeeded" || job.status === "failed") notifyConstantsChanged(kind);
    return job;
  },

  /** Recent jobs for the kind, newest first. */
  jobs: (kind: ConstantKind, limit = 10) =>
    apiFetch<ConstantJob[]>(`${kindPath(kind)}/jobs?limit=${encodeURIComponent(String(limit))}`),

  /** One job by id, for polling. */
  job: (kind: ConstantKind, jobId: string) =>
    apiFetch<ConstantJob>(`${kindPath(kind)}/jobs/${encodeURIComponent(jobId)}`),
};
