"use client";

/**
 * Add / edit one reference row.
 *
 * One drawer for every catalog: the chrome, the footer and the error
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
import {
  Alert,
  AutoComplete,
  Button,
  Drawer,
  Form,
  Input,
  Select,
  Space,
  Switch,
  Typography,
} from "antd";
import { DatabaseOutlined } from "@ant-design/icons";
import FormSection from "@/components/form-section";
import { constantsApi } from "@/lib/constants/client";
import type {
  AccountBaseTypeInput,
  AccountBaseTypeRow,
  AccountTypeInput,
  CategoryInput,
  CategoryRow,
  CategoryType,
  ConstantKind,
  ConstantPatchOf,
  ConstantRowOf,
  CountryInput,
  CryptocurrencyInput,
  CurrencyInput,
  CurrencyRow,
  EtfInput,
  EtfRow,
  FinancialInstitutionInput,
  MarketInput,
  StockInput,
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
  displayName: string;
  baseTypeId: string | null;
  isAsset: boolean;
  isBanking: boolean;
  isInvestment: boolean;
  /** The ticker of a cryptocurrency pair, an ETF or a stock; `symbol` above is a currency's sign. */
  tickerSymbol: string;
  availableExchanges: string;
  currencyBase: string;
  currencyQuote: string;
  /** An instrument's trading currency; `code` above is the currency catalog's own field. */
  instrumentCurrency: string;
  exchange: string;
  micCode: string;
  /** An instrument's country as the feed names it ("United States"), not a code. */
  country: string;
  figiCode: string;
  cfiCode: string;
  isin: string;
  cusip: string;
  /** A stock's instrument type ("Common Stock"); `institutionType` above is the bank's. */
  instrumentType: string;
  operatingMic: string;
  marketName: string;
  isoCountryCode: string;
  city: string;
}

const upper = (value: unknown) => (typeof value === "string" ? value.toUpperCase() : value);

