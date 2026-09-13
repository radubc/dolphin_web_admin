"use client";

/**
 * Add a symbol to the quote watch list.
 *
 * Only an add: what a symbol *is* comes from the catalog and from the provider,
 * so the only thing an operator ever changes about one afterwards is whether it
 * is active, which the table's switch does in place.
 *
 * The three fields are the whole contract — kind, symbol, and the exchange for
 * anything that trades on one — but typing a ticker from memory is how a watch
 * list fills up with symbols the provider has never heard of. So when the
 * operator may read the catalogs, the drawer offers a search over the matching
 * one and fills the fields from the row that is picked; without that permission
 * the fields are simply typed, and the server still refuses what it cannot
 * resolve.
 */

import { useEffect, useState } from "react";
import { Alert, AutoComplete, Button, Drawer, Form, Input, Radio, Space, Typography } from "antd";
import { SearchOutlined, StockOutlined } from "@ant-design/icons";
import {
  FormErrorSummary,
  useFormErrorSummary,
} from "@/components/form-error-summary";
import FormSection from "@/components/form-section";
import { ENTRY_DRAWER_WIDTH } from "@/components/shell/definitions";
import { constantsApi } from "@/lib/constants/client";
import { integrationsApi } from "@/lib/integrations/client";
import type { QuoteKind, QuoteSymbolInput } from "@/lib/integrations/types";
import { QUOTE_KINDS } from "@/lib/integrations/types";
import { errorMessage } from "@/lib/format";
import { surfaceColors } from "@/lib/theme/colors";
import { INTEGRATIONS_COLOR, QUOTE_KIND_LABELS } from "./integrations-meta";

/** Save lives in the footer, outside the form, and submits by association. */
const FORM_NAME = "quote-symbol-form";

/** How long typing settles before the catalog is searched. */
const SEARCH_DEBOUNCE_MS = 300;

/** How many catalog rows the suggestion list offers. */
const SEARCH_LIMIT = 10;

interface QuoteSymbolFormValues {
  kind: QuoteKind;
  symbol: string;
  exchange: string;
}

/** One catalog row, reduced to what the form needs from it. */
interface Suggestion {
  /** Unique per row, and what the `AutoComplete` reports on select. */
  value: string;
  symbol: string;
  exchange: string | null;
  label: string;
}

/**
 * The matching catalog for a kind. A generic call with a union `kind` would
 * widen the response to a union of row *arrays*, which no longer narrows, so
 * each branch names its catalog outright.
 */
async function searchCatalog(kind: QuoteKind, q: string): Promise<Suggestion[]> {
  if (kind === "crypto") {
    const response = await constantsApi.list("cryptocurrencies", { q, pageSize: SEARCH_LIMIT });
    return response.rows.map((row) => ({
      value: row.symbol,
      symbol: row.symbol,
      exchange: null,
      label: `${row.symbol} · ${row.currencyBase}/${row.currencyQuote}`,
    }));
  }
  const response = await constantsApi.list(kind === "etf" ? "etfs" : "stocks", {
    q,
    pageSize: SEARCH_LIMIT,
  });
  return response.rows.map((row) => ({
    // Symbol alone is not unique across exchanges; the canonical spelling is.
    value: `${row.symbol}:${row.exchange}`,
    symbol: row.symbol,
    exchange: row.exchange,
    label: `${row.symbol} · ${row.exchange} · ${row.name}${row.currency === "" ? "" : ` (${row.currency})`}`,
  }));
}

export interface QuoteSymbolDrawerProps {
  open: boolean;
  /** Whether the operator may read the catalogs; without it there is no search. */
  canSearchCatalog: boolean;
  onClose: () => void;
  /** A sentence for the page's toast, after the write went through. */
  onSaved: (summary: string) => void;
}

