"use client";

/**
 * Constants: the reference catalogs the admin database masters — countries,
 * currencies, financial institutions, the default category tree, the account
 * base types and account types an account is opened as, and the market-data
 * catalogs (cryptocurrencies, ETFs, stocks and the markets they trade on) —
 * with what each row's state is against the main app database and the means to
 * put it right.
 *
 * The screen wears the app's list-page frame: figures in the header band,
 * every action on the ribbon across the top, the table taking the width, and
 * the push-state breakdown on a card down the right rail. A segmented control
 * under the ribbon switches catalogs; the choice is written into `?kind=` with
 * `history.replaceState`, so a reload or a shared link lands on the same one
 * without a server round trip.
 *
 * Built for catalogs of hundreds of thousands of rows. Nothing is ever loaded
 * whole: the store asks for one page and the server answers with that page, the
 * whole-catalog counts and the newest job. The counts therefore come from the
 * *ledger* a compare job filled, which is why "Last compared" sits on the
 * ribbon next to every button that trusts it, and why a row no compare has
 * reached reads "Not compared" instead of pretending to be in sync.
 *
 * Compare and push are jobs on the server. A small push finishes inside its
 * request; a big one comes back running and is followed by `useJobPolling`,
 * which draws the progress strip and reports the result. While a job runs for
 * the catalog on screen, every write here is held: the API refuses a second one
 * with 409 anyway.
 *
 * "Push" upserts rows into the main app database by id and never deletes
 * there: rows in the main app are referenced by tenant data, so removal stays
 * a deliberate operation on the consumer side. That sentence is on the rail
 * card, because it is the one thing an operator must know before pressing it.
 */

import { useCallback, useState } from "react";
import { Alert, App, Button, Empty, Segmented, Spin, Typography } from "antd";
import { DatabaseOutlined } from "@ant-design/icons";
import { ListEmpty, ListNoResults } from "@/components/empty-state";
import Figures from "@/components/figures";
import { ListPageFrame, ListPanel, ListTableRegion } from "@/components/list-page-frame";
import StatCard from "@/components/stat-card";
import { ApiClientError } from "@/lib/api/client";
import { canDo, type AdminCapabilities } from "@/lib/admin-access/types";
import { constantsApi } from "@/lib/constants/client";
import {
  CONSTANT_KINDS,
  isPulledKind,
  PUSH_IDS_MAX,
  type ConstantKind,
  type ConstantRow,
  type PushInput,
} from "@/lib/constants/types";
import { errorMessage } from "@/lib/format";
import ConstantFormDrawer, { type ConstantFormTarget } from "./constant-form-drawer";
import ConstantsJobStrip from "./constants-job-strip";
import {
  CONSTANTS_COLOR,
  countOfRows,
  KIND_META,
  PUSH_STATE_META,
  RETIRED_COLOR,
} from "./constants-meta";
import ConstantsRibbon from "./constants-ribbon";
import ConstantsTable from "./constants-table";
import ConstantsToolbar from "./constants-toolbar";
import { useConstantsStore } from "./use-constants-store";
import { useJobPolling } from "./use-job-polling";

interface ConstantsPageProps {
  /** The signed-in operator, resolved on the server. */
  capabilities: AdminCapabilities;
  /** From `?kind=`, so a link opens on the catalog it names. */
  initialKind?: ConstantKind;
}