export interface ConstantFormDrawerProps {
  /** Null closes the drawer. */
  target: ConstantFormTarget | null;
  currencies: readonly CurrencyRow[];
  /** Set when the currency catalog failed to load; disables the country form's Currency field. */
  currenciesError: string | null;
  baseTypes: readonly AccountBaseTypeRow[];
  /** Set when the base-type catalog failed to load; disables the account-type form's Base type field. */
  baseTypesError: string | null;
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

/**
 * The fields an ETF and a stock share, plus the stock's instrument type. Both
 * rows carry the same shape, so the field set is written once; the four
 * identifiers at the bottom are reference numbers the feed may not carry, so
 * they are optional and an empty one is saved as an empty string, never
 * invented.
 *
 * `Form.Item` reads the surrounding `Form` through context, so this renders
 * inside `FormBody`'s form without threading the instance through.
 */
function InstrumentFields({ withType }: { withType: boolean }) {
  return (
    <>
      <Form.Item
        name="tickerSymbol"
        label="Symbol"
        tooltip="The ticker as the exchange lists it, e.g. AAPL. Unique together with the exchange."
        normalize={upper}
        rules={[{ required: true, whitespace: true, message: "Symbol is required" }]}
      >
        <Input placeholder="AAPL" maxLength={40} autoComplete="off" style={{ width: 180 }} />
      </Form.Item>

      <Form.Item
        name="name"
        label="Name"
        rules={[{ required: true, whitespace: true, message: "Name is required" }]}
      >
        <Input placeholder="e.g., Apple Inc." maxLength={200} autoComplete="off" />
      </Form.Item>

      <Form.Item
        name="instrumentCurrency"
        label="Currency"
        tooltip="The currency the instrument trades in, e.g. USD."
        normalize={upper}
        rules={[{ required: true, whitespace: true, message: "Currency is required" }]}
      >
        <Input placeholder="USD" maxLength={12} autoComplete="off" style={{ width: 140 }} />
      </Form.Item>

      <Form.Item
        name="exchange"
        label="Exchange"
        tooltip="The exchange's name as the feed writes it, e.g. NASDAQ."
        rules={[{ required: true, whitespace: true, message: "Exchange is required" }]}
      >
        <Input placeholder="NASDAQ" maxLength={80} autoComplete="off" style={{ width: 260 }} />
      </Form.Item>

      <Form.Item
        name="micCode"
        label="MIC"
        tooltip="The ISO 10383 code of the exchange, e.g. XNGS. It is what the Markets catalog keys on."
        normalize={upper}
        rules={[{ required: true, whitespace: true, message: "MIC is required" }]}
      >
        <Input placeholder="XNGS" maxLength={12} autoComplete="off" style={{ width: 160 }} />
      </Form.Item>

      <Form.Item
        name="country"
        label="Country"
        tooltip="The country as the feed names it, e.g. United States. A name, not a code."
        rules={[{ required: true, whitespace: true, message: "Country is required" }]}
      >
        <Input placeholder="United States" maxLength={80} autoComplete="off" style={{ width: 260 }} />
      </Form.Item>

      {withType && (
        <Form.Item
          name="instrumentType"
          label="Type"
          tooltip="Free text from the feed, e.g. Common Stock or Depositary Receipt."
          rules={[{ required: true, whitespace: true, message: "Type is required" }]}
        >
          <Input placeholder="Common Stock" maxLength={80} autoComplete="off" style={{ width: 260 }} />
        </Form.Item>
      )}

      <Form.Item
        name="figiCode"
        label="FIGI"
        tooltip="Optional. The Financial Instrument Global Identifier, e.g. BBG000B9XRY4."
      >
        <Input placeholder="Optional" maxLength={40} autoComplete="off" style={{ width: 260 }} />
      </Form.Item>

      <Form.Item name="cfiCode" label="CFI" tooltip="Optional. The ISO 10962 instrument classification, e.g. ESVUFR.">
        <Input placeholder="Optional" maxLength={40} autoComplete="off" style={{ width: 260 }} />
      </Form.Item>

      <Form.Item name="isin" label="ISIN" tooltip="Optional. The ISO 6166 security number, e.g. US0378331005.">
        <Input placeholder="Optional" maxLength={40} autoComplete="off" style={{ width: 260 }} />
      </Form.Item>

      <Form.Item
        name="cusip"
        label="CUSIP"
        className="mb-0"
        tooltip="Optional. The North American security number, e.g. 037833100."
      >
        <Input placeholder="Optional" maxLength={40} autoComplete="off" style={{ width: 260 }} />
      </Form.Item>
    </>
  );
}

function FormBody({
  target,
  currencies,
  currenciesError,
  baseTypes,
  baseTypesError,
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
  baseTypes: readonly AccountBaseTypeRow[];
  baseTypesError: string | null;
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
      case "account_base_types":
        return { name: target.row?.name ?? "" };
      case "account_types":
        return {
          name: target.row?.name ?? "",
          displayName: target.row?.displayName ?? "",
          baseTypeId: target.row?.baseTypeId ?? null,
          isAsset: target.row?.isAsset ?? false,
          isBanking: target.row?.isBanking ?? false,
          isInvestment: target.row?.isInvestment ?? false,
        };
      case "cryptocurrencies":
        return {
          tickerSymbol: target.row?.symbol ?? "",
          currencyBase: target.row?.currencyBase ?? "",
          currencyQuote: target.row?.currencyQuote ?? "",
          availableExchanges: target.row?.availableExchanges ?? "",
        };
      case "etfs":
        return {
          tickerSymbol: target.row?.symbol ?? "",
          name: target.row?.name ?? "",
          instrumentCurrency: target.row?.currency ?? "",
          exchange: target.row?.exchange ?? "",
          micCode: target.row?.micCode ?? "",
          country: target.row?.country ?? "",
          figiCode: target.row?.figiCode ?? "",
          cfiCode: target.row?.cfiCode ?? "",
          isin: target.row?.isin ?? "",
          cusip: target.row?.cusip ?? "",
        };
      case "stocks":
        return {
          tickerSymbol: target.row?.symbol ?? "",
          name: target.row?.name ?? "",
          instrumentCurrency: target.row?.currency ?? "",
          exchange: target.row?.exchange ?? "",
          micCode: target.row?.micCode ?? "",
          country: target.row?.country ?? "",
          instrumentType: target.row?.type ?? "",
          figiCode: target.row?.figiCode ?? "",
          cfiCode: target.row?.cfiCode ?? "",
          isin: target.row?.isin ?? "",
          cusip: target.row?.cusip ?? "",
        };
      case "markets":
        return {
          micCode: target.row?.micCode ?? "",
          marketName: target.row?.marketName ?? "",
          operatingMic: target.row?.operatingMic ?? "",
          isoCountryCode: target.row?.isoCountryCode ?? "",
          city: target.row?.city ?? "",
        };
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

  const baseTypeOptions = useMemo(
    () =>
      [...baseTypes]
        .map((baseType) => ({ value: baseType.id, label: baseType.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [baseTypes],
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

        {target.kind === "account_base_types" && (
          <Form.Item
            name="name"
            label="Name"
            className="mb-0"
            tooltip="The grouping account types sit in, e.g. Banking. Account types point at it by id."
            rules={[{ required: true, whitespace: true, message: "Name is required" }]}
          >
            <Input placeholder="e.g., Banking" maxLength={120} autoComplete="off" />
          </Form.Item>
        )}

        {target.kind === "account_types" && (
          <>
            <Form.Item
              name="name"
              label="Name"
              tooltip="The machine name the main app matches on, e.g. Chequing. Unique among live account types."
              rules={[{ required: true, whitespace: true, message: "Name is required" }]}
            >
              <Input placeholder="e.g., Chequing" maxLength={120} autoComplete="off" />
            </Form.Item>

            <Form.Item
              name="displayName"
              label="Display name"
              tooltip="What the app shows a user. Often the same as the name."
              rules={[{ required: true, whitespace: true, message: "Display name is required" }]}
            >
              <Input placeholder="e.g., Chequing" maxLength={120} autoComplete="off" />
            </Form.Item>

            <Form.Item
              name="baseTypeId"
              label="Base type"
              tooltip="The grouping this account type belongs to. Pushing the account type pushes its base type first."
              help={
                baseTypesError !== null
                  ? "Account base types could not be loaded, so this field is disabled to avoid saving it as empty."
                  : undefined
              }
              validateStatus={baseTypesError !== null ? "warning" : undefined}
            >
              <Select
                allowClear
                showSearch
                disabled={baseTypesError !== null}
                placeholder="No base type"
                options={baseTypeOptions}
                optionFilterProp="label"
                notFoundContent="No base type matches"
              />
            </Form.Item>

            <Form.Item
              name="isAsset"
              label="Asset"
              valuePropName="checked"
              tooltip="Its balance counts towards the user's assets rather than their debts."
            >
              <Switch />
            </Form.Item>

            <Form.Item
              name="isBanking"
              label="Banking"
              valuePropName="checked"
              tooltip="A day-to-day banking account: chequing, savings, and the like."
            >
              <Switch />
            </Form.Item>

            <Form.Item
              name="isInvestment"
              label="Investment"
              className="mb-0"
              valuePropName="checked"
              tooltip="Holds investments, so the app treats its balance as a portfolio value."
            >
              <Switch />
            </Form.Item>
          </>
        )}
        {target.kind === "cryptocurrencies" && (
          <>
            <Form.Item
              name="tickerSymbol"
              label="Symbol"
              tooltip="The pair as the market-data feed writes it, e.g. BTC/USD."
              normalize={upper}
              rules={[{ required: true, whitespace: true, message: "Symbol is required" }]}
            >
              <Input placeholder="BTC/USD" maxLength={40} autoComplete="off" style={{ width: 220 }} />
            </Form.Item>

            <Form.Item
              name="currencyBase"
              label="Base currency"
              tooltip="What is being bought, e.g. BTC."
              normalize={upper}
              rules={[{ required: true, whitespace: true, message: "Base currency is required" }]}
            >
              <Input placeholder="BTC" maxLength={20} autoComplete="off" style={{ width: 180 }} />
            </Form.Item>

            <Form.Item
              name="currencyQuote"
              label="Quote currency"
              tooltip="What it is priced in, e.g. USD."
              normalize={upper}
              rules={[{ required: true, whitespace: true, message: "Quote currency is required" }]}
            >
              <Input placeholder="USD" maxLength={20} autoComplete="off" style={{ width: 180 }} />
            </Form.Item>

            <Form.Item
              name="availableExchanges"
              label="Exchanges"
              className="mb-0"
              tooltip="Free text from the feed: the exchanges that list the pair, usually comma-separated."
              rules={[{ required: true, whitespace: true, message: "Exchanges are required" }]}
            >
              <Input.TextArea
                placeholder="Binance, Coinbase Pro, Kraken"
                maxLength={2000}
                autoSize={{ minRows: 2, maxRows: 6 }}
                autoComplete="off"
              />
            </Form.Item>
          </>
        )}

        {(target.kind === "etfs" || target.kind === "stocks") && (
          <InstrumentFields withType={target.kind === "stocks"} />
        )}

        {target.kind === "markets" && (
          <>
            <Form.Item
              name="micCode"
              label="MIC"
              tooltip="The ISO 10383 market identifier code, e.g. XNGS. Unique across markets."
              normalize={upper}
              rules={[{ required: true, whitespace: true, message: "MIC is required" }]}
            >
              <Input placeholder="XNGS" maxLength={12} autoComplete="off" style={{ width: 160 }} />
            </Form.Item>

            <Form.Item
              name="marketName"
              label="Name"
              rules={[{ required: true, whitespace: true, message: "Name is required" }]}
            >
              <Input
                placeholder="e.g., NASDAQ/NGS (GLOBAL SELECT MARKET)"
                maxLength={160}
                autoComplete="off"
              />
            </Form.Item>

            <Form.Item
              name="operatingMic"
              label="Operating MIC"
              tooltip="The venue this segment operates under. For an operating market itself it is the same as the MIC."
              normalize={upper}
              rules={[{ required: true, whitespace: true, message: "Operating MIC is required" }]}
            >
              <Input placeholder="XNAS" maxLength={12} autoComplete="off" style={{ width: 160 }} />
            </Form.Item>

            <Form.Item
              name="isoCountryCode"
              label="Country code"
              tooltip="The two-letter ISO 3166-1 code of the country the market sits in, e.g. US."
              normalize={upper}
              rules={[{ required: true, whitespace: true, message: "Country code is required" }]}
            >
              <Input placeholder="US" maxLength={8} autoComplete="off" style={{ width: 140 }} />
            </Form.Item>

            <Form.Item
              name="city"
              label="City"
              className="mb-0"
              rules={[{ required: true, whitespace: true, message: "City is required" }]}
            >
              <Input placeholder="e.g., New York" maxLength={120} autoComplete="off" />
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
/* Saving                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The fields an ETF and a stock share, read off the form. A stock adds `type`
 * on top; everything else is identical, so the trimming and the uppercasing
 * live in one place and the two kinds cannot drift apart.
 */
function instrumentInput(values: ConstantFormValues): EtfInput {
  return {
    symbol: values.tickerSymbol.trim().toUpperCase(),
    name: values.name.trim(),
    currency: values.instrumentCurrency.trim().toUpperCase(),
    exchange: values.exchange.trim(),
    micCode: values.micCode.trim().toUpperCase(),
    country: values.country.trim(),
    // The four identifiers are optional: an empty box stays an empty string
    // rather than becoming a value the feed never gave.
    figiCode: values.figiCode.trim(),
    cfiCode: values.cfiCode.trim(),
    isin: values.isin.trim(),
    cusip: values.cusip.trim(),
  };
}

/** Only what the operator actually changed, so a PATCH never rewrites untouched fields. */
function instrumentPatch(input: EtfInput, row: EtfRow): Partial<EtfInput> {
  const patch: Partial<EtfInput> = {};
  if (input.symbol !== row.symbol) patch.symbol = input.symbol;
  if (input.name !== row.name) patch.name = input.name;
  if (input.currency !== row.currency) patch.currency = input.currency;
  if (input.exchange !== row.exchange) patch.exchange = input.exchange;
  if (input.micCode !== row.micCode) patch.micCode = input.micCode;
  if (input.country !== row.country) patch.country = input.country;
  if (input.figiCode !== row.figiCode) patch.figiCode = input.figiCode;
  if (input.cfiCode !== row.cfiCode) patch.cfiCode = input.cfiCode;
  if (input.isin !== row.isin) patch.isin = input.isin;
  if (input.cusip !== row.cusip) patch.cusip = input.cusip;
  return patch;
}

/* -------------------------------------------------------------------------- */
/* The drawer                                                                 */
/* -------------------------------------------------------------------------- */

export default function ConstantFormDrawer({
  target,
  currencies,
  currenciesError,
  baseTypes,
  baseTypesError,
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

      case "account_base_types": {
        const input: AccountBaseTypeInput = { name: values.name.trim() };
        if (current.row === null) {
          await constantsApi.create("account_base_types", input);
          return `Added ${input.name}.`;
        }
        const patch: ConstantPatchOf<"account_base_types"> = {};
        if (input.name !== current.row.name) patch.name = input.name;
        if (Object.keys(patch).length === 0) return null;
        await constantsApi.update("account_base_types", current.row.id, patch);
        return `Saved ${input.name}.`;
      }

      case "account_types": {
        const input: AccountTypeInput = {
          name: values.name.trim(),
          displayName: values.displayName.trim(),
          isAsset: values.isAsset === true,
          isBanking: values.isBanking === true,
          isInvestment: values.isInvestment === true,
          baseTypeId: values.baseTypeId ?? null,
        };
        if (current.row === null) {
          await constantsApi.create("account_types", input);
          return `Added ${input.displayName}.`;
        }
        const patch: ConstantPatchOf<"account_types"> = {};
        if (input.name !== current.row.name) patch.name = input.name;
        if (input.displayName !== current.row.displayName) patch.displayName = input.displayName;
        if (input.baseTypeId !== current.row.baseTypeId) patch.baseTypeId = input.baseTypeId;
        if (input.isAsset !== current.row.isAsset) patch.isAsset = input.isAsset;
        if (input.isBanking !== current.row.isBanking) patch.isBanking = input.isBanking;
        if (input.isInvestment !== current.row.isInvestment) patch.isInvestment = input.isInvestment;
        if (Object.keys(patch).length === 0) return null;
        await constantsApi.update("account_types", current.row.id, patch);
        return `Saved ${input.displayName}.`;
      }

      case "cryptocurrencies": {
        const input: CryptocurrencyInput = {
          symbol: values.tickerSymbol.trim().toUpperCase(),
          currencyBase: values.currencyBase.trim().toUpperCase(),
          currencyQuote: values.currencyQuote.trim().toUpperCase(),
          availableExchanges: values.availableExchanges.trim(),
        };
        if (current.row === null) {
          await constantsApi.create("cryptocurrencies", input);
          return `Added ${input.symbol}.`;
        }
        const patch: ConstantPatchOf<"cryptocurrencies"> = {};
        if (input.symbol !== current.row.symbol) patch.symbol = input.symbol;
        if (input.currencyBase !== current.row.currencyBase) patch.currencyBase = input.currencyBase;
        if (input.currencyQuote !== current.row.currencyQuote) {
          patch.currencyQuote = input.currencyQuote;
        }
        if (input.availableExchanges !== current.row.availableExchanges) {
          patch.availableExchanges = input.availableExchanges;
        }
        if (Object.keys(patch).length === 0) return null;
        await constantsApi.update("cryptocurrencies", current.row.id, patch);
        return `Saved ${input.symbol}.`;
      }

      case "etfs": {
        const input: EtfInput = instrumentInput(values);
        if (current.row === null) {
          await constantsApi.create("etfs", input);
          return `Added ${input.symbol}.`;
        }
        const patch: ConstantPatchOf<"etfs"> = instrumentPatch(input, current.row);
        if (Object.keys(patch).length === 0) return null;
        await constantsApi.update("etfs", current.row.id, patch);
        return `Saved ${input.symbol}.`;
      }

      case "stocks": {
        const input: StockInput = {
          ...instrumentInput(values),
          type: values.instrumentType.trim(),
        };
        if (current.row === null) {
          await constantsApi.create("stocks", input);
          return `Added ${input.symbol}.`;
        }
        const patch: ConstantPatchOf<"stocks"> = instrumentPatch(input, current.row);
        if (input.type !== current.row.type) patch.type = input.type;
        if (Object.keys(patch).length === 0) return null;
        await constantsApi.update("stocks", current.row.id, patch);
        return `Saved ${input.symbol}.`;
      }

      case "markets": {
        const input: MarketInput = {
          micCode: values.micCode.trim().toUpperCase(),
          marketName: values.marketName.trim(),
          operatingMic: values.operatingMic.trim().toUpperCase(),
          isoCountryCode: values.isoCountryCode.trim().toUpperCase(),
          city: values.city.trim(),
        };
        if (current.row === null) {
          await constantsApi.create("markets", input);
          return `Added ${input.micCode}.`;
        }
        const patch: ConstantPatchOf<"markets"> = {};
        if (input.micCode !== current.row.micCode) patch.micCode = input.micCode;
        if (input.marketName !== current.row.marketName) patch.marketName = input.marketName;
        if (input.operatingMic !== current.row.operatingMic) patch.operatingMic = input.operatingMic;
        if (input.isoCountryCode !== current.row.isoCountryCode) {
          patch.isoCountryCode = input.isoCountryCode;
        }
        if (input.city !== current.row.city) patch.city = input.city;
        if (Object.keys(patch).length === 0) return null;
        await constantsApi.update("markets", current.row.id, patch);
        return `Saved ${input.micCode}.`;
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
          baseTypes={baseTypes}
          baseTypesError={baseTypesError}
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
