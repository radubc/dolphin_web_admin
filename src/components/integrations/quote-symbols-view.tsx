"use client";

/**
 * The quote watch list: every symbol the quote integrations keep current, with
 * its newest cached quote, which provider last served it, and whatever that
 * provider last said about it.
 *
 * The **Provider** column is the one to read when a symbol looks stuck.
 * TwelveData's free plan refuses non-US listings, so those symbols end up
 * owned by the Alpha Vantage fallback, which has a 25-a-day quota; a TSX
 * ticker showing no provider and an error has not been reached by either yet.
 *
 * A symbol arrives one of two ways — by hand here, or the first time the
 * consumer app asks for one the cache does not have — so the list grows on its
 * own and is paged, searched and filtered entirely on the server. The table
 * draws one page and hands every page, search and filter change back to the
 * store, which fetches the next one.
 *
 * Deactivating rather than deleting is the gentler answer: an inactive symbol
 * is kept, with its quote history, and is simply skipped by the daily run.
 * Delete is offered too, because a symbol added by a typo has no business
 * sitting in the list forever, and it asks first.
 */

import { useState } from "react";
import { Alert, App, Button, Input, Popconfirm, Segmented, Spin, Switch, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DeleteOutlined, LoadingOutlined, PlusOutlined, ReloadOutlined, StockOutlined } from "@ant-design/icons";
import { ListEmpty, ListNoResults } from "@/components/empty-state";
import Figures from "@/components/figures";
import { ListPageFrame, ListPanel, ListTableRegion } from "@/components/list-page-frame";
import { RibbonBar, RibbonButton, RibbonDivider } from "@/components/ribbon-bar";
import { ResponsiveTable } from "@/components/responsive-table";
import StatCard from "@/components/stat-card";
import { canDo, type AdminCapabilities } from "@/lib/admin-access/types";
import { integrationsApi } from "@/lib/integrations/client";
import type { QuoteSymbol } from "@/lib/integrations/types";
import { QUOTE_KINDS } from "@/lib/integrations/types";
import { errorMessage, formatDate, formatDateTimeOrDash, formatRelativeTimeOrNever, pluralise } from "@/lib/format";
import { featureColors, surfaceColors } from "@/lib/theme/colors";
import {
  ErrorCell,
  INTEGRATIONS_COLOR,
  isToday,
  PercentChange,
  QUOTE_KIND_COLORS,
  QUOTE_KIND_LABELS,
  QuoteKindTag,
  QuoteProviderTag,
  SourceTag,
} from "./integrations-meta";
import QuoteSymbolDrawer from "./quote-symbol-drawer";
import { useQuoteSymbolsStore, WATCH_PAGE_SIZE_OPTIONS, type ActiveFilter, type KindFilter } from "./use-watch-lists";

/**
 * The "Symbol" column's content: the canonical ticker and, under it, the
 * name if one is known. Shared between the column's own `render` and the
 * compact card's heading so the two never drift apart — the "Kind" column is
 * first in the desktop table, but a card is named for the symbol, not its
 * kind.
 */
function renderSymbolCell(row: QuoteSymbol) {
  return (
    <span className="flex flex-col">
      <code style={{ color: surfaceColors.text }}>{row.canonical}</code>
      {row.name !== null && row.name !== "" && (
        <span className="truncate text-xs" style={{ color: surfaceColors.textTertiary }}>
          {row.name}
        </span>
      )}
    </span>
  );
}