export default function ConstantsPage({ capabilities, initialKind }: ConstantsPageProps) {
  const { message, notification } = App.useApp();
  const store = useConstantsStore(initialKind ?? "countries");
  const jobs = useJobPolling(store.kind, store.latestJob);
  const [formTarget, setFormTarget] = useState<ConstantFormTarget | null>(null);
  /** A push or compare request is in flight; the job it starts is `jobs.running`. */
  const [requesting, setRequesting] = useState(false);

  const canWrite = canDo(capabilities, "can_write_catalogs");
  const meta = KIND_META[store.kind];
  // Pulled by the consumer app at tenant creation instead of pushed from here:
  // every compare/push surface on the page drops out for these two kinds.
  const pulled = isPulledKind(store.kind);
  const { counts } = store;
  const pendingCount = counts.new + counts.changed;
  // One flag for "no write may start now", whether that is a request on its way
  // out or a job the server is already running.
  const busy = requesting || jobs.running;

  const { setKind } = store;
  const changeKind = useCallback(
    (next: ConstantKind) => {
      setKind(next);
      // Shallow: the URL keeps up with the screen without re-running the
      // Server Component, which would only re-check the same page access.
      window.history.replaceState(null, "", `?kind=${encodeURIComponent(next)}`);
    },
    [setKind],
  );

  /* --------------------------------- writes -------------------------------- */

  const openAdd = () => {
    // The kind decides the field set; a new row is `row: null` in that kind.
    switch (store.kind) {
      case "countries":
        setFormTarget({ kind: "countries", row: null });
        break;
      case "currencies":
        setFormTarget({ kind: "currencies", row: null });
        break;
      case "financial_institutions":
        setFormTarget({ kind: "financial_institutions", row: null });
        break;
      case "categories":
        setFormTarget({ kind: "categories", row: null });
        break;
      case "account_base_types":
        setFormTarget({ kind: "account_base_types", row: null });
        break;
      case "account_types":
        setFormTarget({ kind: "account_types", row: null });
        break;
      case "cryptocurrencies":
        setFormTarget({ kind: "cryptocurrencies", row: null });
        break;
      case "etfs":
        setFormTarget({ kind: "etfs", row: null });
        break;
      case "stocks":
        setFormTarget({ kind: "stocks", row: null });
        break;
      case "markets":
        setFormTarget({ kind: "markets", row: null });
        break;
    }
  };

  /** The 409 the API answers with when a job for this kind is already running. */
  const reportFailure = (cause: unknown) => {
    if (cause instanceof ApiClientError && cause.status === 409) {
      notification.warning({
        title: "Another job is already running",
        description: cause.message,
        duration: 6,
      });
      return;
    }
    message.error(errorMessage(cause));
  };

  /**
   * Starts a push and hands the job it returns to the poller. A push of at most
   * `PUSH_INLINE_MAX` rows comes back already finished, and `constantsApi` has
   * announced the change itself, so the store reloads either way.
   */
  const runPush = async (input: PushInput, options: { clearSelection?: boolean } = {}) => {
    // The API refuses an empty `ids` array rather than treating it as
    // "everything": the Popconfirm this closes over can go stale if the store
    // reloads out from under it while it is open, so the guard has to live
    // here too, not just in the button's `disabled`.
    if (input.ids !== undefined) {
      if (input.ids.length === 0) {
        message.info("Nothing selected.");
        return;
      }
      if (input.ids.length > PUSH_IDS_MAX) {
        message.warning(
          `A push by selection takes at most ${PUSH_IDS_MAX.toLocaleString()} rows. Untick some, or use Push pending or Push all.`,
        );
        return;
      }
    }
    setRequesting(true);
    try {
      const job = await constantsApi.push(store.kind, input);
      jobs.track(job);
      // The ids are the server's now; a selection kept past that would push the
      // same rows twice on the next click.
      if (options.clearSelection === true) store.clearSelection();
    } catch (cause) {
      reportFailure(cause);
    } finally {
      setRequesting(false);
    }
  };

  /** Rebuilds the sync ledger for the kind: always a job, never inline. */
  const runCompare = async () => {
    setRequesting(true);
    try {
      jobs.track(await constantsApi.compare(store.kind));
    } catch (cause) {
      reportFailure(cause);
    } finally {
      setRequesting(false);
    }
  };

  const handleDelete = async (row: ConstantRow, label: string) => {
    const retires = meta.retires;
    try {
      await constantsApi.remove(store.kind, row.id);
      message.success(retires ? `Retired ${label}.` : `Deleted ${label}.`);
    } catch (cause) {
      message.error(errorMessage(cause));
    }
  };

  /* --------------------------------- header -------------------------------- */

  const figures = (
    <Figures
      label="Catalog totals"
      figures={[
        {
          label: meta.label,
          value: counts.total.toLocaleString(),
          tooltip: `Rows in the admin catalog of ${meta.plural}. The filters do not narrow this figure.`,
        },
        // Pulled by the consumer app rather than pushed from here: these four
        // figures are all push state, which no longer applies.
        ...(pulled
          ? []
          : [
              {
                label: "Not pushed",
                value: counts.new.toLocaleString(),
                color: counts.new > 0 ? PUSH_STATE_META.new.color : undefined,
                tooltip: PUSH_STATE_META.new.tooltip,
                separatorBefore: true,
              },
              {
                label: "Changed",
                value: counts.changed.toLocaleString(),
                color: counts.changed > 0 ? PUSH_STATE_META.changed.color : undefined,
                tooltip: PUSH_STATE_META.changed.tooltip,
              },
              {
                label: "In sync",
                value: counts.synced.toLocaleString(),
                color: PUSH_STATE_META.synced.color,
                tooltip: PUSH_STATE_META.synced.tooltip,
              },
              {
                label: "Not compared",
                value: counts.unknown.toLocaleString(),
                color: counts.unknown > 0 ? PUSH_STATE_META.unknown.color : undefined,
                tooltip: PUSH_STATE_META.unknown.tooltip,
              },
            ]),
        ...(meta.retires
          ? [
              {
                label: "Retired",
                value: counts.retired.toLocaleString(),
                tooltip: pulled
                  ? `Retired ${meta.plural}. They stay in the catalog.`
                  : `Retired ${meta.plural}. They stay in the catalog and are still pushed.`,
                separatorBefore: true,
              },
            ]
          : []),
      ]}
    />
  );

  const rail = (
    <div className="flex flex-col gap-4">
      {pulled ? (
        <Alert
          type="info"
          showIcon
          title="Pulled by the consumer app, not pushed"
          description="Pulled by the consumer app when a new account is created; edits here become the defaults for accounts created from now on. Existing accounts keep their own copies."
        />
      ) : (
        <StatCard
          title={`${meta.label} vs the main app`}
          icon={<DatabaseOutlined style={{ color: CONSTANTS_COLOR }} />}
          // The whole catalog is the denominator, so every bar reads as a share
          // of it even when the states do not add up to it yet.
          total={Math.max(1, counts.total)}
          rows={[
            {
              label: PUSH_STATE_META.new.label,
              value: counts.new,
              color: PUSH_STATE_META.new.color,
              tooltip: PUSH_STATE_META.new.tooltip,
            },
            {
              label: PUSH_STATE_META.changed.label,
              value: counts.changed,
              color: PUSH_STATE_META.changed.color,
              tooltip: PUSH_STATE_META.changed.tooltip,
            },
            {
              label: PUSH_STATE_META.synced.label,
              value: counts.synced,
              color: PUSH_STATE_META.synced.color,
              tooltip: PUSH_STATE_META.synced.tooltip,
            },
            {
              label: PUSH_STATE_META.unknown.label,
              value: counts.unknown,
              color: PUSH_STATE_META.unknown.color,
              tooltip: PUSH_STATE_META.unknown.tooltip,
            },
            ...(meta.retires
              ? [
                  {
                    label: "Retired",
                    value: counts.retired,
                    color: RETIRED_COLOR,
                    tooltip: "Retired here; the push carries the retirement over.",
                  },
                ]
              : []),
          ]}
          footnote="Push upserts rows into the main app database by id and never deletes there."
        />
      )}

      {store.kind === "countries" && store.currenciesError !== null && (
        <Alert
          type="warning"
          showIcon
          title="Currencies could not be loaded; currency names show as ids."
          description={store.currenciesError}
        />
      )}

      {store.kind === "account_types" && store.baseTypesError !== null && (
        <Alert
          type="warning"
          showIcon
          title="Account base types could not be loaded; base types show as ids."
          description={store.baseTypesError}
        />
      )}

      {!pulled && counts.mainOnly > 0 && (
        <Alert
          type="info"
          showIcon
          title={`${countOfRows(counts.mainOnly)} exist only in the main app.`}
          description="The last compare found ids there that the admin catalog does not have, so nothing here will change them. Removing rows from the main app is a manual, deliberate operation on the consumer side."
        />
      )}
    </div>
  );

  /* ---------------------------------- body --------------------------------- */

  // Ten catalogs long outgrew a narrow layout, so the switcher sits in a strip
  // that scrolls sideways rather than clipping or squeezing its labels.
  const switcher = (
    <div className="max-w-full overflow-x-auto pb-1">
      <span role="group" aria-label="Catalog" className="inline-block min-w-max">
        <Segmented<ConstantKind>
          value={store.kind}
          onChange={changeKind}
          // Only held while a request is on its way out. A job can run for
          // minutes; locking the operator out of the other nine catalogs for
          // that long would be worse than losing sight of its progress, which
          // the list picks up again from `latestJob` on the way back.
          disabled={requesting}
          options={CONSTANT_KINDS.map((kind) => ({
            value: kind,
            label: KIND_META[kind].label,
            icon: KIND_META[kind].icon,
          }))}
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
  } else if (store.list === null) {
    body = (
      <Alert
        type="error"
        showIcon
        title={`The ${meta.plural} catalog could not be loaded.`}
        description={store.error ?? undefined}
        action={
          <Button size="small" onClick={store.reload}>
            Retry
          </Button>
        }
      />
    );
  } else if (counts.total === 0) {
    // Nothing in the catalog at all — not "nothing matches", which the filters
    // below answer for.
    body = canWrite ? (
      <ListEmpty
        icon={meta.icon}
        color={CONSTANTS_COLOR}
        title={`No ${meta.plural} yet`}
        description={meta.blurb}
        actionLabel={`Add ${meta.singular}`}
        onAction={openAdd}
      />
    ) : (
      <ListPanel>
        <div className="py-14">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Typography.Text type="secondary">
                No {meta.plural} in the admin catalog yet.
              </Typography.Text>
            }
          />
        </div>
      </ListPanel>
    );
  } else {
    body = (
      <>
        {store.error !== null && <Alert type="warning" showIcon closable title={store.error} />}

        <ConstantsToolbar
          kind={store.kind}
          search={store.search}
          stateFilter={store.stateFilter}
          market={store.market}
          searching={store.refreshing}
          disabled={requesting}
          onSearchChange={store.setSearch}
          onStateFilterChange={store.setStateFilter}
          onMarketChange={store.setMarket}
        />

        {store.total === 0 ? (
          <ListNoResults what={meta.plural} onClearFilters={store.clearFilters} />
        ) : (
          <ListTableRegion>
            <ListPanel>
              <ConstantsTable
                list={store.list}
                currencies={store.currencies}
                baseTypes={store.baseTypes}
                categories={store.categories}
                canWrite={canWrite}
                busy={busy}
                loading={store.refreshing}
                page={store.page}
                pageSize={store.pageSize}
                total={store.total}
                onPagingChange={store.setPaging}
                selectedIds={store.selectedIds}
                onSelectionChange={store.setSelectedIds}
                onEdit={setFormTarget}
                onPush={(row) => {
                  // One row is always inline: the notification comes from the
                  // poller and the store reloads on the change announcement.
                  void runPush({ ids: [row.id] });
                }}
                onDelete={(row, label) => {
                  void handleDelete(row, label);
                }}
              />
            </ListPanel>
          </ListTableRegion>
        )}
      </>
    );
  }

  const ribbon = (
    <ConstantsRibbon
      kind={store.kind}
      canWrite={canWrite}
      busy={busy}
      refreshing={store.refreshing}
      selectedCount={store.selectedIds.length}
      filteredCount={store.total}
      totalCount={counts.total}
      pendingCount={pendingCount}
      lastComparedAt={store.lastComparedAt}
      onAdd={openAdd}
      onPushSelected={() => {
        void runPush({ ids: store.selectedIds }, { clearSelection: true });
      }}
      onPushPending={() => {
        void runPush({ scope: "pending" });
      }}
      onPushAll={() => {
        void runPush({ scope: "all" });
      }}
      onCompare={() => {
        void runCompare();
      }}
      onRefresh={store.reload}
    />
  );

  return (
    <>
      <ListPageFrame
        title="Constants"
        caption="Reference data shared by every tenant."
        figures={store.loading || store.list === null ? undefined : figures}
        ribbon={ribbon}
        rail={store.loading || store.list === null ? undefined : rail}
      >
        {!pulled && jobs.running && jobs.job !== null && <ConstantsJobStrip job={jobs.job} />}
        {switcher}
        {body}
      </ListPageFrame>

      <ConstantFormDrawer
        target={formTarget}
        currencies={store.currencies}
        currenciesError={store.currenciesError}
        baseTypes={store.baseTypes}
        baseTypesError={store.baseTypesError}
        categories={store.categories}
        institutionTypes={store.institutionTypes}
        onClose={() => setFormTarget(null)}
        onSaved={(summary) => message.success(summary)}
      />
    </>
  );
}
