"use client";

/**
 * Constants: the four reference catalogs the admin database masters —
 * countries, currencies, financial institutions and the default category tree
 * — with what each row's state is against the main app database and the means
 * to put it right.
 *
 * The screen wears the app's list-page frame: figures in the header band,
 * every action on the ribbon across the top, the table taking the width, and
 * the push-state breakdown on a card down the right rail. A segmented control
 * under the ribbon switches catalogs; the choice is written into `?kind=` with
 * `history.replaceState`, so a reload or a shared link lands on the same one
 * without a server round trip.
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
import { ListPageFrame, ListPanel } from "@/components/list-page-frame";
import StatCard from "@/components/stat-card";
import { canDo, type AdminCapabilities } from "@/lib/admin-access/types";
import { constantsApi } from "@/lib/constants/client";
import {
  CONSTANT_KINDS,
  type ConstantKind,
  type ConstantRow,
  type PushInput,
} from "@/lib/constants/types";
import { errorMessage, pluralise } from "@/lib/format";
import ConstantFormDrawer, { type ConstantFormTarget } from "./constant-form-drawer";
import {
  CONSTANTS_COLOR,
  KIND_META,
  PUSH_STATE_META,
  RETIRED_COLOR,
} from "./constants-meta";
import ConstantsRibbon from "./constants-ribbon";
import ConstantsTable from "./constants-table";
import ConstantsToolbar from "./constants-toolbar";
import { useConstantsStore } from "./use-constants-store";

interface ConstantsPageProps {
  /** The signed-in operator, resolved on the server. */
  capabilities: AdminCapabilities;
  /** From `?kind=`, so a link opens on the catalog it names. */
  initialKind?: ConstantKind;
}

export default function ConstantsPage({ capabilities, initialKind }: ConstantsPageProps) {
  const { message, notification } = App.useApp();
  const store = useConstantsStore(initialKind ?? "countries");
  const [formTarget, setFormTarget] = useState<ConstantFormTarget | null>(null);
  const [pushing, setPushing] = useState(false);

  const canWrite = canDo(capabilities, "can_write_catalogs");
  const meta = KIND_META[store.kind];
  const { counts } = store;

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
    }
  };

  const runPush = async (input: PushInput, what: string) => {
    // The API refuses an empty `ids` array with 422 rather than treating it as
    // "everything": the Popconfirm this closes over can go stale if the store
    // reloads out from under it while it is open, so the guard has to live
    // here too, not just in the button's `disabled`.
    if (input.ids !== undefined && input.ids.length === 0) {
      message.info("Nothing selected.");
      return;
    }
    setPushing(true);
    try {
      const result = await constantsApi.push(store.kind, input);
      const dependencies = result.dependencies.reduce(
        (total, entry) => total + entry.results.length,
        0,
      );
      notification.success({
        title: `Pushed ${what}`,
        description: (
          <span>
            {result.created} created · {result.updated} updated · {result.unchanged} unchanged.
            {dependencies > 0 && (
              <>
                {" "}
                {pluralise(dependencies, "dependent row")} pushed first so the references hold.
              </>
            )}
          </span>
        ),
        duration: 6,
      });
    } catch (cause) {
      message.error(errorMessage(cause));
    } finally {
      setPushing(false);
    }
  };

  const handleDelete = async (row: ConstantRow, label: string) => {
    const retires = store.kind === "categories";
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
          value: `${counts.total}`,
          tooltip: `Rows in the admin catalog of ${meta.plural}. The filters do not narrow this figure.`,
        },
        {
          label: "Not pushed",
          value: `${counts.new}`,
          color: counts.new > 0 ? PUSH_STATE_META.new.color : undefined,
          tooltip: PUSH_STATE_META.new.tooltip,
          separatorBefore: true,
        },
        {
          label: "Changed",
          value: `${counts.changed}`,
          color: counts.changed > 0 ? PUSH_STATE_META.changed.color : undefined,
          tooltip: PUSH_STATE_META.changed.tooltip,
        },
        {
          label: "In sync",
          value: `${counts.synced}`,
          color: PUSH_STATE_META.synced.color,
          tooltip: PUSH_STATE_META.synced.tooltip,
        },
        ...(store.kind === "categories"
          ? [
              {
                label: "Retired",
                value: `${counts.retired}`,
                tooltip: "Retired categories. They stay in the list and are still pushed.",
                separatorBefore: true,
              },
            ]
          : []),
      ]}
    />
  );

  const rail = (
    <div className="flex flex-col gap-4">
      <StatCard
        title={`${meta.label} vs the main app`}
        icon={<DatabaseOutlined style={{ color: CONSTANTS_COLOR }} />}
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
          ...(store.kind === "categories"
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

      {store.kind === "countries" && store.currenciesError !== null && (
        <Alert
          type="warning"
          showIcon
          title="Currencies could not be loaded; currency names show as ids."
          description={store.currenciesError}
        />
      )}

      {store.list !== null && store.list.mainOnlyIds.length > 0 && (
        <Alert
          type="info"
          showIcon
          title={`${pluralise(store.list.mainOnlyIds.length, "row")} exist only in the main app.`}
          description="They are not in the admin catalog, so nothing here will change them. Removing rows from the main app is a manual, deliberate operation on the consumer side."
        />
      )}
    </div>
  );

  /* ---------------------------------- body --------------------------------- */

  const switcher = (
    <span role="group" aria-label="Catalog">
      <Segmented<ConstantKind>
        value={store.kind}
        onChange={changeKind}
        disabled={pushing}
        options={CONSTANT_KINDS.map((kind) => ({
          value: kind,
          label: KIND_META[kind].label,
          icon: KIND_META[kind].icon,
        }))}
      />
    </span>
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
  } else if (store.list.rows.length === 0) {
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
          onSearchChange={store.setSearch}
          onStateFilterChange={store.setStateFilter}
        />

        {store.visible === null || store.visible.rows.length === 0 ? (
          <ListNoResults what={meta.plural} onClearFilters={store.clearFilters} />
        ) : (
          <ListPanel>
            <ConstantsTable
              list={store.visible}
              currencies={store.currencies}
              categories={store.categories}
              canWrite={canWrite}
              busy={pushing}
              selectedIds={store.selectedIds}
              onSelectionChange={store.setSelectedIds}
              onEdit={setFormTarget}
              onPush={(row, label) => {
                void runPush({ ids: [row.id] }, label);
              }}
              onDelete={(row, label) => {
                void handleDelete(row, label);
              }}
            />
          </ListPanel>
        )}
      </>
    );
  }

  const ribbon = (
    <ConstantsRibbon
      kind={store.kind}
      canWrite={canWrite}
      busy={pushing}
      refreshing={store.refreshing}
      selectedCount={store.selectedVisibleIds.length}
      filteredCount={store.visible?.rows.length ?? 0}
      totalCount={counts.total}
      comparedAt={store.list?.comparedAt ?? null}
      onAdd={openAdd}
      onPushSelected={() => {
        void runPush(
          { ids: store.selectedVisibleIds },
          pluralise(store.selectedVisibleIds.length, meta.singular, meta.plural),
        );
      }}
      onPushAll={() => {
        void runPush({}, `every ${meta.singular}`);
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
        {switcher}
        {body}
      </ListPageFrame>

      <ConstantFormDrawer
        target={formTarget}
        currencies={store.currencies}
        currenciesError={store.currenciesError}
        categories={store.categories}
        institutionTypes={store.institutionTypes}
        onClose={() => setFormTarget(null)}
        onSaved={(summary) => message.success(summary)}
      />
    </>
  );
}