export default function QuoteSymbolsView({
  capabilities,
  switcher,
}: {
  capabilities: AdminCapabilities;
  /** The view segmented control, drawn at the top of the body by every view. */
  switcher: React.ReactNode;
}) {
  const { message } = App.useApp();
  const store = useQuoteSymbolsStore();
  const [adding, setAdding] = useState(false);
  /** The row whose write is in flight, so only its switch spins. */
  const [busyId, setBusyId] = useState<string | null>(null);

  const canWrite = canDo(capabilities, "can_write_integrations");
  const canSearchCatalog = canDo(capabilities, "can_read_catalogs");

  const { items } = store;
  // Page-local: the server sends one page and its total, not a breakdown of the
  // whole list, so every figure but the total says which it is.
  const activeHere = items.filter((item) => item.isActive).length;
  const quotedToday = items.filter((item) => isToday(item.lastQuotedAt)).length;
  const withErrors = items.filter((item) => item.lastError !== null && item.lastError !== "").length;

  const setActive = async (row: QuoteSymbol, next: boolean) => {
    setBusyId(row.id);
    try {
      await integrationsApi.quoteSymbols.update(row.id, { isActive: next });
      message.success(`${row.canonical} is now ${next ? "active" : "inactive"}.`);
    } catch (cause) {
      message.error(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (row: QuoteSymbol) => {
    setBusyId(row.id);
    try {
      await integrationsApi.quoteSymbols.remove(row.id);
      message.success(`Removed ${row.canonical} from the watch list.`);
    } catch (cause) {
      message.error(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  };

  /* --------------------------------- table --------------------------------- */

  const columns: ColumnsType<QuoteSymbol> = [
    {
      title: "Kind",
      dataIndex: "kind",
      width: 90,
      render: (_value, row) => <QuoteKindTag kind={row.kind} />,
    },
    {
      title: "Symbol",
      key: "canonical",
      width: 190,
      render: (_value, row) => renderSymbolCell(row),
    },
    {
      title: "Exchange",
      dataIndex: "exchange",
      width: 130,
      render: (value: string | null) =>
        value === null || value === "" ? (
          <span style={{ color: surfaceColors.textTertiary }}>—</span>
        ) : (
          value
        ),
    },
    {
      title: "Currency",
      dataIndex: "currency",
      width: 100,
      render: (value: string | null) =>
        value === null || value === "" ? (
          <span style={{ color: surfaceColors.textTertiary }}>—</span>
        ) : (
          value
        ),
    },
    {
      title: "Added",
      dataIndex: "source",
      width: 120,
      render: (_value, row) => <SourceTag source={row.source} />,
    },
    {
      title: "Provider",
      dataIndex: "provider",
      width: 130,
      // Not decoration: this is the routing. A symbol Alpha Vantage owns is
      // not sent to TwelveData at all, and vice versa.
      render: (_value, row) => <QuoteProviderTag provider={row.provider} />,
    },
    {
      title: "Active",
      key: "active",
      width: 90,
      render: (_value, row) =>
        canWrite ? (
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
              aria-label={`${row.isActive ? "Deactivate" : "Activate"} ${row.canonical}`}
            />
          </Tooltip>
        ) : (
          <span style={{ color: row.isActive ? featureColors.loan : surfaceColors.textTertiary }}>
            {row.isActive ? "Yes" : "No"}
          </span>
        ),
    },
    {
      title: "Latest quote",
      key: "quote",
      width: 200,
      render: (_value, row) => {
        const quote = row.latestQuote;
        if (quote === null) {
          return <span style={{ color: surfaceColors.textTertiary }}>No quote yet</span>;
        }
        return (
          <span className="flex flex-col">
            <span className="tabular-nums" style={{ color: surfaceColors.text }}>
              {quote.close.toLocaleString("en-CA", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 6,
              })}
              {quote.currency === "" ? "" : ` ${quote.currency}`}{" "}
              <PercentChange fraction={quote.percentChange} />
            </span>
            <span className="text-xs" style={{ color: surfaceColors.textTertiary }}>
              {formatDate(quote.quoteDate)}
            </span>
          </span>
        );
      },
    },
    {
      title: "Last quoted",
      dataIndex: "lastQuotedAt",
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
      width: 220,
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
        <Popconfirm
          title="Remove from the watch list"
          description={`${row.canonical} is removed from the watch list; quotes already cached for it are kept. The consumer app can add it back by asking for it.`}
          okText="Remove"
          cancelText="Cancel"
          onConfirm={() => {
            void remove(row);
          }}
        >
          <Tooltip title={`Remove ${row.canonical}`}>
            <Button
              type="text"
              size="small"
              danger
              aria-label={`Remove ${row.canonical}`}
              icon={<DeleteOutlined />}
              disabled={busyId === row.id}
            />
          </Tooltip>
        </Popconfirm>
      ),
    });
  }

  /* --------------------------------- header -------------------------------- */

  const figures = (
    <Figures
      label="Quote watch list totals"
      figures={[
        {
          label: "Symbols",
          value: store.total.toLocaleString(),
          tooltip: "Symbols the current filters match, across every page.",
        },
        {
          label: "Active (page)",
          value: activeHere.toLocaleString(),
          color: activeHere > 0 ? featureColors.loan : undefined,
          tooltip: "Active symbols on this page. The server sends one page, not a breakdown of the list.",
          separatorBefore: true,
        },
        {
          label: "Quoted today (page)",
          value: quotedToday.toLocaleString(),
          tooltip: "Symbols on this page the provider was asked about today. The daily run skips those.",
        },
        {
          label: "Errors (page)",
          value: withErrors.toLocaleString(),
          color: withErrors > 0 ? featureColors.rule : undefined,
          tooltip: "Symbols on this page whose last fetch reported an error.",
        },
      ]}
    />
  );

  const byKind = QUOTE_KINDS.map((kind) => ({
    label: QUOTE_KIND_LABELS[kind],
    value: items.filter((item) => item.kind === kind).length,
    color: QUOTE_KIND_COLORS[kind],
    tooltip: `${QUOTE_KIND_LABELS[kind]} symbols on this page.`,
  }));

  const rail = (
    <div className="flex flex-col gap-4">
      <StatCard
        title="This page by kind"
        icon={<StockOutlined style={{ color: INTEGRATIONS_COLOR }} />}
        total={Math.max(1, items.length)}
        rows={byKind}
        footnote={`Counts cover the ${pluralise(items.length, "symbol")} on this page, out of ${store.total.toLocaleString()} matching.`}
      />

      <Alert
        type="info"
        showIcon
        title="How a symbol gets here"
        description="By hand with Add symbol, or the first time the consumer app asks for one the cache does not have. Deactivating keeps a symbol but skips it in the daily run; removing drops it from the list, and the quotes already cached for it are kept."
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
            : pluralise(store.total, "symbol")}
        </span>
      }
    >
      {canWrite && (
        <>
          <RibbonButton
            label="Add Symbol"
            icon={<PlusOutlined />}
            onClick={() => setAdding(true)}
            tooltip="Add a symbol to the quote watch list"
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
      {/* The width lives on this plain wrapper, which the search box fills: antd's own
          full-width rule on the box is unlayered and would beat a Tailwind width
          set on the box itself. Row-wide on compact, the old fixed width on desktop. */}
      <div className="w-full lg:w-[300px]">
        <Input.Search
          allowClear
          value={store.search}
          loading={store.refreshing}
          placeholder="Search symbol or name…"
          aria-label="Search quote symbols"
          // The query follows the box after a 300 ms pause; Enter only asks for
          // the same query sooner, so both handlers set the same state.
          onChange={(event) => store.setSearch(event.target.value)}
          onSearch={store.setSearch}
        />
      </div>

      <span role="group" aria-label="Filter by kind" className="max-lg:max-w-full max-lg:overflow-x-auto">
        <Segmented<KindFilter>
          value={store.kindFilter}
          onChange={store.setKindFilter}
          options={[
            { value: "all", label: "All kinds" },
            ...QUOTE_KINDS.map((kind) => ({ value: kind, label: QUOTE_KIND_LABELS[kind] })),
          ]}
        />
      </span>

      <span role="group" aria-label="Filter by active" className="max-lg:max-w-full max-lg:overflow-x-auto">
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
        title="The quote watch list could not be loaded."
        description={store.error ?? undefined}
        action={
          <Button size="small" onClick={store.reload}>
            Retry
          </Button>
        }
      />
    );
  } else if (store.total === 0 && !store.filtersActive) {
    // Nothing on the list at all — not "nothing matches", which the filters
    // below answer for.
    body = canWrite ? (
      <ListEmpty
        icon={<StockOutlined />}
        color={INTEGRATIONS_COLOR}
        title="No symbols on the quote watch list"
        description="Add one here, or let the consumer app add it the first time it asks for a quote the cache does not have."
        actionLabel="Add symbol"
        onAction={() => setAdding(true)}
      />
    ) : (
      <ListPanel>
        <div className="py-14 text-center">
          <Typography.Text type="secondary">
            No symbols on the quote watch list yet.
          </Typography.Text>
        </div>
      </ListPanel>
    );
  } else {
    body = (
      <>
        {store.error !== null && <Alert type="warning" showIcon closable title={store.error} />}
        {toolbar}
        {store.total === 0 ? (
          <ListNoResults what="symbols" onClearFilters={store.clearFilters} />
        ) : (
          <ListTableRegion>
            {(y) => (
              <ListPanel>
                <ResponsiveTable<QuoteSymbol>
                  dataSource={items}
                  rowKey="id"
                  columns={columns}
                  size="middle"
                  loading={store.refreshing}
                  scroll={{ x: 1320, y }}
                  compact={{ title: (row) => renderSymbolCell(row), titleColumn: "canonical" }}
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
        caption="Symbols the daily quote run keeps current, and the newest quote cached for each."
        figures={store.loaded ? figures : undefined}
        ribbon={ribbon}
        rail={store.loaded ? rail : undefined}
      >
        {switcher}
        {body}
      </ListPageFrame>

      <QuoteSymbolDrawer
        open={adding}
        canSearchCatalog={canSearchCatalog}
        onClose={() => setAdding(false)}
        onSaved={(summary) => message.success(summary)}
      />
    </>
  );
}
