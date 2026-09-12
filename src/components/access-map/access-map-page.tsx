"use client";

/**
 * Access Map: which actions gate each page, quick action and API endpoint.
 *
 * Two tables under one frame. Every row is a thing the code ships (from the
 * page and endpoint registries) joined with its rule in the database; a row
 * with no rule yet is marked "Not registered" and can be registered with the
 * code's defaults in one click. Editing opens the rule drawer. Only a
 * super-admin may save; everyone with `can_manage_access_map` may look.
 */

import { useMemo } from "react";
import { Alert, Button, Segmented, Spin, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ApartmentOutlined, CloudServerOutlined, EditOutlined, PlusCircleOutlined, ReloadOutlined, ThunderboltOutlined } from "@ant-design/icons";
import Figures from "@/components/figures";
import { ListPageFrame, ListPanel, ListTableRegion } from "@/components/list-page-frame";
import { RibbonBar, RibbonButton } from "@/components/ribbon-bar";
import { presentationFor } from "@/components/shell/definitions";
import StatCard from "@/components/stat-card";
import { categoryLabel } from "@/components/user-management/access-meta";
import { useAccessMapStore, type RuleTarget } from "@/lib/admin-access/access-map-store";
import type { AdminCapabilities, EndpointRule, PageRule } from "@/lib/admin-access/types";
import { formatRelativeTime, pluralise } from "@/lib/format";
import { featureColors, surfaceColors } from "@/lib/theme/colors";
import RuleDrawer from "./rule-drawer";
import { ACCESS_MAP_COLOR, AUTH_KIND_LABELS, authKindNotGatedHelp, MethodTag, RuleSummary } from "./rule-meta";
import { useState } from "react";

type View = "pages" | "endpoints";

