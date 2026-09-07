"use client";

/**
 * Add / edit one reference row.
 *
 * One drawer for all four catalogs: the chrome, the footer and the error
 * handling are identical, and only the fields between them change, so the kind
 * picks a field set rather than a whole component. It follows the User
 * Management form's conventions — a `FormSection` block, Save in the footer
 * submitting by form association, the failure shown in the form rather than a
 * toast.
 *
 * The drawer calls the API itself. `constantsApi` announces every write on
 * `window`, and the page listens, so there is no callback to thread back for
 * the reload; the page is only told what to say in its toast.
 */

import { useMemo, useRef, useState } from "react";
import { Alert, AutoComplete, Button, Drawer, Form, Input, Select, Space, Typography } from "antd";
import { DatabaseOutlined } from "@ant-design/icons";
import FormSection from "@/components/form-section";
import { constantsApi } from "@/lib/constants/client";
import type {
  CategoryInput,
  CategoryRow,
  CategoryType,
  ConstantKind,
  ConstantPatchOf,
  ConstantRowOf,
  CountryInput,
  CurrencyInput,
  CurrencyRow,
  FinancialInstitutionInput,
} from "@/lib/constants/types";
import { CATEGORY_TYPES } from "@/lib/constants/types";
import { errorMessage, trimToNull } from "@/lib/format";
import { surfaceColors } from "@/lib/theme/colors";
import { categoryPath, CONSTANTS_COLOR, isCategoryType, KIND_META } from "./constants-meta";

/** Save lives in the footer, outside the form, and submits by association. */
const FORM_NAME = "constant-form";

/** Which catalog is being edited, and the row when it is an edit. */
export type ConstantFormTarget = {
  [K in ConstantKind]: { kind: K; row: ConstantRowOf<K> | null };
}[ConstantKind];

/** The three states of a category's discretionary flag, as a Select. */
type Discretionary = "yes" | "no" | "unset";

const DISCRETIONARY_OPTIONS = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "unset", label: "Not set" },
];

function toDiscretionary(value: boolean | null): Discretionary {
  return value === null ? "unset" : value ? "yes" : "no";
}

function fromDiscretionary(value: Discretionary | undefined): boolean | null {
  return value === "yes" ? true : value === "no" ? false : null;
}

/** Every field any kind can have; only the mounted ones are ever filled in. */
interface ConstantFormValues {
  name: string;
  alpha2Code: string;
  alpha3Code: string;
  currencyId: string | null;
  code: string;
  symbol: string;
  institutionNumber: string;
  institutionType: string;
  categoryType: CategoryType | null;
  parentId: string | null;
  discretionary: Discretionary;
}

const upper = (value: unknown) => (typeof value === "string" ? value.toUpperCase() : value);

export interface ConstantFormDrawerProps {
  /** Null closes the drawer. */
  target: ConstantFormTarget | null;
  currencies: readonly CurrencyRow[];
  /** Set when the currency catalog failed to load; disables the country form's Currency field. */
  currenciesError: string | null;
  categories: readonly CategoryRow[];
  /** Distinct types already in the institution catalog, for the autocomplete. */
  institutionTypes: readonly string[];
  onClose: () => void;
  /** A sentence for the page's toast, after the write went through. */
  onSaved: (summary: string) => void;
}

/* -------------------------------------------------------------------------- */
/* The fields                                                                 */
/* -------------------------------------------------------------------------- */

