"use client";

/**
 * Edit one rule: enabled, super-admin only, the actions of which one is
 * enough, and the catalog text (name, description, order or notes). One
 * drawer for pages, quick actions and endpoints; the page kind only changes
 * which extra fields appear.
 */

import { useMemo, useState } from "react";
import { Alert, Button, Checkbox, Drawer, Form, Input, InputNumber, Space, Switch, Typography } from "antd";
import { ApartmentOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { FormErrorSummary, useFormErrorSummary } from "@/components/form-error-summary";
import FormSection from "@/components/form-section";
import { categoryLabel } from "@/components/user-management/access-meta";
import type { RuleTarget } from "@/lib/admin-access/access-map-store";
import type { AdminAction, UpsertEndpointRuleInput, UpsertPageRuleInput } from "@/lib/admin-access/types";
import { errorMessage, humaniseKey, trimToNull } from "@/lib/format";
import { surfaceColors } from "@/lib/theme/colors";
import { ACCESS_MAP_COLOR, AUTH_KIND_HELP, MethodTag } from "./rule-meta";

const FORM_NAME = "access-rule-form";

interface RuleFormValues {
  name: string;
  description: string;
  notes: string;
  navOrder: number;
  isEnabled: boolean;
  requireSuperAdmin: boolean;
  actionKeys: string[];
}

export interface RuleDrawerProps {
  target: RuleTarget | null;
  actions: readonly AdminAction[];
  readOnly: boolean;
  onClose: () => void;
  onSavePage: (key: string, input: UpsertPageRuleInput) => Promise<unknown>;
  onSaveEndpoint: (key: string, input: UpsertEndpointRuleInput) => Promise<unknown>;
}

function groupByCategory(actions: readonly AdminAction[]): Array<[string, AdminAction[]]> {
  const groups = new Map<string, AdminAction[]>();
  for (const action of actions) {
    const list = groups.get(action.category) ?? [];
    list.push(action);
    groups.set(action.category, list);
  }
  return [...groups.entries()];
}

function RuleFormBody({
  target,
  actions,
  readOnly,
  busy,
  error,
  onDismissError,
  onSubmit,
}: {
  target: RuleTarget;
  actions: readonly AdminAction[];
  readOnly: boolean;
  busy: boolean;
  error: string | null;
  onDismissError: () => void;
  onSubmit: (values: RuleFormValues) => void;
}) {
  const [form] = Form.useForm<RuleFormValues>();
  // Remounted per target (`key` on this body) and unmounted on close
  // (`destroyOnHidden`), so the summary starts empty on every open.
  const { errorSummary, onFinishFailed, reset } = useFormErrorSummary();
  const { rule } = target;

  const initialValues = useMemo<RuleFormValues>(
    () => ({
      name: rule.name,
      description: rule.description ?? "",
      notes: target.kind === "endpoint" ? (target.rule.notes ?? "") : "",
      navOrder: target.kind === "page" ? target.rule.navOrder : 0,
      isEnabled: rule.isEnabled,
      requireSuperAdmin: rule.requireSuperAdmin,
      actionKeys: rule.actionKeys,
    }),
    [target, rule],
  );

  const groups = useMemo(() => groupByCategory(actions), [actions]);
  const selected: string[] = Form.useWatch("actionKeys", form) ?? initialValues.actionKeys;
  const superOnly: boolean = Form.useWatch("requireSuperAdmin", form) ?? initialValues.requireSuperAdmin;
  const enabled: boolean = Form.useWatch("isEnabled", form) ?? initialValues.isEnabled;

  const toggle = (key: string, on: boolean) => {
    const current = new Set(form.getFieldValue("actionKeys") as string[] | undefined);
    if (on) current.add(key);
    else current.delete(key);
    form.setFieldValue("actionKeys", [...current]);
  };

  const informational = target.kind === "endpoint" && target.rule.authKind !== "admin";

  return (
    <Form<RuleFormValues>
      form={form}
      name={FORM_NAME}
      layout="vertical"
      disabled={busy || readOnly}
      initialValues={initialValues}
      onFinish={(values) => {
        reset();
        onSubmit(values);
      }}
      onFinishFailed={onFinishFailed}
      className="flex flex-col gap-4"
    >
      <FormErrorSummary summary={errorSummary} onClose={reset} />

      {error === null ? null : (
        <Alert type="error" showIcon title={error} closable={{ onClose: onDismissError }} />
      )}
      {readOnly && <Alert type="info" showIcon title="Read-only. Only a super-admin can change the access map." />}
      {!rule.registered && (
        <Alert
          type="warning"
          showIcon
          title="Not registered yet"
          description="These are the code's defaults. Saving writes the row, after which the rule applies to everyone but super-admins."
        />
      )}
      {informational && target.kind === "endpoint" && (
        <Alert type="info" showIcon title={AUTH_KIND_HELP[target.rule.authKind]} />
      )}

      <FormSection title="Rule" icon={<SafetyCertificateOutlined />} color={ACCESS_MAP_COLOR}>
        <div className="flex flex-col gap-3">
          <Form.Item name="isEnabled" valuePropName="checked" className="mb-0">
            <Switch checkedChildren="Enabled" unCheckedChildren="Disabled" />
          </Form.Item>
          {!enabled && (
            <Typography.Text type="secondary" className="text-xs">
              Disabled: hidden from everyone but super-admins{target.kind === "endpoint" ? "; the endpoint answers 503 endpoint_disabled" : ""}.
            </Typography.Text>
          )}
          <Form.Item name="requireSuperAdmin" valuePropName="checked" className="mb-0" label="Super-admin only">
            <Switch />
          </Form.Item>
          <Typography.Text type="secondary" className="text-xs">
            {superOnly
              ? "Only super-admins, whatever actions are ticked below."
              : selected.length === 0
                ? "No action ticked: every enabled operator may use it."
                : "An operator needs ANY ONE of the ticked actions. Super-admins always pass."}
          </Typography.Text>
        </div>
      </FormSection>

      <FormSection
        title="Required actions (any one)"
        icon={<ApartmentOutlined />}
        color={ACCESS_MAP_COLOR}
        extra={
          <Typography.Text type="secondary" className="text-xs tabular-nums">
            {selected.length} ticked
          </Typography.Text>
        }
      >
        <Form.Item name="actionKeys" hidden className="mb-0">
          <Checkbox.Group options={[]} />
        </Form.Item>
        <div className="flex flex-col gap-4" style={{ opacity: superOnly ? 0.5 : 1 }}>
          {groups.map(([category, list]) => (
            <div key={category} className="flex flex-col gap-1.5">
              <Typography.Text strong className="text-xs tracking-wide uppercase" style={{ color: surfaceColors.textSecondary }}>
                {categoryLabel(category)}
              </Typography.Text>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {list.map((action) => (
                  <Checkbox
                    key={action.key}
                    checked={selected.includes(action.key)}
                    disabled={busy || readOnly || superOnly}
                    onChange={(event) => toggle(action.key, event.target.checked)}
                  >
                    <span className="flex flex-col">
                      <span className="text-sm">{humaniseKey(action.key.replace(/^can_/, ""))}</span>
                      <span className="text-xs" style={{ color: surfaceColors.textTertiary }}>
                        {action.description}
                      </span>
                    </span>
                  </Checkbox>
                ))}
              </div>
            </div>
          ))}
        </div>
      </FormSection>

      <FormSection title="Catalog" icon={<ApartmentOutlined />} color={ACCESS_MAP_COLOR}>
        <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true }]}>
          <Input maxLength={120} />
        </Form.Item>
        <Form.Item name="description" label="Description">
          <Input.TextArea rows={2} maxLength={target.kind === "endpoint" ? 1000 : 500} showCount />
        </Form.Item>
        {target.kind === "page" ? (
          <Form.Item
            name="navOrder"
            label={target.rule.kind === "page" ? "Order on the rail" : "Order in the New menu"}
            className="mb-0"
            tooltip="Ascending. Leave gaps (10, 20, 30) so something can go between later."
          >
            <InputNumber min={0} max={10_000} style={{ width: 160 }} />
          </Form.Item>
        ) : (
          <Form.Item name="notes" label="Operator notes" className="mb-0" tooltip="Caveats, owners, links. Shown on the Services page.">
            <Input.TextArea rows={3} maxLength={2000} showCount />
          </Form.Item>
        )}
      </FormSection>

      <div className="px-1 text-xs" style={{ color: surfaceColors.textTertiary }}>
        Key: <code>{rule.key}</code>
        {target.kind === "page" && target.rule.path ? <> · Route: <code>{target.rule.path}</code></> : null}
        {target.kind === "endpoint" ? (
          <>
            {" "}· <MethodTag method={target.rule.method} /> <code>{target.rule.path}</code> · Rate limit preset:{" "}
            <code>{target.rule.rateLimit}</code>
          </>
        ) : null}
      </div>
    </Form>
  );
}

