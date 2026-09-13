"use client";

/**
 * Services: every API endpoint the app ships, with what it does, who may call
 * it, how it is rate limited, and how much it has been used. Read-only; rules
 * are edited on the Access Map.
 */

import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, Segmented, Spin, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { CloudServerOutlined, ReloadOutlined } from "@ant-design/icons";
import Link from "next/link";
import { RuleSummary, AUTH_KIND_LABELS, MethodTag, SERVICES_COLOR } from "@/components/access-map/rule-meta";
import Figures from "@/components/figures";
import { ListPageFrame, ListPanel, ListTableRegion } from "@/components/list-page-frame";
import { ResponsiveTable } from "@/components/responsive-table";
import { RibbonBar, RibbonButton } from "@/components/ribbon-bar";
import StatCard from "@/components/stat-card";
import { categoryLabel } from "@/components/user-management/access-meta";
import { adminAccessApi, onAdminAccessChanged, type RateLimitPresets } from "@/lib/admin-access/client";
import type { AdminAction, AdminCapabilities, EndpointRule, EndpointUsageSummary } from "@/lib/admin-access/types";
import { errorMessage, formatRelativeTimeOrNever, pluralise } from "@/lib/format";
import { featureColors, surfaceColors } from "@/lib/theme/colors";

interface ServiceRow extends EndpointRule {
  usage: EndpointUsageSummary | null;
}

function describeRateLimit(policy: string, presets: RateLimitPresets): string {
  const preset = presets[policy];
  if (!preset) return policy;
  const minutes = preset.windowMs / 60_000;
  const window = minutes < 1 ? `${preset.windowMs / 1000} s` : minutes === 1 ? "minute" : `${minutes} min`;
  return `${preset.limit} / ${window}`;
}

