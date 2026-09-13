"use client";

/**
 * Add a pair to the exchange-rate watch list.
 *
 * Only an add, for the same reason the quote drawer is: a pair is two codes and
 * nothing else, and the one thing that changes about it afterwards — whether it
 * is active — is a switch in the table.
 *
 * When the operator may read the catalogs the two fields are Selects over the
 * currency catalog, which is small enough to read in one page; without that
 * permission they are three-letter inputs and the server has the final say.
 */

import { useEffect, useState } from "react";
import { Alert, Button, Drawer, Form, Input, Select, Space, Typography } from "antd";
import { SwapOutlined } from "@ant-design/icons";
import {
  FormErrorSummary,
  useFormErrorSummary,
} from "@/components/form-error-summary";
import FormSection from "@/components/form-section";
import { ENTRY_DRAWER_WIDTH } from "@/components/shell/definitions";
import { constantsApi } from "@/lib/constants/client";
import { integrationsApi } from "@/lib/integrations/client";
import type { CurrencyPairInput } from "@/lib/integrations/types";
import { errorMessage } from "@/lib/format";
import { surfaceColors } from "@/lib/theme/colors";
import { INTEGRATIONS_COLOR } from "./integrations-meta";

/** Save lives in the footer, outside the form, and submits by association. */
const FORM_NAME = "currency-pair-form";

/**
 * How many currencies the picker reads. The catalog is a couple of hundred
 * rows at most, so one page covers it; a longer one degrades to what fits
 * rather than paging through a form field.
 */
const CURRENCY_LIMIT = 200;

interface CurrencyPairFormValues {
  fromCurrency: string;
  toCurrency: string;
}

/** One currency, reduced to what the picker shows. */
interface CurrencyOption {
  value: string;
  label: string;
}

const upper = (value: unknown) => (typeof value === "string" ? value.toUpperCase() : value);

/** Three uppercase letters, which is every ISO 4217 code. */
const CODE_PATTERN = /^[A-Z]{3}$/;

export interface CurrencyPairDrawerProps {
  open: boolean;
  /** Whether the operator may read the catalogs; without it the codes are typed. */
  canReadCurrencies: boolean;
  onClose: () => void;
  /** A sentence for the page's toast, after the write went through. */
  onSaved: (summary: string) => void;
}

export default function CurrencyPairDrawer({
  open,
  canReadCurrencies,
  onClose,
  onSaved,
}: CurrencyPairDrawerProps) {
  const [form] = Form.useForm<CurrencyPairFormValues>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { errorSummary, onFinishFailed, reset } = useFormErrorSummary();
  const [currencies, setCurrencies] = useState<CurrencyOption[]>([]);
  /** A failed catalog read is soft: the fields fall back to plain inputs. */
  const [currenciesFailed, setCurrenciesFailed] = useState(false);

  useEffect(() => {
    if (!open || !canReadCurrencies) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await constantsApi.list("currencies", { pageSize: CURRENCY_LIMIT });
        if (cancelled) return;
        setCurrencies(
          response.rows.map((row) => ({ value: row.code.toUpperCase(), label: `${row.code} · ${row.name}` })),
        );
        setCurrenciesFailed(false);
      } catch {
        // Nothing is lost: the fields become the same inputs an operator
        // without `can_read_catalogs` gets.
        if (!cancelled) setCurrenciesFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, canReadCurrencies]);

  const picker = canReadCurrencies && !currenciesFailed && currencies.length > 0;

  const handleSubmit = async (values: CurrencyPairFormValues) => {
    setError(null);
    reset();
    const input: CurrencyPairInput = {
      fromCurrency: values.fromCurrency.trim().toUpperCase(),
      toCurrency: values.toCurrency.trim().toUpperCase(),
    };
    setSaving(true);
    try {
      const created = await integrationsApi.currencyPairs.create(input);
      onSaved(`Added ${created.fromCurrency}/${created.toCurrency} to the watch list.`);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  /** The two codes must differ; a pair of one currency has no rate to fetch. */
  const differentFrom = (other: "fromCurrency" | "toCurrency") => ({
    validator: async (_rule: unknown, value: string | undefined) => {
      const counterpart = form.getFieldValue(other) as string | undefined;
      if (
        typeof value === "string" &&
        typeof counterpart === "string" &&
        value.trim().toUpperCase() !== "" &&
        value.trim().toUpperCase() === counterpart.trim().toUpperCase()
      ) {
        throw new Error("The two currencies must differ");
      }
    },
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      afterOpenChange={(opened) => {
        if (!opened) {
          form.resetFields();
          setError(null);
          reset();
        }
      }}
      placement="right"
      size={ENTRY_DRAWER_WIDTH}
      destroyOnHidden
      title={
        <span className="flex items-center gap-2">
          <SwapOutlined style={{ fontSize: 18, color: INTEGRATIONS_COLOR }} />
          <span>Add currency pair</span>
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
              Add
            </Button>
          </Space>
        </div>
      }
    >
      <Form<CurrencyPairFormValues>
        form={form}
        name={FORM_NAME}
        layout="vertical"
        disabled={saving}
        initialValues={{ fromCurrency: "", toCurrency: "" }}
        onFinish={(values) => {
          void handleSubmit(values);
        }}
        onFinishFailed={onFinishFailed}
        className="flex flex-col gap-4"
      >
        <FormErrorSummary summary={errorSummary} onClose={reset} />

        {error !== null && (
          <Alert type="error" showIcon closable onClose={() => setError(null)} title={error} />
        )}

        <FormSection title="Pair" icon={<SwapOutlined />} color={INTEGRATIONS_COLOR}>
          <Form.Item
            name="fromCurrency"
            label="From"
            tooltip="The currency being converted, e.g. USD in USD → CAD."
            normalize={picker ? undefined : upper}
            rules={[
              { required: true, whitespace: true },
              { pattern: CODE_PATTERN, message: "A three-letter ISO code, e.g. USD" },
              differentFrom("toCurrency"),
            ]}
          >
            {picker ? (
              <Select
                showSearch
                options={currencies}
                optionFilterProp="label"
                placeholder="USD"
                style={{ width: 280 }}
              />
            ) : (
              <Input placeholder="USD" maxLength={3} autoComplete="off" style={{ width: 120 }} />
            )}
          </Form.Item>

          <Form.Item
            name="toCurrency"
            label="To"
            tooltip="The currency being converted into, e.g. CAD in USD → CAD."
            normalize={picker ? undefined : upper}
            rules={[
              { required: true, whitespace: true },
              { pattern: CODE_PATTERN, message: "A three-letter ISO code, e.g. CAD" },
              differentFrom("fromCurrency"),
            ]}
          >
            {picker ? (
              <Select
                showSearch
                options={currencies}
                optionFilterProp="label"
                placeholder="CAD"
                style={{ width: 280 }}
              />
            ) : (
              <Input placeholder="CAD" maxLength={3} autoComplete="off" style={{ width: 120 }} />
            )}
          </Form.Item>

          <Typography.Text type="secondary" className="text-xs">
            The rate is how many of the second currency one of the first buys. The Bank of Canada
            publishes roughly 27 currencies against CAD, so a pair with CAD on one side comes
            straight from its series and any other pair is the ratio of two of them.
          </Typography.Text>

          {canReadCurrencies && currenciesFailed && (
            <Alert
              type="warning"
              showIcon
              title="The currency catalog could not be read; type the codes instead."
            />
          )}
        </FormSection>
      </Form>
    </Drawer>
  );
}