export default function QuoteSymbolDrawer({
  open,
  canSearchCatalog,
  onClose,
  onSaved,
}: QuoteSymbolDrawerProps) {
  const [form] = Form.useForm<QuoteSymbolFormValues>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { errorSummary, onFinishFailed, reset } = useFormErrorSummary();

  // The kind decides which catalog is searched and whether an exchange is asked
  // for at all, so the form watches it.
  const kind = Form.useWatch("kind", form) ?? "stock";

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  /** A failed catalog search is soft: the fields are still typed by hand. */
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    // An empty box asks nothing; what was found for the last one is dropped at
    // render (`options` below) rather than by a state write from here.
    if (!open || !canSearchCatalog || query === "") return;
    let cancelled = false;
    void (async () => {
      setSearching(true);
      try {
        const rows = await searchCatalog(kind, query);
        if (cancelled) return;
        setSuggestions(rows);
        setSearchError(null);
      } catch (cause) {
        if (!cancelled) {
          setSuggestions([]);
          setSearchError(errorMessage(cause));
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, canSearchCatalog, kind, query]);

  /** What the box may show now: never last query's rows after it is cleared. */
  const options = query === "" ? [] : suggestions;

  const handleSelect = (value: string) => {
    const picked = suggestions.find((suggestion) => suggestion.value === value);
    if (picked === undefined) return;
    form.setFieldsValue({ symbol: picked.symbol, exchange: picked.exchange ?? "" });
  };

  const handleSubmit = async (values: QuoteSymbolFormValues) => {
    setError(null);
    reset();
    setSaving(true);
    const input: QuoteSymbolInput = {
      kind: values.kind,
      symbol: values.symbol.trim().toUpperCase(),
      // Crypto pairs do not trade on one exchange in this model, so the field
      // is not sent rather than sent empty.
      ...(values.kind === "crypto" ? {} : { exchange: values.exchange.trim() }),
    };
    try {
      const created = await integrationsApi.quoteSymbols.create(input);
      onSaved(`Added ${created.canonical} to the watch list.`);
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
      afterOpenChange={(opened) => {
        if (!opened) {
          form.resetFields();
          setError(null);
          reset();
          setSearch("");
          setQuery("");
          setSuggestions([]);
          setSearchError(null);
        }
      }}
      placement="right"
      size={ENTRY_DRAWER_WIDTH}
      destroyOnHidden
      title={
        <span className="flex items-center gap-2">
          <StockOutlined style={{ fontSize: 18, color: INTEGRATIONS_COLOR }} />
          <span>Add symbol</span>
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
      <Form<QuoteSymbolFormValues>
        form={form}
        name={FORM_NAME}
        layout="vertical"
        disabled={saving}
        initialValues={{ kind: "stock", symbol: "", exchange: "" }}
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

        <FormSection title="Symbol" icon={<StockOutlined />} color={INTEGRATIONS_COLOR}>
          <Form.Item name="kind" label="Kind">
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              options={QUOTE_KINDS.map((value) => ({ value, label: QUOTE_KIND_LABELS[value] }))}
              onChange={() => {
                // The suggestions belong to the catalog that was being
                // searched; a different kind means a different catalog.
                setSuggestions([]);
                setSearchError(null);
              }}
            />
          </Form.Item>

          {canSearchCatalog && (
            <Form.Item
              label="Find it in the catalog"
              tooltip="Optional. Picking a row fills the fields below with the catalog's own spelling."
              help={searchError ?? undefined}
              validateStatus={searchError === null ? undefined : "warning"}
            >
              <AutoComplete
                value={search}
                onChange={setSearch}
                onSelect={handleSelect}
                options={options.map((suggestion) => ({
                  value: suggestion.value,
                  label: suggestion.label,
                }))}
                // The server has already matched the query; filtering again in
                // the browser would only hide rows it deliberately returned.
                filterOption={false}
                notFoundContent={
                  searching ? "Searching…" : query === "" ? null : "Nothing in the catalog matches."
                }
                placeholder={
                  kind === "crypto" ? "Search cryptocurrencies…" : "Search by symbol or name…"
                }
              >
                <Input prefix={<SearchOutlined />} allowClear />
              </AutoComplete>
            </Form.Item>
          )}

          <Form.Item
            name="symbol"
            label="Symbol"
            tooltip={
              kind === "crypto"
                ? "A crypto pair is written BASE/QUOTE, e.g. BTC/USD."
                : "The ticker as the catalog spells it, e.g. AAPL."
            }
            normalize={(value: unknown) => (typeof value === "string" ? value.toUpperCase() : value)}
            rules={[
              { required: true, whitespace: true },
              ...(kind === "crypto"
                ? [
                    {
                      pattern: /^[A-Z0-9]+\/[A-Z0-9]+$/,
                      message: "A crypto pair looks like BTC/USD",
                    },
                  ]
                : []),
            ]}
          >
            <Input
              placeholder={kind === "crypto" ? "BTC/USD" : "AAPL"}
              maxLength={40}
              autoComplete="off"
              style={{ width: 220 }}
            />
          </Form.Item>

          {kind !== "crypto" && (
            <Form.Item
              name="exchange"
              label="Exchange"
              tooltip="As the catalog spells it, e.g. NASDAQ, TSX."
              rules={[{ required: true, whitespace: true }]}
            >
              <Input placeholder="NASDAQ" maxLength={80} autoComplete="off" style={{ width: 260 }} />
            </Form.Item>
          )}

          <Typography.Text type="secondary" className="text-xs">
            {kind === "crypto"
              ? "Crypto pairs are asked for by the pair itself — BTC/USD — with no exchange."
              : "The symbol and the exchange together become the canonical name the provider is asked for and the consumer app quotes by: SHOP:TSX."}
          </Typography.Text>
        </FormSection>
      </Form>
    </Drawer>
  );
}
