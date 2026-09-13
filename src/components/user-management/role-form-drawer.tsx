"use client";

/**
 * New / Edit role: a key (locked once created, it is the contract with code),
 * a name, a description, and the permission catalog as grouped checkboxes with
 * a select-all per group.
 */

import { useMemo, useState } from "react";
import { Alert, Button, Checkbox, Drawer, Form, Input, Space, Typography } from "antd";
import { SafetyCertificateOutlined, TagsOutlined } from "@ant-design/icons";
import { FormErrorSummary, useFormErrorSummary } from "@/components/form-error-summary";
import FormSection from "@/components/form-section";
import type {
  AdminAction,
  AdminRole,
  CreateRoleInput,
  UpdateRoleInput,
} from "@/lib/admin-access/types";
import { errorMessage, humaniseKey, trimToNull } from "@/lib/format";
import { surfaceColors } from "@/lib/theme/colors";
import { ACCESS_COLOR, categoryLabel } from "./access-meta";

const FORM_NAME = "admin-role-form";
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

interface RoleFormValues {
  key: string;
  name: string;
  description: string;
  actionKeys: string[];
}

export interface RoleFormDrawerProps {
  open: boolean;
  /** Null while creating. */
  role: AdminRole | null;
  actions: readonly AdminAction[];
  readOnly: boolean;
  onClose: () => void;
  onCreate: (input: CreateRoleInput) => Promise<unknown>;
  onUpdate: (id: string, input: UpdateRoleInput) => Promise<unknown>;
}

/** Category order as the SQL seed lists them; anything new goes at the end. */
const CATEGORY_ORDER = ["admin_access", "users", "tenants", "tickets", "catalogs"];

function groupByCategory(actions: readonly AdminAction[]): Array<[string, AdminAction[]]> {
  const groups = new Map<string, AdminAction[]>();
  for (const action of actions) {
    const list = groups.get(action.category) ?? [];
    list.push(action);
    groups.set(action.category, list);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

/** Turns `name` → `name` and the whole `name` into a snake_case key suggestion. */
function suggestKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 64);
}