export default function RuleDrawer({ target, actions, readOnly, onClose, onSavePage, onSaveEndpoint }: RuleDrawerProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep the last target on display while the drawer slides out.
  const [display, setDisplay] = useState<RuleTarget | null>(target);
  if (target !== null && target !== display) setDisplay(target);

  const handleSubmit = async (values: RuleFormValues) => {
    if (!display) return;
    setError(null);
    setSaving(true);
    try {
      const actionKeys = [...new Set(values.actionKeys ?? [])].sort();
      if (display.kind === "page") {
        await onSavePage(display.rule.key, {
          name: values.name.trim(),
          description: trimToNull(values.description),
          navOrder: values.navOrder,
          isEnabled: values.isEnabled,
          requireSuperAdmin: values.requireSuperAdmin,
          actionKeys,
        });
      } else {
        await onSaveEndpoint(display.rule.key, {
          name: values.name.trim(),
          description: trimToNull(values.description),
          notes: trimToNull(values.notes),
          isEnabled: values.isEnabled,
          requireSuperAdmin: values.requireSuperAdmin,
          actionKeys,
        });
      }
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const title =
    display === null
      ? "Rule"
      : display.kind === "page"
        ? `${display.rule.kind === "page" ? "Page" : "Quick action"}: ${display.rule.name}`
        : `Endpoint: ${display.rule.name}`;

  return (
    <Drawer
      open={target !== null}
      onClose={onClose}
      afterOpenChange={(open) => {
        if (!open) {
          setDisplay(null);
          setError(null);
        }
      }}
      placement="right"
      size={640}
      destroyOnHidden
      title={
        <span className="flex items-center gap-2">
          <ApartmentOutlined style={{ fontSize: 18, color: ACCESS_MAP_COLOR }} />
          <span>{title}</span>
        </span>
      }
      styles={{ body: { background: surfaceColors.page } }}
      footer={
        <div className="flex items-center justify-end">
          <Space>
            <Button onClick={onClose} disabled={saving}>
              {readOnly ? "Close" : "Cancel"}
            </Button>
            {!readOnly && (
              <Button type="primary" htmlType="submit" form={FORM_NAME} loading={saving}>
                {display && !display.rule.registered ? "Register and save" : "Save"}
              </Button>
            )}
          </Space>
        </div>
      }
    >
      {display === null ? null : (
        <RuleFormBody
          key={`${display.kind}:${display.rule.key}`}
          target={display}
          actions={actions}
          readOnly={readOnly}
          busy={saving}
          error={error}
          onDismissError={() => setError(null)}
          onSubmit={(values) => {
            void handleSubmit(values);
          }}
        />
      )}
    </Drawer>
  );
}
