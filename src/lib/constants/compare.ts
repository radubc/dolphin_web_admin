import "server-only";
/**
 * The **compare** job: rebuilding one catalog's sync ledger.
 *
 * A compare walks the admin catalog in primary-key order, reads the matching
 * rows out of the main app database, and records `new` / `changed` / `synced`
 * per row in `admin_constant_sync`. It then walks the main table's ids and
 * records the ones the admin catalog does not have as `main_only`.
 *
 * This is the only thing that reads both databases in bulk, and it is the
 * reason a list request does not have to: after a compare, every state the
 * page shows is one indexed lookup in the ledger. Run it after a bulk load
 * from the market-data feed, or whenever the ledger is stale enough to be
 * misleading; ordinary edits and pushes keep their own rows current on their
 * own.
 *
 * Memory is one page of rows (5000) plus the set of admin ids — 300 000
 * strings, a few tens of megabytes at worst, which is what buys a single pass
 * over each side instead of a join across two databases.
 */
import type { JobWork } from "./jobs";
import { replaceMainOnly, upsertStates } from "./ledger";
import { compareStates, mainIdsAfter } from "./push";
import { scanRows } from "./repository";
import type { CatalogRow } from "./repository";
import type { ConstantKind } from "./types";

/** Rows per pass, on both sides. */
export const COMPARE_PAGE_SIZE = 5_000;

/**
 * Catalogs at most this big are compared inside the request, so the operator
 * gets the answer instead of a job to poll. Everything larger runs in the
 * background. Nine of the ten kinds are far below this; the market-data ones
 * are far above.
 */
export const COMPARE_INLINE_MAX = 5_000;

/** The work a compare job performs. */
export function compareWork(kind: ConstantKind, total: number): JobWork {
  return async (progress) => {
    await progress({ total, processed: 0, mainOnly: 0 });

    // Pass one: every admin row against its main-database twin.
    const adminIds = new Set<string>();
    let processed = 0;
    let after: string | null = null;
    for (;;) {
      const rows: CatalogRow[] = await scanRows(kind, { after, take: COMPARE_PAGE_SIZE });
      if (rows.length === 0) break;
      const states = await compareStates(kind, rows);
      await upsertStates(
        kind,
        rows.map((row) => ({ id: row.id, state: states.get(row.id) ?? "new" })),
      );
      for (const row of rows) adminIds.add(row.id);
      processed += rows.length;
      after = rows[rows.length - 1].id;
      await progress({ processed });
      if (rows.length < COMPARE_PAGE_SIZE) break;
    }

    // Pass two: ids the main database has and the admin catalog does not.
    // Ids only, one indexed column, cursored the same way.
    const mainOnly: string[] = [];
    let mainAfter: string | null = null;
    for (;;) {
      const ids = await mainIdsAfter(kind, mainAfter, COMPARE_PAGE_SIZE);
      if (ids.length === 0) break;
      for (const id of ids) if (!adminIds.has(id)) mainOnly.push(id);
      mainAfter = ids[ids.length - 1];
      if (ids.length < COMPARE_PAGE_SIZE) break;
    }
    await replaceMainOnly(kind, mainOnly);

    // The catalog may have grown or shrunk while the job ran; `total` ends as
    // what was actually walked rather than what was predicted.
    await progress({ total: processed, processed, mainOnly: mainOnly.length });
  };
}
