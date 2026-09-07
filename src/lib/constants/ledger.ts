import "server-only";
/**
 * The Constants **sync ledger** (`admin_constant_sync` in the admin database):
 * one row per `(kind, row_id)` recording how that catalog row related to the
 * main app database the last time anything looked — `new`, `changed` or
 * `synced` — plus `main_only` rows for ids the main database holds and the
 * admin catalog does not.
 *
 * Why a ledger at all: the market-data catalogs run to hundreds of thousands
 * of rows, so a list request cannot compare the two databases on the fly. A
 * **compare job** (`./compare.ts`) rebuilds a whole kind; after that, every
 * create, edit, delete and push keeps its own rows current, and a read is a
 * cheap lookup. A row with no ledger entry is reported as `unknown`.
 *
 * Everything here is the admin database only (`prismaAdmin`); nothing in this
 * module touches `DATABASE_URL`.
 *
 * The table may not exist yet (`docs/sql/007_constants_sync_and_jobs.sql` is
 * run by hand): Prisma's P2021 is deliberately **not** caught anywhere in this
 * module, so `adminHandler` renders it as 503 `admin_schema_missing`.
 */
import { prismaAdmin } from "@/lib/prisma-admin";
import type { ConstantKind, PushState } from "./types";

/**
 * What the `state` column may hold. `main_only` is the one value that is not
 * a `PushState`: it describes an id the admin catalog does not have, so it
 * never labels a row in a list response.
 */
export type LedgerState = "new" | "changed" | "synced" | "main_only";

/** The states a comparison assigns to an admin catalog row. */
export type ComparedState = Exclude<LedgerState, "main_only">;

export interface LedgerEntry {
  /** Catalog row id in its wire (string) form, for every kind. */
  id: string;
  state: ComparedState;
}

/** Rows per `INSERT … ON CONFLICT`. One statement, two array parameters. */
const UPSERT_CHUNK = 5_000;

/** Ids per `WHERE row_id IN (…)` read. */
const READ_CHUNK = 1_000;

/**
 * Interactive-transaction budget for the one multi-statement write in this
 * module (`replaceMainOnly`).
 *
 * Prisma's default is 5 s, which a 300 000-row catalog blows through: the
 * delete plus up to 60 chunked inserts is a minute of work on the first
 * compare, and the transaction is aborted with P2028 half way. Sized like the
 * push transaction in `./push.ts` (`PUSH_TIMEOUT_MS`): generous enough for the
 * biggest catalog, still bounded so a wedged statement cannot hold the row
 * locks forever. `maxWait` is only the time spent waiting for a connection
 * from the pool before the transaction starts.
 */
const LEDGER_TX_TIMEOUT_MS = 120_000;
const LEDGER_TX_MAX_WAIT_MS = 10_000;

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/* -------------------------------------------------------------------------- */
/*                                   Writes                                   */
/* -------------------------------------------------------------------------- */

/**
 * Records the state of many rows of one kind.
 *
 * One statement per chunk of 5000: the ids and the states travel as two
 * `text[]` parameters and are zipped by `unnest`, so a whole compare page is a
 * single round trip instead of 5000 upserts.
 *
 * Duplicate ids are collapsed first (last one wins). Postgres refuses an
 * `ON CONFLICT DO UPDATE` whose source affects the same row twice, and a
 * caller that assembled its batch from two overlapping sets would otherwise
 * fail the whole statement.
 */
export async function upsertStates(
  kind: ConstantKind,
  entries: readonly LedgerEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const deduped = new Map<string, LedgerState>();
  for (const entry of entries) deduped.set(entry.id, entry.state);
  await writeStates(kind, [...deduped.entries()]);
}

/** The raw upsert, over already-deduplicated `[id, state]` pairs. */
async function writeStates(
  kind: ConstantKind,
  pairs: readonly (readonly [string, LedgerState])[],
): Promise<void> {
  for (const batch of chunk(pairs, UPSERT_CHUNK)) {
    const ids = batch.map(([id]) => id);
    const states = batch.map(([, state]) => state);
    // Tagged template: `kind`, `ids` and `states` are bound parameters, never
    // interpolated. The casts give Postgres the types it cannot infer for a
    // parameter used inside `unnest`.
    await prismaAdmin.$executeRaw`
      INSERT INTO admin_constant_sync (kind, row_id, state, compared_at)
      SELECT ${kind}::text, entry.row_id, entry.state, now()
        FROM unnest(${ids}::text[], ${states}::text[]) AS entry(row_id, state)
      ON CONFLICT (kind, row_id)
      DO UPDATE SET state = EXCLUDED.state, compared_at = now()`;
  }
}

/** Records one row's state (a create, an edit, a single-row push). */
export async function setState(
  kind: ConstantKind,
  id: string,
  state: ComparedState,
): Promise<void> {
  await prismaAdmin.admin_constant_sync.upsert({
    where: { kind_row_id: { kind, row_id: id } },
    create: { kind, row_id: id, state },
    update: { state, compared_at: new Date() },
  });
}

/**
 * Forgets one row, after a hard delete from the admin catalog. The main
 * database keeps its copy, which the next compare will report as `main_only`.
 */
export async function removeState(kind: ConstantKind, id: string): Promise<void> {
  await prismaAdmin.admin_constant_sync.deleteMany({ where: { kind, row_id: id } });
}

