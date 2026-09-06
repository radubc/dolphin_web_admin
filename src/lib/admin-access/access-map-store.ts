"use client";

/**
 * The Access Map page's client store: page rules and endpoint rules, the
 * action catalog for the pickers, one open rule drawer, and the save call.
 * Reloads when anything announces an admin-access change.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { adminAccessApi, onAdminAccessChanged } from "./client";
import type {
  AdminAction,
  AdminCapabilities,
  EndpointRule,
  PageRule,
  UpsertEndpointRuleInput,
  UpsertPageRuleInput,
} from "./types";
import { errorMessage } from "@/lib/format";

export type RuleTarget = { kind: "page"; rule: PageRule } | { kind: "endpoint"; rule: EndpointRule };

export interface AccessMapStore {
  capabilities: AdminCapabilities;
  canWrite: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;

  pages: PageRule[];
  endpoints: EndpointRule[];
  actions: AdminAction[];

  /** How many entries the code ships that have no database row yet. */
  unregisteredCount: number;

  editing: RuleTarget | null;
  openRule: (target: RuleTarget) => void;
  closeRule: () => void;

  savePageRule: (key: string, input: UpsertPageRuleInput) => Promise<PageRule>;
  saveEndpointRule: (key: string, input: UpsertEndpointRuleInput) => Promise<EndpointRule>;
  /** Registers with the code's defaults: an empty upsert. */
  register: (target: RuleTarget) => Promise<void>;
  registerAllMissing: () => Promise<void>;
}

export function useAccessMapStore(capabilities: AdminCapabilities): AccessMapStore {
  const [pages, setPages] = useState<PageRule[]>([]);
  const [endpoints, setEndpoints] = useState<EndpointRule[]>([]);
  const [actions, setActions] = useState<AdminAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<RuleTarget | null>(null);

  const reload = useCallback(() => {
    setError(null);
    setTick((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextPages, nextEndpoints, nextActions] = await Promise.all([
          adminAccessApi.listPageRules(),
          adminAccessApi.listEndpointRules(),
          adminAccessApi.listActions(),
        ]);
        if (cancelled) return;
        setPages(nextPages);
        setEndpoints(nextEndpoints);
        setActions(nextActions);
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  useEffect(() => onAdminAccessChanged(reload), [reload]);

  const unregisteredCount = useMemo(
    () =>
      pages.filter((rule) => rule.inCode && !rule.registered).length +
      endpoints.filter((rule) => rule.inCode && !rule.registered).length,
    [pages, endpoints],
  );

  const savePageRule = useCallback(async (key: string, input: UpsertPageRuleInput) => {
    const rule = await adminAccessApi.upsertPageRule(key, input);
    setPages((current) => current.map((item) => (item.key === key ? rule : item)));
    return rule;
  }, []);

  const saveEndpointRule = useCallback(async (key: string, input: UpsertEndpointRuleInput) => {
    const rule = await adminAccessApi.upsertEndpointRule(key, input);
    setEndpoints((current) => current.map((item) => (item.key === key ? rule : item)));
    return rule;
  }, []);

  const register = useCallback(
    async (target: RuleTarget) => {
      if (target.kind === "page") await savePageRule(target.rule.key, {});
      else await saveEndpointRule(target.rule.key, {});
    },
    [savePageRule, saveEndpointRule],
  );

  const registerAllMissing = useCallback(async () => {
    for (const rule of pages) if (rule.inCode && !rule.registered) await savePageRule(rule.key, {});
    for (const rule of endpoints) if (rule.inCode && !rule.registered) await saveEndpointRule(rule.key, {});
  }, [pages, endpoints, savePageRule, saveEndpointRule]);

  return {
    capabilities,
    canWrite: capabilities.isSuperAdmin,
    loading,
    error,
    reload,
    pages,
    endpoints,
    actions,
    unregisteredCount,
    editing,
    openRule: setEditing,
    closeRule: () => setEditing(null),
    savePageRule,
    saveEndpointRule,
    register,
    registerAllMissing,
  };
}
