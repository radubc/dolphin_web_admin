"use client";

/**
 * The exchange-rate watch list: every currency pair the Bank of Canada run
 * keeps current, with its newest cached rate.
 *
 * The same shape as the quote watch list, and for the same reasons: a pair
 * arrives by hand or on the consumer app's first request for one, so the list
 * is paged, searched and filtered on the server, and a pair is deactivated
 * rather than deleted unless it was a mistake.
 *
 * The one thing this view has to explain is where a rate comes from. The Bank
 * of Canada publishes roughly 27 currencies against CAD and nothing else, so a
 * pair with CAD on either side is read straight from its series and every other
 * pair is the ratio of two of them — which is what the `Derived` tag on a rate
 * means, and what the rail card says in words.
 *
 * Clicking a row opens the pair's download history: every rate stored for it,
 * newest first. The two controls in the row — the active switch and the remove
 * button — stop the click before it reaches the row, so operating on a pair
 * never also opens a drawer over it.
 */

import { useState } from "react";
import { Alert, App, Button, Input, Popconfirm, Segmented, Spin, Switch, Table, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DeleteOutlined, LoadingOutlined, PlusOutlined, ReloadOutlined, SwapOutlined } from "@ant-design/icons";
import { ListEmpty, ListNoResults } from "@/components/empty-state";
import Figures from "@/components/figures";
import { ListPageFrame, ListPanel, ListTableRegion } from "@/components/list-page-frame";
import { RibbonBar, RibbonButton, RibbonDivider } from "@/components/ribbon-bar";
import StatCard from "@/components/stat-card";
import { canDo, type AdminCapabilities } from "@/lib/admin-access/types";
import { integrationsApi } from "@/lib/integrations/client";
import type { CurrencyPair } from "@/lib/integrations/types";
import { errorMessage, formatDate, formatDateTimeOrDash, formatRelativeTimeOrNever, pluralise } from "@/lib/format";
import { featureColors, surfaceColors } from "@/lib/theme/colors";
import CurrencyPairDrawer from "./currency-pair-drawer";
import CurrencyPairRatesDrawer from "./currency-pair-rates-drawer";
import { ErrorCell, INTEGRATIONS_COLOR, isToday, RateSourceTag, SourceTag } from "./integrations-meta";
import { useCurrencyPairsStore, WATCH_PAGE_SIZE_OPTIONS, type ActiveFilter } from "./use-watch-lists";

/** How many decimals a rate is shown to. Six is what the Valet API publishes. */
const RATE_DECIMALS = 6;

