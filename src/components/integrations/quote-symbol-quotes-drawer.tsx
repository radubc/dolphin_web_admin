"use client";

/**
 * What has been downloaded for one quote symbol: every end-of-day quote stored
 * for it, newest trading day first, with the day's change, which provider
 * served it and when it was fetched.
 *
 * Opened by clicking the row on the quote watch list — the counterpart of the
 * currency pair's download history. Loaded on open and paged on the server: a
 * symbol watched for a year has a few hundred rows, which is not worth
 * shipping in one response and is certainly not worth polling.
 *
 * Read-only on purpose. A pair has "Fetch 6 months" because the Bank of
 * Canada publishes a free ranged series; a quote provider charges a credit per
 * symbol per day, so history arrives one trading day at a time from the daily
 * run and is never backfilled from here.
 *
 * The drawer body is a fixed-height column and the table sits in a
 * `ListTableRegion`, so the rows scroll under their own header and pager while
 * the note above them stays put — the same rule the list pages follow.
 */

import { useEffect, useState } from "react";
import { Alert, Button, Drawer, Empty, Spin, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { HistoryOutlined, ReloadOutlined } from "@ant-design/icons";
import { ListTableRegion } from "@/components/list-page-frame";
import { ResponsiveTable } from "@/components/responsive-table";
import { ENTRY_DRAWER_WIDTH } from "@/components/shell/definitions";
import { integrationsApi } from "@/lib/integrations/client";
import { RATE_HISTORY_PAGE_SIZE_DEFAULT } from "@/lib/integrations/types";
import type { Quote, QuoteSymbol } from "@/lib/integrations/types";
import { errorMessage, formatDate, formatDateTimeOrDash, formatRelativeTimeOrNever } from "@/lib/format";
import { surfaceColors } from "@/lib/theme/colors";
import { INTEGRATIONS_COLOR, PercentChange, QuoteProviderTag } from "./integrations-meta";

/** Page sizes offered, the smallest first: a history is read from the top. */
const HISTORY_PAGE_SIZE_OPTIONS = [RATE_HISTORY_PAGE_SIZE_DEFAULT, 60, 120] as const;

/** A price as the list shows it: at least two decimals, up to six for crypto. */
function formatPrice(value: number): string {
  return value.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function Dash() {
  return <span style={{ color: surfaceColors.textTertiary }}>—</span>;
}

export default function QuoteSymbolQuotesDrawer({
  symbol,
  onClose,
}: {
  /** Null closes the drawer. */
  symbol: QuoteSymbol | null;
  onClose: () => void;
}) {
  // Kept while the drawer animates shut, so the title does not blank out.
  const [display, setDisplay] = useState<QuoteSymbol | null>(symbol);
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(RATE_HISTORY_PAGE_SIZE_DEFAULT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  if (symbol !== null && symbol !== display) setDisplay(symbol);

  const id = symbol?.id ?? null;
  const label = display?.canonical ?? "";

  useEffect(() => {
    if (id === null) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const response = await integrationsApi.quoteSymbols.quotes(id, { page, pageSize });
        if (cancelled) return;
        setQuotes(response.items);
        setTotal(response.total);
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, page, pageSize, tick]);

  const columns: ColumnsType<Quote> = [
    {
      title: "Date",
      dataIndex: "quoteDate",
      width: 110,
      render: (value: string) => (
        <Tooltip title="The trading day the quote is for. A run after the close carries that day; one before it carries the previous session.">
          <span tabIndex={0} style={{ color: surfaceColors.text }}>
            {formatDate(value)}
          </span>
        </Tooltip>
      ),
    },
    {
      title: "Close",
      key: "close",
      width: 150,
      render: (_value, row) => (
        <span className="tabular-nums" style={{ color: surfaceColors.text }}>
          {formatPrice(row.close)}
          {row.currency === "" ? "" : ` ${row.currency}`}
        </span>
      ),
    },
    {
      title: "Change",
      key: "change",
      width: 150,
      render: (_value, row) =>
        row.change === null && row.percentChange === null ? (
          <Dash />
        ) : (
          <span className="tabular-nums">
            {row.change !== null && (
              <span style={{ color: surfaceColors.text }}>
                {row.change > 0 ? "+" : ""}
                {formatPrice(row.change)}{" "}
              </span>
            )}
            <PercentChange fraction={row.percentChange} />
          </span>
        ),
    },
    {
      title: "Open",
      dataIndex: "open",
      width: 120,
      render: (value: number | null) =>
        value === null ? <Dash /> : <span className="tabular-nums">{formatPrice(value)}</span>,
    },
    {
      title: "Low – High",
      key: "range",
      width: 190,
      render: (_value, row) =>
        row.low === null && row.high === null ? (
          <Dash />
        ) : (
          <span className="tabular-nums">
            {row.low === null ? "—" : formatPrice(row.low)} – {row.high === null ? "—" : formatPrice(row.high)}
          </span>
        ),
    },
    {
      title: "Provider",
      dataIndex: "provider",
      width: 130,
      render: (value: Quote["provider"]) => <QuoteProviderTag provider={value} />,
    },
    {
      title: "Fetched",
      dataIndex: "fetchedAt",
      width: 130,
      render: (value: string) => (
        <Tooltip title={formatDateTimeOrDash(value)}>
          <span tabIndex={0}>{formatRelativeTimeOrNever(value)}</span>
        </Tooltip>
      ),
    },
  ];

  let body: React.ReactNode;
  if (loading && quotes === null) {
    body = (
      <div className="flex items-center justify-center py-16">
        <Spin />
      </div>
    );
  } else if (error !== null && quotes === null) {
    body = (
      <Alert
        type="error"
        showIcon
        title="The history could not be loaded."
        description={error}
        action={
          <Button size="small" onClick={() => setTick((value) => value + 1)}>
            Retry
          </Button>
        }
      />
    );
  } else if (quotes !== null && total === 0) {
    body = (
      <div className="py-14">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Typography.Text type="secondary">
              Nothing has been downloaded for {label} yet.{" "}
              {display?.isActive === true
                ? "The daily quote run will fetch it, or the consumer app will the next time it asks for this symbol."
                : "This symbol is inactive, so the daily run skips it; activate it on the list to have it quoted again."}
            </Typography.Text>
          }
        />
      </div>
    );
  } else {
    body = (
      <>
        {error !== null && <Alert type="warning" showIcon closable title={error} />}
        {/* No `ListPanel` around this table — it sits directly in the drawer
            body — so there is no panel border for the region to reserve. */}
        <ListTableRegion panelBorder={false}>
          {(y) => (
            <ResponsiveTable<Quote>
              dataSource={quotes ?? []}
              rowKey={(row) => `${row.quoteDate}-${row.fetchedAt}`}
              columns={columns}
              size="small"
              loading={loading}
              scroll={{ x: 980, y }}
              pagination={{
                current: page,
                pageSize,
                total,
                size: "small",
                showSizeChanger: true,
                pageSizeOptions: [...HISTORY_PAGE_SIZE_OPTIONS],
                showTotal: (count, range) =>
                  `${range[0].toLocaleString()}–${range[1].toLocaleString()} of ${count.toLocaleString()}`,
                onChange: (next, nextSize) => {
                  setPage(next);
                  setPageSize(nextSize);
                },
                onShowSizeChange: (next, nextSize) => {
                  setPage(next);
                  setPageSize(nextSize);
                },
              }}
            />
          )}
        </ListTableRegion>
      </>
    );
  }

  return (
    <Drawer
      open={symbol !== null}
      onClose={onClose}
      afterOpenChange={(open) => {
        if (!open) {
          setDisplay(null);
          setQuotes(null);
          setTotal(0);
          setPage(1);
          setPageSize(RATE_HISTORY_PAGE_SIZE_DEFAULT);
          setError(null);
        }
      }}
      placement="right"
      size={ENTRY_DRAWER_WIDTH}
      destroyOnHidden
      title={
        <span className="flex items-center gap-2">
          <HistoryOutlined style={{ fontSize: 18, color: INTEGRATIONS_COLOR }} />
          <span>{display === null ? "Quotes" : `${label} · download history`}</span>
        </span>
      }
      extra={
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => setTick((value) => value + 1)}
          loading={loading}
        >
          Refresh
        </Button>
      }
      // A column, so the table region below can be given a definite height;
      // the body keeps its own `overflow: auto` for the states that are taller
      // than it — a long error, a narrow window.
      styles={{ body: { background: surfaceColors.page, display: "flex", flexDirection: "column" } }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 [&>*]:shrink-0">
        <Typography.Text type="secondary" className="text-xs">
          Every quote stored for this symbol, newest trading day first. One row per day: a day
          fetched again is overwritten rather than added, so this is the history of what was
          downloaded, not of how often it was asked for. Quotes arrive one day at a time from the
          daily run; there is no backfill, because each one costs a provider credit.
        </Typography.Text>
        {body}
      </div>
    </Drawer>
  );
}