function FormBody({
  target,
  currencies,
  currenciesError,
  categories,
  institutionTypes,
  busy,
  error,
  onDismissError,
  onSubmit,
  onInvalid,
}: {
  target: ConstantFormTarget;
  currencies: readonly CurrencyRow[];
  currenciesError: string | null;
  categories: readonly CategoryRow[];
  institutionTypes: readonly string[];
  busy: boolean;
  error: string | null;
  onDismissError: () => void;
  /**
   * `touchedFields` names what the operator actually changed, per antd's
   * `onValuesChange`; the initial mount from `target.row` does not count. The
   * category Type field relies on this: its stored value may be free text
   * outside `CATEGORY_TYPES`, so an untouched field must never be sent in the
   * patch even though the Select cannot display that raw value.
   */
  onSubmit: (values: ConstantFormValues, touchedFields: ReadonlySet<string>) => void;
  onInvalid: () => void;
}) {
  const [form] = Form.useForm<ConstantFormValues>();
  const touchedFieldsRef = useRef<Set<string>>(new Set());

  const initialValues = useMemo<Partial<ConstantFormValues>>(() => {
    switch (target.kind) {
      case "countries":
        return {
          name: target.row?.name ?? "",
          alpha2Code: target.row?.alpha2Code ?? "",
          alpha3Code: target.row?.alpha3Code ?? "",
          currencyId: target.row?.currencyId ?? null,
        };
      case "currencies":
        return {
          code: target.row?.code ?? "",
          name: target.row?.name ?? "",
          symbol: target.row?.symbol ?? "",
        };
      case "financial_institutions":
        return {
          name: target.row?.name ?? "",
          institutionNumber: target.row?.institutionNumber ?? "",
          institutionType: target.row?.type ?? "",
        };
      case "categories": {
        const storedType = target.row?.type ?? null;
        return {
          name: target.row?.name ?? "",
          // A stored value outside `CATEGORY_TYPES` cannot be shown by this
          // Select; the field starts at "Not set" rather than crashing, and
          // `categoryTypeIsUnknown` below keeps the operator from mistaking
          // that for the row actually having no type.
          categoryType: isCategoryType(storedType) ? storedType : null,
          parentId: target.row?.parentId ?? null,
          discretionary: toDiscretionary(target.row?.isDiscretionary ?? null),
        };
      }
    }
  }, [target]);

  // True when the stored type exists but is not one the form offers: the
  // Select shows "Not set" for it, so the field needs its own note, and the
  // submit handler must not send `type` unless the operator touches it.
  const categoryTypeIsUnknown =
    target.kind === "categories" &&
    target.row !== null &&
    target.row.type !== null &&
    !isCategoryType(target.row.type);

  const currencyOptions = useMemo(
    () =>
      [...currencies]
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((currency) => ({
          value: currency.id,
          label: `${currency.code} · ${currency.name}`,
        })),
    [currencies],
  );

  // A category cannot be its own parent. Deeper cycles and retired parents are
  // the API's call; it answers 409/422 and the drawer shows what it said.
  const parentOptions = useMemo(
    () =>
      categories
        .filter((candidate) => candidate.deletedAt === null && candidate.id !== target.row?.id)
        .map((candidate) => ({ value: candidate.id, label: categoryPath(candidate, categories) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [categories, target],
  );

  const typeOptions = useMemo(
    () => institutionTypes.map((type) => ({ value: type })),
    [institutionTypes],
  );

  const meta = KIND_META[target.kind];

  return (
    <Form<ConstantFormValues>
      form={form}
      name={FORM_NAME}
      layout="vertical"
      requiredMark
      disabled={busy}
      initialValues={initialValues}
      onValuesChange={(changedValues) => {
        for (const key of Object.keys(changedValues)) touchedFieldsRef.current.add(key);
      }}
      onFinish={(values) => onSubmit(values, touchedFieldsRef.current)}
      onFinishFailed={onInvalid}
      scrollToFirstError
      className="flex flex-col gap-4"
    >
      {error === null ? null : (
        <Alert type="error" showIcon title={error} closable={{ onClose: onDismissError }} />
      )}

      <FormSection
        title={meta.singular.replace(/^./, (letter) => letter.toUpperCase())}
        icon={<DatabaseOutlined />}
        color={CONSTANTS_COLOR}
      >
        {target.kind === "countries" && (
          <>
            <Form.Item
              name="name"
              label="Name"
              rules={[{ required: true, whitespace: true, message: "Name is required" }]}
            >
              <Input placeholder="e.g., Canada" maxLength={120} autoComplete="off" />
            </Form.Item>

            <Form.Item
              name="alpha2Code"
              label="Alpha-2 code"
              tooltip="The two-letter ISO 3166-1 code, e.g. CA."
              normalize={upper}
              rules={[
                { required: true, whitespace: true, message: "Alpha-2 is required" },
                { pattern: /^[A-Z]{2}$/, message: "Two letters, e.g. CA" },
              ]}
            >
              <Input placeholder="CA" maxLength={2} autoComplete="off" style={{ width: 140 }} />
            </Form.Item>

            <Form.Item
              name="alpha3Code"
              label="Alpha-3 code"
              tooltip="The three-letter ISO 3166-1 code, e.g. CAN."
              normalize={upper}
              rules={[
                { required: true, whitespace: true, message: "Alpha-3 is required" },
                { pattern: /^[A-Z]{3}$/, message: "Three letters, e.g. CAN" },
              ]}
            >
              <Input placeholder="CAN" maxLength={3} autoComplete="off" style={{ width: 140 }} />
            </Form.Item>

            <Form.Item
              name="currencyId"
              label="Currency"
              className="mb-0"
              tooltip="The country's default currency. Pushing the country pushes this currency first."
              help={
                currenciesError !== null
                  ? "Currencies could not be loaded, so this field is disabled to avoid saving it as empty."
                  : undefined
              }
              validateStatus={currenciesError !== null ? "warning" : undefined}
            >
              <Select
                allowClear
                showSearch
                disabled={currenciesError !== null}
                placeholder="No currency"
                options={currencyOptions}
                optionFilterProp="label"
                notFoundContent="No currency matches"
              />
            </Form.Item>
          </>
        )}

        {target.kind === "currencies" && (
          <>
            <Form.Item
              name="code"
              label="Code"
              tooltip="The three-letter ISO 4217 code, e.g. CAD."
              normalize={upper}
              rules={[
                { required: true, whitespace: true, message: "Code is required" },
                { pattern: /^[A-Z]{3}$/, message: "Three letters, e.g. CAD" },
              ]}
            >
              <Input placeholder="CAD" maxLength={3} autoComplete="off" style={{ width: 140 }} />
            </Form.Item>

            <Form.Item
              name="name"
              label="Name"
              rules={[{ required: true, whitespace: true, message: "Name is required" }]}
            >
              <Input placeholder="e.g., Canadian dollar" maxLength={120} autoComplete="off" />
            </Form.Item>

            <Form.Item
              name="symbol"
              label="Symbol"
              className="mb-0"
              tooltip="Optional. Shown next to amounts, e.g. $."
            >
              <Input placeholder="$" maxLength={8} autoComplete="off" style={{ width: 140 }} />
            </Form.Item>
          </>
        )}

        {target.kind === "financial_institutions" && (
          <>
            <Form.Item
              name="name"
              label="Name"
              rules={[{ required: true, whitespace: true, message: "Name is required" }]}
            >
              <Input placeholder="e.g., Royal Bank of Canada" maxLength={160} autoComplete="off" />
            </Form.Item>

            <Form.Item
              name="institutionNumber"
              label="Institution number"
              tooltip="Digits only, as the clearing system writes it."
              rules={[
                { required: true, whitespace: true, message: "Institution number is required" },
                { pattern: /^\d{1,10}$/, message: "Digits only" },
              ]}
            >
              <Input
                placeholder="003"
                maxLength={10}
                inputMode="numeric"
                autoComplete="off"
                style={{ width: 180 }}
              />
            </Form.Item>

            <Form.Item
              name="institutionType"
              label="Type"
              className="mb-0"
              tooltip="Free text. The catalog already uses “bank” and “credit union”."
              rules={[{ required: true, whitespace: true, message: "Type is required" }]}
            >
              <AutoComplete
                options={typeOptions}
                placeholder="bank"
                filterOption={(input, option) =>
                  (option?.value ?? "").toLowerCase().includes(input.toLowerCase())
                }
                style={{ width: 260 }}
              />
            </Form.Item>
          </>
        )}

        {target.kind === "categories" && (
          <>
            <Form.Item
              name="name"
              label="Name"
              rules={[{ required: true, whitespace: true, message: "Name is required" }]}
            >
              <Input placeholder="e.g., Groceries" maxLength={120} autoComplete="off" />
            </Form.Item>

            <Form.Item
              name="categoryType"
              label="Type"
              tooltip="Money in or money out. Leave empty for a grouping category that is neither."
              help={
                categoryTypeIsUnknown
                  ? `Stored as "${target.row?.type}", which this list does not offer. Leave it as "Not set" to keep that value; picking one here replaces it.`
                  : undefined
              }
              validateStatus={categoryTypeIsUnknown ? "warning" : undefined}
            >
              <Select
                allowClear
                placeholder="Not set"
                options={CATEGORY_TYPES.map((type) => ({ value: type, label: type }))}
                style={{ width: 220 }}
              />
            </Form.Item>

            <Form.Item
              name="parentId"
              label="Parent"
              tooltip="Leave empty for a top-level category. Retired categories cannot be parents."
            >
              <Select
                allowClear
                showSearch
                placeholder="Top level"
                options={parentOptions}
                optionFilterProp="label"
                notFoundContent="No category matches"
              />
            </Form.Item>

            <Form.Item
              name="discretionary"
              label="Discretionary"
              className="mb-0"
              tooltip="Whether spending here is a choice rather than a commitment. “Not set” leaves it undecided."
            >
              <Select options={DISCRETIONARY_OPTIONS} style={{ width: 220 }} />
            </Form.Item>
          </>
        )}
      </FormSection>

      {target.row !== null && (
        <div className="flex flex-col gap-1 px-1 text-xs" style={{ color: surfaceColors.textTertiary }}>
          <span>Id: {target.row.id}</span>
          <Typography.Text type="secondary" className="text-xs">
            Saving edits the admin catalog only. Push the row to carry the change into the main app.
          </Typography.Text>
        </div>
      )}
    </Form>
  );
}

/* -------------------------------------------------------------------------- */
/* The drawer                                                                 */
/* -------------------------------------------------------------------------- */

export default function ConstantFormDrawer({
  target,
  currencies,
  currenciesError,
  categories,
  institutionTypes,
  onClose,
  onSaved,
}: ConstantFormDrawerProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep the last target on display while the drawer slides out.
  const [display, setDisplay] = useState<ConstantFormTarget | null>(target);
  if (target !== null && target !== display) setDisplay(target);

  const save = async (
    current: ConstantFormTarget,
    values: ConstantFormValues,
    touchedFields: ReadonlySet<string>,
  ) => {
    switch (current.kind) {
      case "countries": {
        const input: CountryInput = {
          name: values.name.trim(),
          alpha2Code: values.alpha2Code.trim().toUpperCase(),
          alpha3Code: values.alpha3Code.trim().toUpperCase(),
          currencyId: values.currencyId ?? null,
        };
        if (current.row === null) {
          await constantsApi.create("countries", input);
          return `Added ${input.name}.`;
        }
        const patch: ConstantPatchOf<"countries"> = {};
        if (input.name !== current.row.name) patch.name = input.name;
        if (input.alpha2Code !== current.row.alpha2Code) patch.alpha2Code = input.alpha2Code;
        if (input.alpha3Code !== current.row.alpha3Code) patch.alpha3Code = input.alpha3Code;
        if (input.currencyId !== current.row.currencyId) patch.currencyId = input.currencyId;
        if (Object.keys(patch).length === 0) return null;
        await constantsApi.update("countries", current.row.id, patch);
        return `Saved ${input.name}.`;
      }

      case "currencies": {
        const input: CurrencyInput = {
          code: values.code.trim().toUpperCase(),
          name: values.name.trim(),
          symbol: trimToNull(values.symbol),
        };
        if (current.row === null) {
          await constantsApi.create("currencies", input);
          return `Added ${input.code}.`;
        }
        const patch: ConstantPatchOf<"currencies"> = {};
        if (input.code !== current.row.code) patch.code = input.code;
        if (input.name !== current.row.name) patch.name = input.name;
        if (input.symbol !== current.row.symbol) patch.symbol = input.symbol;
        if (Object.keys(patch).length === 0) return null;
        await constantsApi.update("currencies", current.row.id, patch);
        return `Saved ${input.code}.`;
      }

      case "financial_institutions": {
        const input: FinancialInstitutionInput = {
          name: values.name.trim(),
          institutionNumber: values.institutionNumber.trim(),
          type: values.institutionType.trim(),
        };
        if (current.row === null) {
          await constantsApi.create("financial_institutions", input);
          return `Added ${input.name}.`;
        }
        const patch: ConstantPatchOf<"financial_institutions"> = {};
        if (input.name !== current.row.name) patch.name = input.name;
        if (input.institutionNumber !== current.row.institutionNumber) {
          patch.institutionNumber = input.institutionNumber;
        }
        if (input.type !== current.row.type) patch.type = input.type;
        if (Object.keys(patch).length === 0) return null;
        await constantsApi.update("financial_institutions", current.row.id, patch);
        return `Saved ${input.name}.`;
      }

      case "categories": {
        const input: CategoryInput = {
          name: values.name.trim(),
          type: values.categoryType ?? null,
          parentId: values.parentId ?? null,
          isDiscretionary: fromDiscretionary(values.discretionary),
        };
        if (current.row === null) {
          await constantsApi.create("categories", input);
          return `Added ${input.name}.`;
        }
        const patch: ConstantPatchOf<"categories"> = {};
        if (input.name !== current.row.name) patch.name = input.name;
        // The row's `type` is free text and may not be one of `CATEGORY_TYPES`,
        // so the Select cannot always show it; only send `type` when the
        // operator actually touched the field, never because the value it
        // could not display looks "changed" from the input's point of view.
        if (touchedFields.has("categoryType") && input.type !== current.row.type) {
          patch.type = input.type;
        }
        if (input.parentId !== current.row.parentId) patch.parentId = input.parentId;
        if (input.isDiscretionary !== current.row.isDiscretionary) {
          patch.isDiscretionary = input.isDiscretionary;
        }
        if (Object.keys(patch).length === 0) return null;
        await constantsApi.update("categories", current.row.id, patch);
        return `Saved ${input.name}.`;
      }
    }
  };

  const handleSubmit = async (values: ConstantFormValues, touchedFields: ReadonlySet<string>) => {
    if (display === null) return;
    setError(null);
    setSaving(true);
    try {
      const summary = await save(display, values, touchedFields);
      // Nothing changed: closing quietly is the honest answer.
      onSaved(summary ?? "No changes to save.");
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const meta = display === null ? null : KIND_META[display.kind];
  const title =
    display === null || meta === null
      ? "Constant"
      : display.row === null
        ? `Add ${meta.singular}`
        : `Edit ${meta.singular}`;

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
      size={560}
      destroyOnHidden
      title={
        <span className="flex items-center gap-2">
          <DatabaseOutlined style={{ fontSize: 18, color: CONSTANTS_COLOR }} />
          <span>{title}</span>
        </span>
      }
      styles={{ body: { background: surfaceColors.page } }}
      footer={
        <div className="flex items-center justify-end">
          <Space>
            <Button onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="primary" htmlType="submit" form={FORM_NAME} loading={saving}>
              {display?.row === null ? "Add" : "Save"}
            </Button>
          </Space>
        </div>
      }
    >
      {display === null ? null : (
        <FormBody
          key={`${display.kind}:${display.row?.id ?? "new"}`}
          target={display}
          currencies={currencies}
          currenciesError={currenciesError}
          categories={categories}
          institutionTypes={institutionTypes}
          busy={saving}
          error={error}
          onDismissError={() => setError(null)}
          onSubmit={(values, touchedFields) => {
            void handleSubmit(values, touchedFields);
          }}
          onInvalid={() =>
            setError("Some fields need attention. Check the highlighted ones and try again.")
          }
        />
      )}
    </Drawer>
  );
}
