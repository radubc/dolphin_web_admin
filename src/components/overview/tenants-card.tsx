/**
 * Overview → "Largest tenants": the five tenants holding the most attachment
 * bytes.
 *
 * Bytes rather than rows because bytes are what the bill and a retention
 * conversation are about, and because they are exact: the figure is the sum of
 * live `file_blobs.byte_size` per tenant, read straight from the main app
 * database with no AWS call and no estimate. The Customers page's Activity
 * view ranks the same tenants by transactions as well.
 *
 * A tenant whose row is gone but whose data is not has a null name; the id's
 * head stands in, which is enough to find it.
 */

import type { TenantSize } from "@/lib/customers/types";
import { formatBytes, pluralise } from "@/lib/format";
import { featureColors } from "@/lib/theme/colors";
import type { Loaded } from "@/lib/ops/types";
import { BarRow, NotAvailable, OverviewCard, Waiting } from "./card";

const TENANTS_COLOR = featureColors.asset;

export default function TenantsCard({
  tenants,
  className,
}: {
  tenants: Loaded<TenantSize[]>;
  className?: string;
}) {
  if (!tenants.ok) {
    return (
      <OverviewCard title="Largest tenants" accent={TENANTS_COLOR} className={className}>
        <NotAvailable reason={tenants.reason} />
      </OverviewCard>
    );
  }

  const rows = tenants.data;
  const largest = Math.max(...rows.map((row) => row.bytes), 1);

  return (
    <OverviewCard
      title="Largest tenants"
      accent={TENANTS_COLOR}
      className={className}
      badge="by attachment bytes"
      footnote="Live file_blobs bytes per tenant, from the app database. No AWS call and no estimate."
    >
      {rows.length === 0 ? (
        <Waiting>No tenant has uploaded an attachment yet.</Waiting>
      ) : (
        rows.map((row) => (
          <BarRow
            key={row.tenantId}
            label={row.name ?? `${row.tenantId.slice(0, 8)}…`}
            sublabel={pluralise(row.transactions, "transaction")}
            value={formatBytes(row.bytes)}
            share={row.bytes / largest}
            color={TENANTS_COLOR}
            help={`Tenant ${row.tenantId}`}
          />
        ))
      )}
    </OverviewCard>
  );
}