export default function CurrencyPairsView({
  capabilities,
  switcher,
}: {
  capabilities: AdminCapabilities;
  /** The view segmented control, drawn at the top of the body by every view. */
  switcher: React.ReactNode;
}) {
  const { message } = App.useApp();
  const store = useCurrencyPairsStore();
  const [adding, setAdding] = useState(false);
  /** The pair whose download history is open; null closes the drawer. */
  const [history, setHistory] = useState<CurrencyPair | null>(null);
  /** The row whose write is in flight, so only its switch spins. */
  const [busyId, setBusyId] = useState<string | null>(null);

  const canWrite = canDo(capabilities, "can_write_integrations");
  const canReadCurrencies = canDo(capabilities, "can_read_catalogs");

  const { items } = store;
  // Page-local: the server sends one page and its total, not a breakdown of the
  // whole list, so every figure but the total says which it is.
  const activeHere = items.filter((item) => item.isActive).length;
  const ratedToday = items.filter((item) => isToday(item.lastRatedAt)).length;
  const withErrors = items.filter((item) => item.lastError !== null && item.lastError !== "").length;

  const setActive = async (row: CurrencyPair, next: boolean) => {
    const label = `${row.fromCurrency}/${row.toCurrency}`;
    setBusyId(row.id);
    try {
      await integrationsApi.currencyPairs.update(row.id, { isActive: next });
      message.success(`${label} is now ${next ? "active" : "inactive"}.`);
    } catch (cause) {
      message.error(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (row: CurrencyPair) => {
    const label = `${row.fromCurrency}/${row.toCurrency}`;
    setBusyId(row.id);
    try {
      await integrationsApi.currencyPairs.remove(row.id);
      message.success(`Removed ${label} from the watch list.`);
    } catch (cause) {
      message.error(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  };

  /* --------------------------------- table --------------------------------- */

  const columns: ColumnsType<CurrencyPair> = [
    {
      title: "Pair",
      key: "pair",
      width: 160,
      render: (_value, row) => (
        <span className="flex items-center gap-2">
          <code style={{ color: surfaceColors.text }}>{row.fromCurrency}</code>
          <SwapOutlined aria-hidden style={{ color: surfaceColors.textTertiary }} />
          <code style={{ color: surfaceColors.text }}>{row.toCurrency}</code>
        </span>
      ),
    },
    {
      title: "Added",
      dataIndex: "source",
      width: 120,
      render: (_value, row) => <SourceTag source={row.source} />,
    },
    {
      title: "Active",
      key: "active",
      width: 90,
      render: (_value, row) =>
        canWrite ? (
          // The row opens the history drawer; operating the switch must not.
          <span onClick={(event) => event.stopPropagation()}>
            <Tooltip
              title={row.isActive ? "Deactivate: kept, but skipped by the daily run" : "Activate it"}
            >
              <Switch
                size="small"
                checked={row.isActive}
                loading={busyId === row.id}
                onChange={(next) => {
                  void setActive(row, next);
                }}
                aria-label={`${row.isActive ? "Deactivate" : "Activate"} ${row.fromCurrency}/${row.toCurrency}`}
              />
            </Tooltip>
          </span>
        ) : (
          <span style={{ color: row.isActive ? featureColors.loan : surfaceColors.textTertiary }}>
            {row.isActive ? "Yes" : "No"}
          </span>
        ),
    },
    {
      title: "Latest rate",
      key: "rate",
      width: 240,
      render: (_value, row) => {
        const rate = row.latestRate;
        if (rate === null) {
          return <span style={{ color: surfaceColors.textTertiary }}>No rate yet</span>;
        }
        return (
          <span className="flex flex-col gap-1">
            <span className="tabular-nums" style={{ color: surfaceColors.text }}>
              1 {row.fromCurrency} = {rate.rate.toFixed(RATE_DECIMALS)} {row.toCurrency}
            </span>
            <span className="flex items-center gap-2">
              <span className="text-xs" style={{ color: surfaceColors.textTertiary }}>
                {formatDate(rate.date)}
              </span>
              <RateSourceTag source={rate.source} />
            </span>
          </span>
        );
      },
    },
    {
      title: "Last rated",
      dataIndex: "lastRatedAt",
      width: 140,
      render: (value: string | null) => (
        <Tooltip title={formatDateTimeOrDash(value)}>
          <span tabIndex={0}>{formatRelativeTimeOrNever(value)}</span>
        </Tooltip>
      ),
    },
    {
      title: "Last error",
      dataIndex: "lastError",
      width: 240,
      render: (value: string | null) => <ErrorCell error={value} />,
    },
  ];

  if (canWrite) {
    columns.push({
      title: "",
      key: "actions",
      width: 60,
      align: "right",
      render: (_value, row) => (
        // Same as the switch: the confirmation and its trigger belong to the
        // row's controls, not to the row itself.
        <span onClick={(event) => event.stopPropagation()}>
          <Popconfirm
            title="Remove from the watch list"
            description={`${row.fromCurrency}/${row.toCurrency} is removed from the watch list; rates already cached for it are kept. The consumer app can add it back by asking for it.`}
            okText="Remove"
            cancelText="Cancel"
            onConfirm={() => {
              void remove(row);
            }}
          >
            <Tooltip title={`Remove ${row.fromCurrency}/${row.toCurrency}`}>
              <Button
                type="text"
                size="small"
                danger
                aria-label={`Remove ${row.fromCurrency}/${row.toCurrency}`}
                icon={<DeleteOutlined />}
                disabled={busyId === row.id}
              />
            </Tooltip>
          </Popconfirm>
        </span>
      ),
    });
  }

  /* --------------------------------- header -------------------------------- */

  const figures = (
    <Figures
      label="Currency pair totals"
      figures={[
        {
          label: "Pairs",
          value: store.total.toLocaleString(),
          tooltip: "Pairs the current filters match, across every page.",
        },
        {
          label: "Active (page)",
          value: activeHere.toLocaleString(),
          color: activeHere > 0 ? featureColors.loan : undefined,
          tooltip: "Active pairs on this page. The server sends one page, not a breakdown of the list.",
          separatorBefore: true,
        },
        {
          label: "Rated today (page)",
          value: ratedToday.toLocaleString(),
          tooltip: "Pairs on this page the Bank of Canada was read for today.",
        },
        {
          label: "Errors (page)",
          value: withErrors.toLocaleString(),
          color: withErrors > 0 ? featureColors.rule : undefined,
          tooltip: "Pairs on this page whose last fetch reported an error.",
        },
      ]}
    />
  );

  const fromBoc = items.filter((item) => item.latestRate?.source === "boc").length;
  const derived = items.filter((item) => item.latestRate?.source === "derived").length;
  const unrated = items.filter((item) => item.latestRate === null).length;

  const rail = (
    <div className="flex flex-col gap-4">
      <StatCard
        title="This page by rate source"
        icon={<SwapOutlined style={{ color: INTEGRATIONS_COLOR }} />}
        total={Math.max(1, items.length)}
        rows={[
          {
            label: "Bank of Canada",
            value: fromBoc,
            color: featureColors.loan,
            tooltip: "Read straight from the Bank of Canada's series for that currency against CAD.",
          },
          {
            label: "Derived",
            value: derived,
            color: featureColors.incomeBills,
            tooltip: "Neither side is CAD, so the rate is the ratio of the two CAD series.",
          },
          {
            label: "No rate yet",
            value: unrated,
            color: featureColors.neutral,
            tooltip: "Nothing cached for this pair yet; the next run will fetch it.",
          },
        ]}
        footnote={`Counts cover the ${pluralise(items.length, "pair")} on this page, out of ${store.total.toLocaleString()} matching.`}
      />

      <Alert
        type="info"
        showIcon
        title="Where the rates come from"
        description="The Bank of Canada's Valet API publishes roughly 27 currencies against CAD and nothing else. A pair with CAD on either side is read straight from that series (inverted for CAD → X); a pair with CAD on neither side is the ratio of the two CAD series, and is tagged Derived."
      />
    </div>
  );

  const ribbon = (
    <RibbonBar
      trailing={
        <span
          className="shrink-0 pr-1 text-right text-[11px] tabular-nums"
          style={{ color: surfaceColors.textSecondary }}
        >
          {store.refreshing && (
            <>
              <LoadingOutlined aria-hidden /> Loading…{" · "}
            </>
          )}
          {store.filtersActive
            ? `${store.total.toLocaleString()} matching`
            : pluralise(store.total, "pair")}
        </span>
      }
    >
      {canWrite && (
        <>
          <RibbonButton
            label="Add Pair"
            icon={<PlusOutlined />}
            onClick={() => setAdding(true)}
            tooltip="Add a currency pair to the exchange-rate watch list"
          />
          <RibbonDivider />
        </>
      )}

      <RibbonButton
        label="Refresh"
        icon={store.refreshing ? <LoadingOutlined /> : <ReloadOutlined />}
        onClick={store.reload}
        disabled={store.refreshing}
        tooltip="Reload this page of the watch list"
      />
    </RibbonBar>
  );

  /* ---------------------------------- body --------------------------------- */

  const toolbar = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <Input.Search
        allowClear
        value={store.search}
        loading={store.refreshing}
        placeholder="Search either currency code…"
        aria-label="Search currency pairs"
        // The query follows the box after a 300 ms pause; Enter only asks for
        // the same query sooner, so both handlers set the same state.
        onChange={(event) => store.setSearch(event.target.value)}
        onSearch={store.setSearch}
        style={{ width: 300 }}
      />

      <span role="group" aria-label="Filter by active">
        <Segmented<ActiveFilter>
          value={store.activeFilter}
          onChange={store.setActiveFilter}
          options={[
            { value: "all", label: "All" },
            { value: "active", label: "Active" },
            { value: "inactive", label: "Inactive" },
          ]}
        />
      </span>
    </div>
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
  } else if (!store.loaded) {
    body = (
      <Alert
        type="error"
        showIcon
        title="The currency pairs could not be loaded."
        description={store.error ?? undefined}
        action={
          <Button size="small" onClick={store.reload}>
            Retry
          </Button>
        }
      />
    );
  } else if (store.total === 0 && !store.filtersActive) {
    body = canWrite ? (
      <ListEmpty
        icon={<SwapOutlined />}
        color={INTEGRATIONS_COLOR}
        title="No currency pairs yet"
        description="Add one here, or let the consumer app add it the first time it asks for a rate the cache does not have."
        actionLabel="Add pair"
        onAction={() => setAdding(true)}
      />
    ) : (
      <ListPanel>
        <div className="py-14 text-center">
          <Typography.Text type="secondary">No currency pairs on the watch list yet.</Typography.Text>
        </div>
      </ListPanel>
    );
  } else {
    body = (
      <>
        {store.error !== null && <Alert type="warning" showIcon closable title={store.error} />}
        {toolbar}
        {store.total === 0 ? (
          <ListNoResults what="currency pairs" onClearFilters={store.clearFilters} />
        ) : (
          <ListTableRegion>
            {(y) => (
              <ListPanel>
                <Table<CurrencyPair>
                  dataSource={items}
                  rowKey="id"
                  columns={columns}
                  size="middle"
                  loading={store.refreshing}
                  scroll={{ x: 1050, y }}
                  onRow={(row) => ({
                    onClick: () => setHistory(row),
                    style: { cursor: "pointer" },
                  })}
                  pagination={{
                    current: store.page,
                    pageSize: store.pageSize,
                    total: store.total,
                    showSizeChanger: true,
                    pageSizeOptions: [...WATCH_PAGE_SIZE_OPTIONS],
                    showTotal: (total, range) =>
                      `${range[0].toLocaleString()}–${range[1].toLocaleString()} of ${total.toLocaleString()}`,
                    onChange: store.setPaging,
                    onShowSizeChange: store.setPaging,
                  }}
                />
              </ListPanel>
            )}
          </ListTableRegion>
        )}
      </>
    );
  }

  return (
    <>
      <ListPageFrame
        title="Integrations"
        caption="Currency pairs the daily Bank of Canada run keeps current, and the newest rate cached for each."
        figures={store.loaded ? figures : undefined}
        ribbon={ribbon}
        rail={store.loaded ? rail : undefined}
      >
        {switcher}
        {body}
      </ListPageFrame>

      <CurrencyPairDrawer
        open={adding}
        canReadCurrencies={canReadCurrencies}
        onClose={() => setAdding(false)}
        onSaved={(summary) => message.success(summary)}
      />

      <CurrencyPairRatesDrawer pair={history} onClose={() => setHistory(null)} />
    </>
  );
}
