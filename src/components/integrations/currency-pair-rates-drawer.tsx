"use client";

/**
 * What has been downloaded for one currency pair: every rate stored for it,
 * newest observation day first, with where the figure came from and when it
 * was fetched.
 *
 * Opened by clicking the row on the currency pair list. Loaded on open and
 * paged on the server — a pair watched for a year has a few hundred rows,
 * which is not worth shipping in one response and is certainly not worth
 * polling.
 *
 * One write lives here: **Fetch 6 months**, beside Refresh, which asks the
 * server for the same window a manual add fetches (`today − 182 days` → today,
 * one ranged Bank of Canada call) and then reloads this table. It is shown only
 * to an operator who may write integrations, and it is disabled for an inactive
 * pair — the server refuses that with a 409, because switching a pair off is a
 * decision no fetch overturns.
 *
 * The drawer body is a fixed-height column and the table sits in a
 * `ListTableRegion`, so the rows scroll under their own header and pager while
 * the note above them stays put — the same rule the list pages follow.
 */

import { useEffect, useState } from "react";
import { Alert, App, Button, Drawer, Empty, Space, Spin, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { CloudDownloadOutlined, HistoryOutlined, ReloadOutlined } from "@ant-design/icons";
import { ListTableRegion } from "@/components/list-page-frame";
import { ResponsiveTable } from "@/components/responsive-table";
import { ENTRY_DRAWER_WIDTH } from "@/components/shell/definitions";
import { integrationsApi } from "@/lib/integrations/client";
import {
  CURRENCY_PAIR_BACKFILL_DAYS,
  RATE_HISTORY_PAGE_SIZE_DEFAULT,
} from "@/lib/integrations/types";
import type { CurrencyPair, ExchangeRate } from "@/lib/integrations/types";
import { errorMessage, formatDate, formatDateTimeOrDash, formatRelativeTimeOrNever } from "@/lib/format";
import { surfaceColors } from "@/lib/theme/colors";
import { INTEGRATIONS_COLOR, pairHistorySummary, RateSourceTag } from "./integrations-meta";

/** How many decimals a rate is shown to, as on the list: what Valet publishes. */
const RATE_DECIMALS = 6;

/** Page sizes offered, the smallest first: a history is read from the top. */
const HISTORY_PAGE_SIZE_OPTIONS = [RATE_HISTORY_PAGE_SIZE_DEFAULT, 60, 120] as const;

export default function CurrencyPairRatesDrawer({
  pair,
  canWrite,
  onClose,
}: {
  /** Null closes the drawer. */
  pair: CurrencyPair | null;
  /** `can_write_integrations`; without it there is no Fetch button. */
  canWrite: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  // Kept while the drawer animates shut, so the title does not blank out.
  const [display, setDisplay] = useState<CurrencyPair | null>(pair);
  const [rates, setRates] = useState<ExchangeRate[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(RATE_HISTORY_PAGE_SIZE_DEFAULT);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  if (pair !== null && pair !== display) setDisplay(pair);

  const id = pair?.id ?? null;
  const label = display === null ? "" : `${display.fromCurrency}/${display.toCurrency}`;

  useEffect(() => {
    if (id === null) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const response = await integrationsApi.currencyPairs.rates(id, { page, pageSize });
        if (cancelled) return;
        setRates(response.items);
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

  /**
   * Asks the server for the pair's last six months, then reloads this table
   * from page one — the fetch writes older days, which is where the new rows
   * are. The list behind the drawer reloads on its own: the client announces
   * the `currency_pairs` scope after the call.
   *
   * A provider that is down or busy is not an error: the server answers 200
   * with a `history.status` saying so, and the toast repeats it as a warning.
   */
  const fetchSixMonths = async () => {
    if (id === null) return;
    setFetching(true);
    try {
      const { history } = await integrationsApi.currencyPairs.backfill(id);
      const summary = pairHistorySummary(label, history);
      if (history.status === "written") message.success(summary);
      else if (history.status === "failed") message.error(summary);
      else message.warning(summary);
      setPage(1);
      setTick((value) => value + 1);
    } catch (cause) {
      // A refusal the server means: an inactive pair (409), a pair that has
      // since been removed (404), or no permission.
      message.error(errorMessage(cause));
    } finally {
      setFetching(false);
    }
  };

  const columns: ColumnsType<ExchangeRate> = [
    {
      title: "Date",
      dataIndex: "date",
      width: 110,
      render: (value: string) => (
        <Tooltip title="The Bank of Canada's observation day. It publishes at 16:30 ET, so a morning fetch carries the previous business day.">
          <span tabIndex={0} style={{ color: surfaceColors.text }}>
            {formatDate(value)}
          </span>
        </Tooltip>
      ),
    },
    {
      title: "Rate",
      key: "rate",
      width: 190,
      render: (_value, row) => (
        <span className="tabular-nums" style={{ color: surfaceColors.text }}>
          1 {row.fromCurrency} = {row.rate.toFixed(RATE_DECIMALS)} {row.toCurrency}
        </span>
      ),
    },
    {
      title: "Source",
      dataIndex: "source",
      width: 120,
      render: (value: ExchangeRate["source"]) => <RateSourceTag source={value} />,
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
  if (loading && rates === null) {
    body = (
      <div className="flex items-center justify-center py-16">
        <Spin />
      </div>
    );
  } else if (error !== null && rates === null) {
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
  } else if (rates !== null && total === 0) {
    body = (
      <div className="py-14">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Typography.Text type="secondary">
              Nothing has been downloaded for {label} yet.{" "}
              {canWrite && display?.isActive === true
                ? "Use Fetch 6 months above to bring its history now, or wait for the daily Bank of Canada run."
                : "The daily Bank of Canada run will fetch it, or the consumer app will the next time it asks for this pair."}
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
            <ResponsiveTable<ExchangeRate>
              dataSource={rates ?? []}
              rowKey={(row) => `${row.date}-${row.fetchedAt}`}
              columns={columns}
              size="small"
              loading={loading}
              scroll={{ x: 550, y }}
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
      open={pair !== null}
      onClose={onClose}
      afterOpenChange={(open) => {
        if (!open) {
          setDisplay(null);
          setRates(null);
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
          <span>{display === null ? "Rates" : `${label} · download history`}</span>
        </span>
      }
      extra={
        <Space size="small">
          {canWrite && (
            <Tooltip
              title={
                display !== null && !display.isActive
                  ? "This pair is inactive. Activate it on the list first: an inactive pair is deliberately never fetched for."
                  : `Download the last six months (${CURRENCY_PAIR_BACKFILL_DAYS} days) from the Bank of Canada in one call, and store the days that are missing.`
              }
            >
              {/* A span so the tooltip still shows while the button is disabled. */}
              <span>
                <Button
                  size="small"
                  icon={<CloudDownloadOutlined />}
                  onClick={() => {
                    void fetchSixMonths();
                  }}
                  loading={fetching}
                  disabled={display === null || !display.isActive}
                >
                  Fetch 6 months
                </Button>
              </span>
            </Tooltip>
          )}
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => setTick((value) => value + 1)}
            loading={loading}
            disabled={fetching}
          >
            Refresh
          </Button>
        </Space>
      }
      // A column, so the table region below can be given a definite height;
      // the body keeps its own `overflow: auto` for the states that are taller
      // than it — a long error, a narrow window.
      styles={{ body: { background: surfaceColors.page, display: "flex", flexDirection: "column" } }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 [&>*]:shrink-0">
        <Typography.Text type="secondary" className="text-xs">
          Every rate stored for this pair, newest observation day first. One row per day: a day
          fetched again is overwritten rather than added, so this is the history of what was
          downloaded, not of how often it was asked for.
        </Typography.Text>
        {body}
      </div>
    </Drawer>
  );
}