export default function ServicesPage({ capabilities }: { capabilities: AdminCapabilities }) {
  const [endpoints, setEndpoints] = useState<EndpointRule[]>([]);
  const [actions, setActions] = useState<AdminAction[]>([]);
  const [usage, setUsage] = useState<EndpointUsageSummary[]>([]);
  const [presets, setPresets] = useState<RateLimitPresets>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("all");

  const reload = () => {
    setError(null);
    setTick((value) => value + 1);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextEndpoints, nextUsage] = await Promise.all([adminAccessApi.listEndpointRules(), adminAccessApi.listUsage()]);
        // The catalog is optional: without can_manage_roles / access map the
        // rule column falls back to raw keys.
        const nextActions = await adminAccessApi.listActions().catch(() => [] as AdminAction[]);
        if (cancelled) return;
        setEndpoints(nextEndpoints);
        setUsage(nextUsage.usage);
        setPresets(nextUsage.rateLimits);
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

  useEffect(() => onAdminAccessChanged(reload), []);

  const rows = useMemo<ServiceRow[]>(() => {
    const needle = search.trim().toLowerCase();
    return endpoints
      .filter((rule) => rule.inCode)
      .filter((rule) => category === "all" || rule.category === category)
      .filter(
        (rule) =>
          needle === "" ||
          `${rule.method} ${rule.path} ${rule.name} ${rule.description ?? ""} ${rule.key}`.toLowerCase().includes(needle),
      )
      .map((rule) => ({ ...rule, usage: usage.find((entry) => entry.endpointKey === rule.key) ?? null }));
  }, [endpoints, usage, search, category]);

  const categories = useMemo(() => [...new Set(endpoints.map((rule) => rule.category))].sort(), [endpoints]);

  const totals = useMemo(() => {
    const sum = (pick: (entry: EndpointUsageSummary) => number) => usage.reduce((total, entry) => total + pick(entry), 0);
    return {
      endpoints: endpoints.filter((rule) => rule.inCode).length,
      callsToday: sum((entry) => entry.callsToday),
      calls30d: sum((entry) => entry.calls30d),
      errors30d: sum((entry) => entry.errors30d),
      denied30d: sum((entry) => entry.denied30d),
      rateLimited30d: sum((entry) => entry.rateLimited30d),
    };
  }, [endpoints, usage]);

  const columns: ColumnsType<ServiceRow> = [
    {
      title: "Endpoint",
      key: "endpoint",
      render: (_value, row) => (
        <span className="flex items-start gap-3">
          <MethodTag method={row.method} />
          <span className="flex min-w-0 flex-col">
            <span style={{ color: surfaceColors.text, fontWeight: 500 }}>{row.name}</span>
            <code className="text-xs" style={{ color: surfaceColors.textTertiary }}>{row.path}</code>
          </span>
        </span>
      ),
    },
    {
      title: "Area",
      dataIndex: "category",
      width: 130,
      render: (value: string) => <span style={{ color: surfaceColors.textSecondary }}>{categoryLabel(value)}</span>,
    },
    {
      title: "Access",
      key: "access",
      width: 300,
      render: (_value, row) => (
        <span className="flex flex-col gap-1">
          <Tag style={{ marginInlineEnd: 0, width: "fit-content" }}>{AUTH_KIND_LABELS[row.authKind]}</Tag>
          {row.authKind === "admin" && <RuleSummary rule={row} registered={row.registered} actions={actions} />}
        </span>
      ),
    },
    {
      title: "Rate limit",
      dataIndex: "rateLimit",
      width: 130,
      render: (value: string) => (
        <Tooltip title={`Preset “${value}”, per client IP; operator endpoints also charge a per-user budget.`}>
          <span className="tabular-nums" style={{ color: surfaceColors.textSecondary }}>{describeRateLimit(value, presets)}</span>
        </Tooltip>
      ),
    },
    {
      title: "Today",
      key: "today",
      width: 80,
      align: "right",
      render: (_value, row) => <Count value={row.usage?.callsToday ?? 0} />,
    },
    {
      title: "30 days",
      key: "30d",
      width: 90,
      align: "right",
      sorter: (a, b) => (a.usage?.calls30d ?? 0) - (b.usage?.calls30d ?? 0),
      render: (_value, row) => <Count value={row.usage?.calls30d ?? 0} />,
    },
    {
      title: "Errors",
      key: "errors",
      width: 80,
      align: "right",
      render: (_value, row) => (
        <Tooltip title={`30 days · 5xx: ${row.usage?.errors30d ?? 0} · denied: ${row.usage?.denied30d ?? 0} · rate limited: ${row.usage?.rateLimited30d ?? 0}`}>
          <span>
            <Count value={row.usage?.errors30d ?? 0} danger />
          </span>
        </Tooltip>
      ),
    },
    {
      title: "Avg",
      key: "avg",
      width: 80,
      align: "right",
      render: (_value, row) => (
        <span className="tabular-nums" style={{ color: surfaceColors.textSecondary }}>
          {row.usage?.avgMs30d == null ? "—" : `${row.usage.avgMs30d} ms`}
        </span>
      ),
    },
    {
      title: "Last call",
      key: "last",
      width: 130,
      render: (_value, row) => (
        <span style={{ color: row.usage?.lastCalledAt ? surfaceColors.textSecondary : surfaceColors.textTertiary }}>
          {formatRelativeTimeOrNever(row.usage?.lastCalledAt)}
        </span>
      ),
    },
  ];

  const figures = (
    <Figures
      label="Service totals"
      figures={[
        { label: "Endpoints", value: `${totals.endpoints}`, tooltip: "Route Handlers the code ships." },
        { label: "Calls today", value: `${totals.callsToday}`, color: SERVICES_COLOR, tooltip: "Since midnight UTC." },
        { label: "Calls 30d", value: `${totals.calls30d}`, tooltip: "Last 30 days." },
        { label: "Errors 30d", value: `${totals.errors30d}`, color: totals.errors30d > 0 ? featureColors.rule : undefined, tooltip: "5xx responses in the last 30 days.", separatorBefore: true },
      ]}
    />
  );

  const rail = (
    <StatCard
      title="Last 30 days"
      icon={<CloudServerOutlined style={{ color: SERVICES_COLOR }} />}
      total={Math.max(1, totals.calls30d)}
      rows={[
        { label: "Succeeded", value: Math.max(0, totals.calls30d - totals.errors30d - totals.denied30d - totals.rateLimited30d), color: SERVICES_COLOR },
        { label: "Denied (401/403)", value: totals.denied30d, color: featureColors.incomeBills },
        { label: "Rate limited (429)", value: totals.rateLimited30d, color: featureColors.budget },
        { label: "Errors (5xx)", value: totals.errors30d, color: featureColors.rule },
      ]}
      footnote="Counters are per endpoint per UTC day, written after each response. Rules are edited on the Access Map."
    />
  );

  const ribbon = (
    <RibbonBar
      trailing={
        <span className="shrink-0 pr-1 text-[11px] tabular-nums" style={{ color: surfaceColors.textSecondary }}>
          {rows.length} of {pluralise(totals.endpoints, "endpoint")}
        </span>
      }
    >
      <RibbonButton label="Refresh" icon={<ReloadOutlined />} onClick={reload} tooltip="Reload from the server" />
    </RibbonBar>
  );

  let body: React.ReactNode;
  if (loading) {
    body = (
      <ListPanel>
        <div className="flex items-center justify-center py-16">
          <Spin />
        </div>
      </ListPanel>
    );
  } else if (error !== null && endpoints.length === 0) {
    body = <Alert type="error" showIcon title="Services could not be loaded." description={error} action={<Button size="small" onClick={reload}>Retry</Button>} />;
  } else {
    body = (
      <>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* The width lives on this plain wrapper, which the search box fills: antd's own
              full-width rule on the box is unlayered and would beat a Tailwind width
              set on the box itself. Row-wide on compact, the old fixed width on desktop. */}
          <div className="w-full lg:w-[300px]">
            <Input.Search allowClear value={search} placeholder="Search path, name or key…" onChange={(event) => setSearch(event.target.value)} onSearch={setSearch} />
          </div>
          <span role="group" aria-label="Filter by category" className="max-lg:max-w-full max-lg:overflow-x-auto">
            <Segmented<string>
              value={category}
              onChange={setCategory}
              options={[{ value: "all", label: "All" }, ...categories.map((value) => ({ value, label: categoryLabel(value) }))]}
            />
          </span>
          {capabilities.isSuperAdmin && (
            <Typography.Text type="secondary" className="ms-auto text-xs">
              Edit rules on the <Link href="/access-map">Access Map</Link>.
            </Typography.Text>
          )}
        </div>
        <ListTableRegion>
          {(y) => (
            <ListPanel>
              <ResponsiveTable<ServiceRow>
                dataSource={rows}
                rowKey="key"
                columns={columns}
                size="middle"
                pagination={false}
                scroll={{ x: 1240, y }}
                expandable={{
                  expandedRowRender: (row) => (
                    <div className="flex flex-col gap-1 py-1 text-sm" style={{ color: surfaceColors.textSecondary }}>
                      <span>{row.description ?? "No description."}</span>
                      {row.notes && <span><strong>Notes:</strong> {row.notes}</span>}
                      <span className="text-xs" style={{ color: surfaceColors.textTertiary }}>
                        Key <code>{row.key}</code> · every response carries <code>x-request-id</code> and <code>Cache-Control: no-store</code>; errors use the <code>{"{ error: { code, message } }"}</code> envelope.
                      </span>
                    </div>
                  ),
                }}
              />
            </ListPanel>
          )}
        </ListTableRegion>
      </>
    );
  }

  return (
    <ListPageFrame
      title="Services"
      caption="Every API endpoint: what it does, who may call it, its rate limit and recorded usage."
      figures={loading ? undefined : figures}
      ribbon={ribbon}
      rail={loading ? undefined : rail}
    >
      {body}
    </ListPageFrame>
  );
}

function Count({ value, danger = false }: { value: number; danger?: boolean }) {
  return (
    <span
      className="tabular-nums"
      style={{ color: value === 0 ? surfaceColors.textTertiary : danger ? featureColors.rule : surfaceColors.text }}
    >
      {value}
    </span>
  );
}