/**
 * Replaces the kind's `main_only` set with `ids` — the ids a compare found in
 * the main database and not in the admin catalog.
 *
 * The delete and the insert run in one transaction so a reader never sees the
 * old set half gone. An id that also carries a stale `new`/`changed`/`synced`
 * entry (the admin row was deleted without going through `removeState`) is
 * flipped to `main_only` by the upsert rather than duplicated.
 *
 * The transaction is given `LEDGER_TX_TIMEOUT_MS` rather than Prisma's default
 * five seconds: a market-data catalog puts up to 60 chunked inserts inside it.
 */
export async function replaceMainOnly(kind: ConstantKind, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)];
  await prismaAdmin.$transaction(
    async (tx) => {
      await tx.admin_constant_sync.deleteMany({ where: { kind, state: "main_only" } });
      for (const batch of chunk(unique, UPSERT_CHUNK)) {
        const values = batch.map((id) => id);
        await tx.$executeRaw`
          INSERT INTO admin_constant_sync (kind, row_id, state, compared_at)
          SELECT ${kind}::text, entry.row_id, 'main_only', now()
            FROM unnest(${values}::text[]) AS entry(row_id)
          ON CONFLICT (kind, row_id)
          DO UPDATE SET state = EXCLUDED.state, compared_at = now()`;
      }
    },
    { timeout: LEDGER_TX_TIMEOUT_MS, maxWait: LEDGER_TX_MAX_WAIT_MS },
  );
}

/* -------------------------------------------------------------------------- */
/*                                    Reads                                   */
/* -------------------------------------------------------------------------- */

export interface LedgerCounts {
  new: number;
  changed: number;
  synced: number;
  mainOnly: number;
}

/** The kind's whole ledger, counted per state in one grouped query. */
export async function countStates(kind: ConstantKind): Promise<LedgerCounts> {
  const groups = await prismaAdmin.admin_constant_sync.groupBy({
    by: ["state"],
    where: { kind },
    _count: { _all: true },
  });
  const counts: LedgerCounts = { new: 0, changed: 0, synced: 0, mainOnly: 0 };
  for (const group of groups) {
    const total = group._count._all;
    switch (group.state) {
      case "new":
        counts.new = total;
        break;
      case "changed":
        counts.changed = total;
        break;
      case "synced":
        counts.synced = total;
        break;
      case "main_only":
        counts.mainOnly = total;
        break;
      default:
        // A state the app does not know (the CHECK constraint forbids it):
        // ignore rather than mis-report it as one of the four.
        break;
    }
  }
  return counts;
}

/**
 * The state of each of `ids`, for one page of a list response. An id with no
 * ledger entry — or one carrying `main_only`, which contradicts a row that is
 * plainly there — comes back as `unknown`: never compared, so nothing is
 * claimed about it.
 */
export async function stateOfRows(
  kind: ConstantKind,
  ids: readonly string[],
): Promise<Map<string, PushState>> {
  const states = new Map<string, PushState>();
  for (const id of ids) states.set(id, "unknown");
  if (ids.length === 0) return states;
  for (const batch of chunk([...new Set(ids)], READ_CHUNK)) {
    const rows = await prismaAdmin.admin_constant_sync.findMany({
      where: { kind, row_id: { in: batch } },
      select: { row_id: true, state: true },
    });
    for (const row of rows) {
      if (row.state === "new" || row.state === "changed" || row.state === "synced") {
        states.set(row.row_id, row.state);
      }
    }
  }
  return states;
}

/** Ids of the kind carrying one of `states`, ordered by id, one page. */
export async function listIdsInStates(
  kind: ConstantKind,
  states: readonly LedgerState[],
  page: { skip: number; take: number },
): Promise<string[]> {
  const rows = await prismaAdmin.admin_constant_sync.findMany({
    where: { kind, state: { in: [...states] } },
    select: { row_id: true },
    orderBy: { row_id: "asc" },
    skip: page.skip,
    take: page.take,
  });
  return rows.map((row) => row.row_id);
}

/** How many ids of the kind carry one of `states`. */
export function countIdsInStates(
  kind: ConstantKind,
  states: readonly LedgerState[],
): Promise<number> {
  return prismaAdmin.admin_constant_sync.count({
    where: { kind, state: { in: [...states] } },
  });
}

/**
 * Every id of the kind in one of `states`, in batches, cursored by `row_id`
 * so a push over a 300 000-row catalog never holds more than one batch and
 * never pays for a deep `OFFSET`.
 */
export async function* iterateIdsInStates(
  kind: ConstantKind,
  states: readonly LedgerState[],
  batchSize: number,
): AsyncGenerator<string[]> {
  let after: string | null = null;
  for (;;) {
    const rows: { row_id: string }[] = await prismaAdmin.admin_constant_sync.findMany({
      where: {
        kind,
        state: { in: [...states] },
        ...(after === null ? {} : { row_id: { gt: after } }),
      },
      select: { row_id: true },
      orderBy: { row_id: "asc" },
      take: batchSize,
    });
    if (rows.length === 0) return;
    after = rows[rows.length - 1].row_id;
    yield rows.map((row) => row.row_id);
    if (rows.length < batchSize) return;
  }
}
