/**
 * Joins what the database says (rows) with what the code ships (registries)
 * into the lists the Access Map shows. Shared by the mock and the Prisma
 * repository so both agree on what "unregistered" and "not in code" mean.
 */
import { ENDPOINT_REGISTRY } from "./endpoint-registry";
import { PAGE_REGISTRY } from "./page-registry";
import type { EndpointRule, PageRule } from "./types";

/** A stored page rule before merging: what the row holds, nothing inferred. */
export type StoredPageRule = Omit<PageRule, "registered" | "inCode">;
export type StoredEndpointRule = Omit<EndpointRule, "registered" | "inCode">;

export function mergePageRules(rows: readonly StoredPageRule[]): PageRule[] {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const merged: PageRule[] = [];
  for (const entry of PAGE_REGISTRY) {
    const row = byKey.get(entry.key);
    if (row) {
      merged.push({ ...row, registered: true, inCode: true });
      byKey.delete(entry.key);
    } else {
      merged.push({
        key: entry.key,
        kind: entry.kind,
        path: entry.path,
        name: entry.name,
        description: entry.description,
        navOrder: entry.defaults.navOrder,
        isEnabled: true,
        requireSuperAdmin: entry.defaults.requireSuperAdmin,
        actionKeys: [...entry.defaults.actionKeys],
        registered: false,
        inCode: true,
        updatedAt: null,
      });
    }
  }
  // Rows the code no longer knows: shown so they can be cleaned up.
  for (const row of byKey.values()) {
    merged.push({ ...row, registered: true, inCode: false });
  }
  return merged.sort((a, b) =>
    a.kind === b.kind ? a.navOrder - b.navOrder || a.name.localeCompare(b.name) : a.kind === "page" ? -1 : 1,
  );
}

export function mergeEndpointRules(rows: readonly StoredEndpointRule[]): EndpointRule[] {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const merged: EndpointRule[] = [];
  for (const entry of ENDPOINT_REGISTRY) {
    const row = byKey.get(entry.key);
    if (row) {
      // Method, path and rate limit come from the code: they describe the
      // build that is running, not a preference.
      merged.push({
        ...row,
        method: entry.method,
        path: entry.path,
        authKind: entry.authKind,
        rateLimit: entry.rateLimit,
        registered: true,
        inCode: true,
      });
      byKey.delete(entry.key);
    } else {
      merged.push({
        key: entry.key,
        method: entry.method,
        path: entry.path,
        name: entry.name,
        description: entry.description,
        category: entry.category,
        authKind: entry.authKind,
        rateLimit: entry.rateLimit,
        notes: null,
        isEnabled: true,
        requireSuperAdmin: entry.defaults.requireSuperAdmin,
        actionKeys: [...entry.defaults.actionKeys],
        registered: false,
        inCode: true,
        updatedAt: null,
      });
    }
  }
  for (const row of byKey.values()) {
    merged.push({ ...row, registered: true, inCode: false });
  }
  return merged.sort(
    (a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
}