function RoleFormBody({
  role,
  actions,
  readOnly,
  busy,
  error,
  onDismissError,
  onSubmit,
}: {
  role: AdminRole | null;
  actions: readonly AdminAction[];
  readOnly: boolean;
  busy: boolean;
  error: string | null;
  onDismissError: () => void;
  onSubmit: (values: RoleFormValues) => void;
}) {
  const [form] = Form.useForm<RoleFormValues>();
  // Remounted per role (`key` on this body) and unmounted on close
  // (`destroyOnHidden`), so the summary starts empty on every open.
  const { errorSummary, onFinishFailed, reset } = useFormErrorSummary();
  // The key follows the name until the person edits the key by hand.
  const [keyTouched, setKeyTouched] = useState(role !== null);

  const initialValues = useMemo<RoleFormValues>(
    () => ({
      key: role?.key ?? "",
      name: role?.name ?? "",
      description: role?.description ?? "",
      actionKeys: role?.actionKeys ?? [],
    }),
    [role],
  );

  const groups = useMemo(() => groupByCategory(actions), [actions]);
  const selected: string[] = Form.useWatch("actionKeys", form) ?? initialValues.actionKeys;

  const setGroup = (keys: string[], on: boolean) => {
    const current = new Set(form.getFieldValue("actionKeys") as string[] | undefined);
    for (const key of keys) {
      if (on) current.add(key);
      else current.delete(key);
    }
    form.setFieldValue("actionKeys", [...current]);
  };

  return (
    <Form<RoleFormValues>
      form={form}
      name={FORM_NAME}
      layout="vertical"
      disabled={busy || readOnly}
      initialValues={initialValues}
      onValuesChange={(changed: Partial<RoleFormValues>) => {
        if (changed.name !== undefined && role === null && !keyTouched) {
          form.setFieldValue("key", suggestKey(changed.name));
        }
        if (changed.key !== undefined) setKeyTouched(true);
      }}
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
      {readOnly && (
        <Alert type="info" showIcon title="Read-only. Only a super-admin can change roles." />
      )}

      <FormSection title="Role" icon={<TagsOutlined />} color={ACCESS_COLOR}>
        <Form.Item
          name="name"
          label="Name"
          rules={[{ required: true, whitespace: true }]}
        >
          <Input placeholder="e.g., Billing support" maxLength={120} />
        </Form.Item>
        <Form.Item
          name="key"
          label="Key"
          tooltip={
            role
              ? "The identifier code checks against. It cannot change once the role exists."
              : "snake_case identifier used in code and the audit log. Suggested from the name."
          }
          rules={[
            { required: true, whitespace: true },
            {
              validator: (_rule, value: string) =>
                !value || KEY_PATTERN.test(value)
                  ? Promise.resolve()
                  : Promise.reject(
                      new Error("Lowercase letters, digits and underscores, starting with a letter"),
                    ),
            },
          ]}
        >
          <Input placeholder="billing_support" maxLength={64} disabled={role !== null} />
        </Form.Item>
        <Form.Item name="description" label="Description" className="mb-0">
          <Input.TextArea rows={2} placeholder="What this role is for" maxLength={500} showCount />
        </Form.Item>
      </FormSection>

      <FormSection
        title="Actions"
        icon={<SafetyCertificateOutlined />}
        color={ACCESS_COLOR}
        extra={
          <Typography.Text type="secondary" className="text-xs tabular-nums">
            {selected.length} of {actions.length}
          </Typography.Text>
        }
      >
        <Form.Item name="actionKeys" className="mb-0" hidden>
          <Checkbox.Group options={[]} />
        </Form.Item>
        <div className="flex flex-col gap-4">
          {groups.map(([category, list]) => {
            const keys = list.map((action) => action.key);
            const checked = keys.filter((key) => selected.includes(key)).length;
            const all = checked === keys.length;
            return (
              <div key={category} className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Typography.Text strong className="text-xs tracking-wide uppercase" style={{ color: surfaceColors.textSecondary }}>
                    {categoryLabel(category)}
                  </Typography.Text>
                  {!readOnly && (
                    <Button
                      type="link"
                      size="small"
                      style={{ paddingInline: 0 }}
                      onClick={() => setGroup(keys, !all)}
                    >
                      {all ? "Clear" : "Select all"}
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {list.map((action) => (
                    <Checkbox
                      key={action.key}
                      checked={selected.includes(action.key)}
                      onChange={(event) => setGroup([action.key], event.target.checked)}
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
            );
          })}
        </div>
      </FormSection>
    </Form>
  );
}

export default function RoleFormDrawer({
  open,
  role,
  actions,
  readOnly,
  onClose,
  onCreate,
  onUpdate,
}: RoleFormDrawerProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = role !== null;
  const formKey = role?.id ?? "new-role";

  const handleSubmit = async (values: RoleFormValues) => {
    setError(null);
    setSaving(true);
    try {
      const actionKeys = [...(values.actionKeys ?? [])].sort();
      if (role === null) {
        await onCreate({
          key: values.key.trim(),
          name: values.name.trim(),
          description: trimToNull(values.description),
          actionKeys,
        });
      } else {
        const input: UpdateRoleInput = {};
        if (values.name.trim() !== role.name) input.name = values.name.trim();
        const description = trimToNull(values.description);
        if (description !== role.description) input.description = description;
        if (actionKeys.join(",") !== [...role.actionKeys].sort().join(",")) input.actionKeys = actionKeys;
        if (Object.keys(input).length > 0) await onUpdate(role.id, input);
      }
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="right"
      size={640}
      destroyOnHidden
      title={
        <span className="flex items-center gap-2">
          <TagsOutlined style={{ fontSize: 18, color: ACCESS_COLOR }} />
          <span>{isEdit ? "Edit role" : "New role"}</span>
        </span>
      }
      afterOpenChange={(opened) => {
        if (!opened) {
          setError(null);
        }
      }}
      styles={{ body: { background: surfaceColors.page } }}
      footer={
        <div className="flex items-center justify-end">
          <Space>
            <Button onClick={onClose} disabled={saving}>
              {readOnly ? "Close" : "Cancel"}
            </Button>
            {!readOnly && (
              <Button
                type="primary"
                htmlType="submit"
                form={FORM_NAME}
                disabled={saving}
                loading={saving}
              >
                {isEdit ? "Save" : "Create role"}
              </Button>
            )}
          </Space>
        </div>
      }
    >
      <RoleFormBody
        key={formKey}
        role={role}
        actions={actions}
        readOnly={readOnly}
        busy={saving}
        error={error}
        onDismissError={() => setError(null)}
        onSubmit={(values) => {
          void handleSubmit(values);
        }}
      />
    </Drawer>
  );
}
