"use client";

/**
 * The Constants ribbon: Add, Push selected, Push all and Refresh.
 *
 * Push is a write against the *main app* database, so all three write buttons
 * need `can_write_catalogs`; an operator without it sees Refresh alone rather
 * than a row of dead controls. Within the write set the buttons stay visible
 * and only change their enabled state, so the bar never reflows as a selection
 * changes.
 *
 * Both bulk pushes ask first: they can write hundreds of rows into the app the
 * customers use, and the count in the confirmation is the last chance to
 * notice that the wrong catalog is on screen.
 */

import { Popconfirm } from "antd";
import {
  CloudUploadOutlined,
  LoadingOutlined,
  PlusOutlined,
  ReloadOutlined,
  SelectOutlined,
} from "@ant-design/icons";
import { RibbonBar, RibbonButton } from "@/components/ribbon-bar";
import type { ConstantKind } from "@/lib/constants/types";
import { formatRelativeTimeOrNever, pluralise } from "@/lib/format";
import { surfaceColors } from "@/lib/theme/colors";
import { KIND_META } from "./constants-meta";

interface ConstantsRibbonProps {
  kind: ConstantKind;
  canWrite: boolean;
  /** A push is running: every write is held until it lands. */
  busy: boolean;
  /** A refresh is running. Distinct from `busy`: it never blanks the table. */
  refreshing: boolean;
  selectedCount: number;
  filteredCount: number;
  totalCount: number;
  /** When the rows on screen were compared with the main app. */
  comparedAt: string | null;
  onAdd: () => void;
  onPushSelected: () => void;
  onPushAll: () => void;
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
  comparedAt,
  onAdd,
  onPushSelected,
  onPushAll,
  onRefresh,
}: ConstantsRibbonProps) {
  const meta = KIND_META[kind];

  const readout = (
    <span
      className="shrink-0 pr-1 text-right text-[11px] tabular-nums"
      style={{ color: surfaceColors.textSecondary }}
    >
      {busy && (
        <>
          <LoadingOutlined aria-hidden /> Pushing to the main app…{" · "}
        </>
      )}
      {filteredCount} of {pluralise(totalCount, meta.singular, meta.plural)}
      {comparedAt !== null && (
        <>
          {" · compared "}
          {formatRelativeTimeOrNever(comparedAt)}
        </>
      )}
    </span>
  );

  return (
    <RibbonBar trailing={readout}>
      {canWrite && (
        <>
          <RibbonButton
            label={`Add ${meta.singular === "financial institution" ? "institution" : meta.singular}`}
            icon={<PlusOutlined />}
            onClick={onAdd}
            disabled={busy}
            tooltip={`Add a ${meta.singular} to the admin catalog`}
          />

          <Popconfirm
            title="Push the ticked rows"
            description={`Upsert ${pluralise(selectedCount, "row")} into the main app database. Nothing is deleted there.`}
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
                    : `Push ${pluralise(selectedCount, "ticked row")} to the main app`
                }
              />
            </span>
          </Popconfirm>

          <Popconfirm
            title={`Push every ${meta.singular}`}
            description={`Upsert all ${pluralise(totalCount, meta.singular, meta.plural)} into the main app database, filters ignored. Nothing is deleted there.`}
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
        </>
      )}

      <RibbonButton
        label="Refresh"
        icon={refreshing ? <LoadingOutlined /> : <ReloadOutlined />}
        onClick={onRefresh}
        disabled={busy || refreshing}
        tooltip="Reload the catalog and compare it with the main app again"
      />
    </RibbonBar>
  );
}