export default function AccessMapPage({ capabilities }: { capabilities: AdminCapabilities }) {
  const store = useAccessMapStore(capabilities);
  const [view, setView] = useState<View>("pages");
  const [registering, setRegistering] = useState(false);

  const pageColumns: ColumnsType<PageRule> = [
    {
      title: "Page",
      key: "page",
      render: (_value, rule) => {
        const { icon: Icon, color } = presentationFor(rule.key);
        return (
          <span className="flex items-center gap-3">
            <Icon style={{ fontSize: 18, color: featureColors[color], flexShrink: 0 }} />
            <span className="flex min-w-0 flex-col">
              <span className="flex items-center gap-2">
                <Button type="link" className="!h-auto !px-0" style={{ color: surfaceColors.text, fontWeight: 500 }} onClick={() => store.openRule({ kind: "page", rule })}>
                  {rule.name}
                </Button>
                {rule.kind === "quick_action" && (
                  <Tag icon={<ThunderboltOutlined />} style={{ marginInlineEnd: 0 }}>
                    Quick action
                  </Tag>
                )}
                {!rule.inCode && (
                  <Tooltip title="A database row whose key the running code does not ship. Harmless; delete it in SQL when convenient.">
                    <Tag color="default" style={{ marginInlineEnd: 0 }}>Not in code</Tag>
                  </Tooltip>
                )}
              </span>
              <span className="text-xs" style={{ color: surfaceColors.textTertiary }}>
                {rule.path ? <code>{rule.path}</code> : <code>{rule.key}</code>}
                {rule.description ? ` · ${rule.description}` : ""}
              </span>
            </span>
          </span>
        );
      },
    },
    {
      title: "Who may open it",
      key: "rule",
      width: 380,
      render: (_value, rule) => <RuleSummary rule={rule} registered={rule.registered} actions={store.actions} />,
    },
    {
      title: "Order",
      dataIndex: "navOrder",
      width: 80,
      align: "right",
      render: (value: number) => <span className="tabular-nums" style={{ color: surfaceColors.textSecondary }}>{value}</span>,
    },
    {
      title: "Updated",
      dataIndex: "updatedAt",
      width: 130,
      render: (value: string | null) => (
        <span style={{ color: surfaceColors.textTertiary }}>{value ? formatRelativeTime(value) : "—"}</span>
      ),
    },
    {
      title: "",
      key: "actions",
      width: 120,
      align: "right",
      render: (_value, rule) => rowActions({ kind: "page", rule }),
    },
  ];

  const endpointColumns: ColumnsType<EndpointRule> = [
    {
      title: "Endpoint",
      key: "endpoint",
      render: (_value, rule) => (
        <span className="flex items-center gap-3">
          <MethodTag method={rule.method} />
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2">
              <Button type="link" className="!h-auto !px-0" style={{ color: surfaceColors.text, fontWeight: 500 }} onClick={() => store.openRule({ kind: "endpoint", rule })}>
                {rule.name}
              </Button>
              {!rule.inCode && <Tag style={{ marginInlineEnd: 0 }}>Not in code</Tag>}
            </span>
            <code className="text-xs" style={{ color: surfaceColors.textTertiary }}>{rule.path}</code>
          </span>
        </span>
      ),
    },
    {
      title: "Area",
      dataIndex: "category",
      width: 140,
      render: (value: string) => <span style={{ color: surfaceColors.textSecondary }}>{categoryLabel(value)}</span>,
    },
    {
      title: "Credential",
      dataIndex: "authKind",
      width: 110,
      render: (value: EndpointRule["authKind"]) => <Tag style={{ marginInlineEnd: 0 }}>{AUTH_KIND_LABELS[value]}</Tag>,
    },
    {
      title: "Who may call it",
      key: "rule",
      width: 360,
      render: (_value, rule) =>
        rule.authKind === "admin" ? (
          <RuleSummary rule={rule} registered={rule.registered} actions={store.actions} />
        ) : (
          <Tooltip title={authKindNotGatedHelp(rule.authKind)}>
            <span style={{ color: surfaceColors.textTertiary }}>Not gated by the map</span>
          </Tooltip>
        ),
    },
    {
      title: "",
      key: "actions",
      width: 120,
      align: "right",
      render: (_value, rule) => rowActions({ kind: "endpoint", rule }),
    },
  ];

  function rowActions(target: RuleTarget) {
    return (
      <span className="flex items-center justify-end gap-1">
        {target.rule.inCode && !target.rule.registered && store.canWrite && (
          <Tooltip title="Write the row with the code's defaults">
            <Button size="small" icon={<PlusCircleOutlined />} onClick={() => void store.register(target)}>
              Register
            </Button>
          </Tooltip>
        )}
        <Tooltip title={store.canWrite ? "Edit rule" : "View rule"}>
          <Button type="text" size="small" icon={<EditOutlined />} aria-label={`Open ${target.rule.name}`} onClick={() => store.openRule(target)} />
        </Tooltip>
      </span>
    );
  }

  const counts = useMemo(() => {
    const summarise = (rules: readonly (PageRule | EndpointRule)[]) => ({
      total: rules.filter((rule) => rule.inCode).length,
      superOnly: rules.filter((rule) => rule.inCode && rule.registered && rule.requireSuperAdmin).length,
      anyOperator: rules.filter((rule) => rule.inCode && rule.registered && !rule.requireSuperAdmin && rule.actionKeys.length === 0 && rule.isEnabled).length,
      byAction: rules.filter((rule) => rule.inCode && rule.registered && !rule.requireSuperAdmin && rule.actionKeys.length > 0 && rule.isEnabled).length,
      disabled: rules.filter((rule) => rule.inCode && rule.registered && !rule.isEnabled).length,
      unregistered: rules.filter((rule) => rule.inCode && !rule.registered).length,
    });
    return { pages: summarise(store.pages), endpoints: summarise(store.endpoints.filter((rule) => rule.authKind === "admin")) };
  }, [store.pages, store.endpoints]);

  const current = view === "pages" ? counts.pages : counts.endpoints;

  const figures = (
    <Figures
      label="Access map totals"
      figures={[
        { label: "Pages", value: `${counts.pages.total}`, tooltip: "Pages and quick actions the code ships." },
        { label: "Endpoints", value: `${counts.endpoints.total}`, tooltip: "Operator endpoints gated by the map." },
        {
          label: "Unregistered",
          value: `${store.unregisteredCount}`,
          color: store.unregisteredCount > 0 ? featureColors.incomeBills : undefined,
          tooltip: "Entries with no database row yet: super-admin only until registered.",
          separatorBefore: true,
        },
      ]}
    />
  );

  const rail = (
    <StatCard
      title={view === "pages" ? "Pages by rule" : "Endpoints by rule"}
      icon={view === "pages" ? <ApartmentOutlined style={{ color: ACCESS_MAP_COLOR }} /> : <CloudServerOutlined style={{ color: ACCESS_MAP_COLOR }} />}
      total={current.total}
      rows={[
        { label: "By action", value: current.byAction, color: ACCESS_MAP_COLOR, tooltip: "An operator needs one of the listed actions." },
        { label: "Any operator", value: current.anyOperator, color: featureColors.goal, tooltip: "No action required." },
        { label: "Super-admin only", value: current.superOnly, color: "#D4A017" },
        { label: "Disabled", value: current.disabled, color: featureColors.neutral },
        { label: "Unregistered", value: current.unregistered, color: featureColors.incomeBills },
      ]}
      footnote="Super-admins pass every rule. Everything else is denied unless a rule allows it."
    />
  );

  const ribbon = (
    <RibbonBar
      trailing={
        <span className="shrink-0 pr-1 text-[11px] tabular-nums" style={{ color: surfaceColors.textSecondary }}>
          {view === "pages" ? pluralise(store.pages.length, "entry", "entries") : pluralise(store.endpoints.length, "endpoint")}
        </span>
      }
    >
      <RibbonButton
        label="Register Missing"
        icon={<PlusCircleOutlined />}
        disabled={!store.canWrite || store.unregisteredCount === 0 || registering}
        tooltip={
          !store.canWrite
            ? "Only a super-admin can change the access map"
            : store.unregisteredCount === 0
              ? "Everything the code ships has a row"
              : `Write rows for ${pluralise(store.unregisteredCount, "unregistered entry", "unregistered entries")} with the code's defaults`
        }
        onClick={() => {
          setRegistering(true);
          void store.registerAllMissing().finally(() => setRegistering(false));
        }}
      />
      <RibbonButton label="Refresh" icon={<ReloadOutlined />} onClick={store.reload} tooltip="Reload from the server" />
    </RibbonBar>
  );

  let body: React.ReactNode;
  if (store.loading) {
    body = (
      <ListPanel>
        <div className="flex items-center justify-center py-16">
          <Spin />
        </div>
      </ListPanel>
    );
  } else if (store.error !== null && store.pages.length === 0) {
    body = (
      <Alert
        type="error"
        showIcon
        title="The access map could not be loaded."
        description={store.error}
        action={<Button size="small" onClick={store.reload}>Retry</Button>}
      />
    );
  } else {
    body = (
      <>
        {store.error !== null && <Alert type="warning" showIcon closable title={store.error} />}
        <ListTableRegion>
          {(y) => (
            <ListPanel>
              {view === "pages" ? (
                <Table<PageRule> dataSource={store.pages} rowKey="key" columns={pageColumns} size="middle" pagination={false} scroll={{ x: 960, y }} />
              ) : (
                <Table<EndpointRule> dataSource={store.endpoints} rowKey="key" columns={endpointColumns} size="middle" pagination={false} scroll={{ x: 1040, y }} />
              )}
            </ListPanel>
          )}
        </ListTableRegion>
      </>
    );
  }

  return (
    <>
      <ListPageFrame
        title="Access Map"
        caption="Who may open each page and call each endpoint. Rules live in the admin database; the code only lists what exists."
        figures={store.loading ? undefined : figures}
        ribbon={ribbon}
        rail={store.loading ? undefined : rail}
      >
        <span role="group" aria-label="Section">
          <Segmented<View>
            value={view}
            onChange={setView}
            options={[
              { value: "pages", label: "Pages & quick actions", icon: <ApartmentOutlined /> },
              { value: "endpoints", label: "API endpoints", icon: <CloudServerOutlined /> },
            ]}
          />
        </span>
        {body}
      </ListPageFrame>

      <RuleDrawer
        target={store.editing}
        actions={store.actions}
        readOnly={!store.canWrite}
        onClose={store.closeRule}
        onSavePage={store.savePageRule}
        onSaveEndpoint={store.saveEndpointRule}
      />
    </>
  );
}
