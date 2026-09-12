"use client";

/**
 * The Constants ribbon: Add, Push selected, Push pending, Push all, Compare and
 * Refresh.
 *
 * Push is a write against the *main app* database and Compare reads all of it,
 * so every one of those needs `can_write_catalogs`; an operator without it sees
 * Refresh alone rather than a row of dead controls. Within the write set the
 * buttons stay visible and only change their enabled state, so the bar never
 * reflows as a selection changes.
 *
 * Every bulk push asks first: it can write hundreds of thousands of rows into
 * the app the customers use, and the count in the confirmation is the last
 * chance to notice that the wrong catalog is on screen.
 *
 * The read-out carries the two figures the buttons above it depend on — how
 * many rows the current query matches out of the catalog, and when the catalog
 * was last compared, since every push state on screen is only as true as that
 * compare.
 *
 * `categories` and `financial_institutions` are pulled by the consumer app
 * rather than pushed from here (`isPulledKind`), so this bar drops the four
 * push/compare controls and the "Last compared" read-out for them; Add and
 * Refresh stay exactly as they are for every kind.
 */

import { Popconfirm } from "antd";
import {
  CloudUploadOutlined,
  DiffOutlined,
  LoadingOutlined,
  PlusOutlined,
  ReloadOutlined,
  SelectOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { RibbonBar, RibbonButton, RibbonDivider } from "@/components/ribbon-bar";
import { isPulledKind, type ConstantKind } from "@/lib/constants/types";
import { formatRelativeTime } from "@/lib/format";
import { surfaceColors } from "@/lib/theme/colors";
import { countOfKind, countOfRows, KIND_META } from "./constants-meta";

interface ConstantsRibbonProps {
  kind: ConstantKind;
  canWrite: boolean;
  /** A push or compare is in flight, or a job for this kind is running. */
  busy: boolean;
  /** A list fetch is running. Distinct from `busy`: it never blanks the table. */
  refreshing: boolean;
  /** Ticked rows, across every page. */
  selectedCount: number;
  /** Rows the current query matches, all pages. */
  filteredCount: number;
  /** Every row in the catalog, filters ignored. */
  totalCount: number;
  /** New + changed: what "Push pending" would write. */
  pendingCount: number;
  /** When the last compare job for this kind finished. */
  lastComparedAt: string | null;
  onAdd: () => void;
  onPushSelected: () => void;
  onPushPending: () => void;
  onPushAll: () => void;
  onCompare: () => void;
  onRefresh: () => void;
}

export default function ConstantsRibbon({
  kind,
  canWrite,
  busy,
  refreshing,
  selectedCount,
  filteredCount,
  totalCount,
  pendingCount,
  lastComparedAt,
  onAdd,
  onPushSelected,
  onPushPending,
  onPushAll,
  onCompare,
  onRefresh,
}: ConstantsRibbonProps) {
  const meta = KIND_META[kind];
  const filtered = filteredCount !== totalCount;
  // Pulled by the consumer app instead of pushed from here: compare and push
  // no longer apply, so neither the buttons nor "Last compared" belong on
  // this kind's ribbon.
  const pulled = isPulledKind(kind);

  const readout = (
    <span
      className="shrink-0 pr-1 text-right text-[11px] tabular-nums"
      style={{ color: surfaceColors.textSecondary }}
    >
      {busy && (
        <>
          <LoadingOutlined aria-hidden /> Working…{" · "}
        </>
      )}
      {filtered
        ? `${filteredCount.toLocaleString()} of ${countOfKind(totalCount, kind)}`
        : countOfKind(totalCount, kind)}
      {!pulled && (
        <>
          {" · "}
          {lastComparedAt === null
            ? "Never compared"
            : `Last compared ${formatRelativeTime(lastComparedAt).toLowerCase()}`}
        </>
      )}
    </span>
  );

  return (
    <RibbonBar trailing={readout}>
      {canWrite && (
        <>
          <RibbonButton
            label={`Add ${meta.addLabel}`}
            icon={<PlusOutlined />}
            onClick={onAdd}
            disabled={busy}
            tooltip={`Add a ${meta.singular} to the admin catalog`}
          />

          {!pulled && (
            <>
              <Popconfirm
                title="Push the ticked rows"
                description={`Upsert ${countOfRows(selectedCount)} into the main app database. Nothing is deleted there.`}
                okText="Push"
                cancelText="Cancel"
                disabled={busy || selectedCount === 0}
                onConfirm={onPushSelected}
              >
                <span className="inline-flex">
                  <RibbonButton
                    label="Push Selected"
                    icon={busy ? <LoadingOutlined /> : <SelectOutlined />}
                    disabled={busy || selectedCount === 0}
                    tooltip={
                      selectedCount === 0
                        ? "Tick the rows to push"
                        : `Push ${countOfRows(selectedCount)} to the main app`
                    }
                  />
                </span>
              </Popconfirm>

              <Popconfirm
                title="Push everything pending"
                description={`Upsert the ${countOfRows(pendingCount)} that are new or changed into the main app database. Nothing is deleted there.`}
                okText="Push pending"
                cancelText="Cancel"
                disabled={busy || pendingCount === 0}
                onConfirm={onPushPending}
              >
                <span className="inline-flex">
                  <RibbonButton
                    label="Push Pending"
                    icon={busy ? <LoadingOutlined /> : <ThunderboltOutlined />}
                    disabled={busy || pendingCount === 0}
                    tooltip={
                      pendingCount === 0
                        ? "Nothing is new or changed; compare again if you expected some"
                        : `Push the ${countOfRows(pendingCount)} that are new or changed`
                    }
                  />
                </span>
              </Popconfirm>

              <Popconfirm
                title={`Push every ${meta.singular}`}
                description={`Upsert all ${countOfKind(totalCount, kind)} into the main app database, filters ignored. Nothing is deleted there.`}
                okText="Push all"
                cancelText="Cancel"
                disabled={busy || totalCount === 0}
                onConfirm={onPushAll}
              >
                <span className="inline-flex">
                  <RibbonButton
                    label="Push All"
                    icon={busy ? <LoadingOutlined /> : <CloudUploadOutlined />}
                    disabled={busy || totalCount === 0}
                    tooltip={`Push the whole ${meta.singular} catalog to the main app`}
                  />
                </span>
              </Popconfirm>

              <RibbonDivider />

              <RibbonButton
                label="Compare"
                icon={busy ? <LoadingOutlined /> : <DiffOutlined />}
                onClick={onCompare}
                disabled={busy || totalCount === 0}
                tooltip="Walk the catalog against the main app and rebuild every row's push state"
              />
            </>
          )}
        </>
      )}

      <RibbonButton
        label="Refresh"
        icon={refreshing ? <LoadingOutlined /> : <ReloadOutlined />}
        onClick={onRefresh}
        disabled={refreshing}
        tooltip="Reload this page of the catalog and its figures"
      />
    </RibbonBar>
  );
}
