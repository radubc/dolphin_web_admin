import "server-only";
/**
 * Carrying the admin catalogs across to the **main** app database.
 *
 * The admin database masters the four reference catalogs; the consumer app
 * reads its own copy. This module is the one deliberate write path from the
 * console into `DATABASE_URL`:
 *
 * - `compareWithMain` reads the main copy and labels each admin row `new`,
 *   `changed` or `synced`, and reports ids the main database still has that
 *   the admin catalog no longer does (`mainOnlyIds`).
 * - `pushConstants` upserts rows **by id** inside one transaction. It never
 *   deletes: a row over there may be referenced by tenant data (accounts,
 *   transactions, budgets), so removal stays a deliberate act on the consumer
 *   side.
 *
 * Only the pushed fields are compared, and only the fields the per-kind
 * builders below list are written, so columns the consumer app owns (`created_at` on an
 * existing row, and anything added there later) keep their values. The one
 * exception is `categories.updated_at`, which every write of a category stamps
 * with `now()` so the consumer app sees the row as freshly changed.
 *
 * Foreign keys are respected by pushing dependencies first: a country's
 * currency, and a category's ancestors (parents before children). Those extra
 * writes are reported separately in `PushResponse.dependencies`.
 *
 * Two clients are used, never in the same transaction: `prismaAdmin` reads the
 * catalog and writes the audit row, `prisma` does the transactional upsert.
 */
import type { Prisma as AdminPrisma } from "@/generated/prisma-admin/client";
import { Prisma as MainPrisma } from "@/generated/prisma/client";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/api/errors";
import { prisma } from "@/lib/prisma";
import { prismaAdmin } from "@/lib/prisma-admin";
import { MAX_PUSH_ROWS } from "./schemas";
import {
  listConstants,
  type CatalogCategory,
  type CatalogCountry,
  type CatalogCurrency,
  type CatalogFinancialInstitution,
  type CatalogRow,
  type CatalogRowOf,
} from "./repository";
import {
  CONSTANT_KIND_LABELS,
  type ConstantKind,
  type PushOutcome,
  type PushResponse,
  type PushResultRow,
  type PushState,
} from "./types";

/** Main-database client or transaction client; the queries here work on both. */
type MainClient = MainPrisma.TransactionClient;

/** How many ids one `WHERE id IN (…)` carries. */
const ID_CHUNK = 500;

/** Interactive transaction budget for a full push (207 rows today). */
const PUSH_TIMEOUT_MS = 60_000;
const PUSH_MAX_WAIT_MS = 10_000;

/* -------------------------------------------------------------------------- */
/*                            Main-database shapes                            */
/* -------------------------------------------------------------------------- */

/** Exactly the columns a push writes, per kind. Nothing else is read or compared. */
type MainCountry = {
  id: string;
  name: string;
  alpha2_code: string;
  alpha3_code: string;
  currency_id: string | null;
};
type MainCurrency = { id: string; code: string; name: string; symbol: string | null };
type MainInstitution = { id: string; name: string; institution_number: string; type: string };
type MainCategory = {
  id: string;
  name: string;
  type: string | null;
  parent_id: string | null;
  is_discretionary: boolean | null;
  deleted_at: Date | null;
};
type MainRow = MainCountry | MainCurrency | MainInstitution | MainCategory;

const COUNTRY_SELECT = {
  id: true,
  name: true,
  alpha2_code: true,
  alpha3_code: true,
  currency_id: true,
} as const;
const CURRENCY_SELECT = { id: true, code: true, name: true, symbol: true } as const;
const INSTITUTION_SELECT = { id: true, name: true, institution_number: true, type: true } as const;
const CATEGORY_SELECT = {
  id: true,
  name: true,
  type: true,
  parent_id: true,
  is_discretionary: true,
  deleted_at: true,
} as const;

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/** The main rows for these ids, keyed by id. Ids are read in chunks of 500. */
async function fetchMainRows(
  client: MainClient,
  kind: ConstantKind,
  ids: readonly string[],
): Promise<Map<string, MainRow>> {
  const found = new Map<string, MainRow>();
  for (const batch of chunk(ids, ID_CHUNK)) {
    const where = { id: { in: batch } };
    const rows: MainRow[] =
      kind === "countries"
        ? await client.countries.findMany({ where, select: COUNTRY_SELECT })
        : kind === "currencies"
          ? await client.currencies.findMany({ where, select: CURRENCY_SELECT })
          : kind === "financial_institutions"
            ? await client.financial_institutions.findMany({ where, select: INSTITUTION_SELECT })
            : await client.categories.findMany({ where, select: CATEGORY_SELECT });
    for (const row of rows) found.set(row.id, row);
  }
  return found;
}

/** Every id the main table holds. These four tables are small (hundreds of rows). */
async function fetchAllMainIds(kind: ConstantKind): Promise<string[]> {
  const select = { id: true } as const;
  const rows =
    kind === "countries"
      ? await prisma.countries.findMany({ select })
      : kind === "currencies"
        ? await prisma.currencies.findMany({ select })
        : kind === "financial_institutions"
          ? await prisma.financial_institutions.findMany({ select })
          : await prisma.categories.findMany({ select });
  return rows.map((row) => row.id);
}

/* -------------------------------------------------------------------------- */
/*                                 Comparison                                 */
/* -------------------------------------------------------------------------- */

/** Timestamps are compared as epoch milliseconds, never as formatted strings. */
const msOf = (value: string | null): number | null => (value ? new Date(value).getTime() : null);

/** True when at least one pushed field differs between the two copies. */
function differs(kind: ConstantKind, admin: CatalogRow, main: MainRow): boolean {
  switch (kind) {
    case "countries": {
      const a = admin as CatalogCountry;
      const m = main as MainCountry;
      return (
        a.name !== m.name ||
        a.alpha2Code !== m.alpha2_code ||
        a.alpha3Code !== m.alpha3_code ||
        a.currencyId !== m.currency_id
      );
    }
    case "currencies": {
      const a = admin as CatalogCurrency;
      const m = main as MainCurrency;
      return a.code !== m.code || a.name !== m.name || a.symbol !== m.symbol;
    }
    case "financial_institutions": {
      const a = admin as CatalogFinancialInstitution;
      const m = main as MainInstitution;
      return a.name !== m.name || a.institutionNumber !== m.institution_number || a.type !== m.type;
    }
    case "categories": {
      const a = admin as CatalogCategory;
      const m = main as MainCategory;
      return (
        a.name !== m.name ||
        a.type !== m.type ||
        a.parentId !== m.parent_id ||
        a.isDiscretionary !== m.is_discretionary ||
        msOf(a.deletedAt) !== (m.deleted_at ? m.deleted_at.getTime() : null)
      );
    }
  }
}

export interface ComparisonResult {
  /** `pushState` per admin row id. */
  states: Map<string, PushState>;
  /** Ids the main table holds that the admin catalog no longer does. */
  mainOnlyIds: string[];
  /** When the main database was read; ISO string. */
  comparedAt: string;
}

/**
 * Labels each admin row against the main database.
 *
 * @param includeMainOnly pass `false` when comparing a single row (a create or
 * an update), where scanning the whole main table for orphans is wasted work.
 */
export async function compareWithMain<K extends ConstantKind>(
  kind: K,
  adminRows: readonly CatalogRowOf<K>[],
  options: { includeMainOnly?: boolean } = {},
): Promise<ComparisonResult> {
  const rows = adminRows as readonly CatalogRow[];
  const ids = rows.map((row) => row.id);
  const mainRows = await fetchMainRows(prisma, kind, ids);

  const states = new Map<string, PushState>();
  for (const row of rows) {
    const main = mainRows.get(row.id);
    states.set(row.id, !main ? "new" : differs(kind, row, main) ? "changed" : "synced");
  }

  let mainOnlyIds: string[] = [];
  if (options.includeMainOnly !== false) {
    const adminIds = new Set(ids);
    mainOnlyIds = (await fetchAllMainIds(kind)).filter((id) => !adminIds.has(id)).sort();
  }

  return { states, mainOnlyIds, comparedAt: new Date().toISOString() };
}

/* -------------------------------------------------------------------------- */
/*                                   Writing                                  */
/* -------------------------------------------------------------------------- */

/**
 * Where the transaction is at, so a Prisma error can name the row it failed
 * on. `id` is null while a batch insert is in flight: one statement carries
 * many rows and the driver does not say which one it choked on.
 */
interface WriteCursor {
  kind: ConstantKind;
  id: string | null;
}

/** The columns a push writes, per kind. Nothing else is touched over there. */
const countryFields = (a: CatalogCountry) => ({
  name: a.name,
  alpha2_code: a.alpha2Code,
  alpha3_code: a.alpha3Code,
  currency_id: a.currencyId,
});

const currencyFields = (a: CatalogCurrency) => ({ code: a.code, name: a.name, symbol: a.symbol });

const institutionFields = (a: CatalogFinancialInstitution) => ({
  name: a.name,
  institution_number: a.institutionNumber,
  type: a.type,
});

const categoryFields = (a: CatalogCategory) => ({
  name: a.name,
  // The stored spelling, verbatim: the column is free text on both databases,
  // so an unexpected value is carried across rather than written as null.
  type: a.type,
  parent_id: a.parentId,
  is_discretionary: a.isDiscretionary,
  // The retirement travels with the row; the main database keeps the
  // soft-deleted copy so tenant references stay valid.
  deleted_at: a.deletedAt ? new Date(a.deletedAt) : null,
  // The one consumer-owned column a push does move: a written category is a
  // changed category over there.
  updated_at: new Date(),
});

const countryCreateData = (a: CatalogCountry) => ({
  id: a.id,
  ...countryFields(a),
  created_at: a.createdAt ? new Date(a.createdAt) : undefined,
});

const currencyCreateData = (a: CatalogCurrency) => ({
  id: a.id,
  ...currencyFields(a),
  created_at: a.createdAt ? new Date(a.createdAt) : undefined,
});

const institutionCreateData = (a: CatalogFinancialInstitution) => ({ id: a.id, ...institutionFields(a) });

const categoryCreateData = (a: CatalogCategory) => {
  const fields = categoryFields(a);
  return { id: a.id, ...fields, created_at: a.createdAt ? new Date(a.createdAt) : fields.updated_at };
};

/** Rewrites an existing main row from the admin copy. */
async function updateMainRow(tx: MainClient, kind: ConstantKind, admin: CatalogRow): Promise<void> {
  switch (kind) {
    case "countries": {
      const a = admin as CatalogCountry;
      await tx.countries.update({ where: { id: a.id }, data: countryFields(a) });
      return;
    }
    case "currencies": {
      const a = admin as CatalogCurrency;
      await tx.currencies.update({ where: { id: a.id }, data: currencyFields(a) });
      return;
    }
    case "financial_institutions": {
      const a = admin as CatalogFinancialInstitution;
      await tx.financial_institutions.update({ where: { id: a.id }, data: institutionFields(a) });
      return;
    }
    case "categories": {
      const a = admin as CatalogCategory;
      await tx.categories.update({ where: { id: a.id }, data: categoryFields(a) });
      return;
    }
  }
}

/** Inserts one main row, keeping the admin id. Used for categories only. */
async function createMainRow(tx: MainClient, admin: CatalogCategory): Promise<void> {
  await tx.categories.create({ data: categoryCreateData(admin) });
}

/** The three kinds whose creates may go out as one statement (no self-reference). */
type BatchKind = Exclude<ConstantKind, "categories">;

/**
 * Inserts a whole group in one `INSERT`. Categories are excluded by the type:
 * a child may sit in the same batch as its parent, and a single statement
 * would have Postgres check that foreign key against a row it has not
 * inserted yet, so they stay one create per row in depth order.
 */
async function createMainRows(
  tx: MainClient,
  kind: BatchKind,
  rows: readonly CatalogRow[],
): Promise<void> {
  switch (kind) {
    case "countries":
      await tx.countries.createMany({ data: (rows as CatalogCountry[]).map(countryCreateData) });
      return;
    case "currencies":
      await tx.currencies.createMany({ data: (rows as CatalogCurrency[]).map(currencyCreateData) });
      return;
    case "financial_institutions":
      await tx.financial_institutions.createMany({
        data: (rows as CatalogFinancialInstitution[]).map(institutionCreateData),
      });
      return;
  }
}

/**
 * Pushes one ordered group of same-kind rows; unchanged rows are not written.
 *
 * Updates are one round trip each. Creates of countries, currencies and
 * institutions are collected and inserted with a single `createMany` at the
 * end of the group, which is what keeps a large push inside the transaction
 * budget; categories are created in place, in the order they arrive (parents
 * first), because a create or an update in this group may point at another
 * row of it.
 */
async function writeGroup(
  tx: MainClient,
  kind: ConstantKind,
  rows: readonly CatalogRow[],
  cursor: WriteCursor,
): Promise<PushResultRow[]> {
  if (rows.length === 0) return [];
  const existing = await fetchMainRows(
    tx,
    kind,
    rows.map((row) => row.id),
  );
  const results: PushResultRow[] = [];
  const pendingCreates: CatalogRow[] = [];
  for (const row of rows) {
    const main = existing.get(row.id);
    const outcome: PushOutcome = !main ? "created" : differs(kind, row, main) ? "updated" : "unchanged";
    results.push({ id: row.id, outcome });
    if (outcome === "unchanged") continue;
    cursor.kind = kind;
    cursor.id = row.id;
    if (outcome === "updated") {
      await updateMainRow(tx, kind, row);
    } else if (kind === "categories") {
      await createMainRow(tx, row as CatalogCategory);
    } else {
      pendingCreates.push(row);
    }
  }
  if (pendingCreates.length > 0 && kind !== "categories") {
    cursor.kind = kind;
    cursor.id = null;
    await createMainRows(tx, kind, pendingCreates);
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/*                          Main-database write errors                        */
/* -------------------------------------------------------------------------- */

/** `meta.target` / `meta.field_name` are a string or a list of them. */
function metaText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === "string");
    return parts.length > 0 ? parts.join(", ") : null;
  }
  return null;
}

/** "category 9f2…" while a row is being written, "the categories batch" during an insert. */
function whereItFailed(cursor: WriteCursor): string {
  const label = CONSTANT_KIND_LABELS[cursor.kind];
  return cursor.id ? `${label.singular} ${cursor.id}` : `the ${label.plural} batch`;
}

/**
 * Turns a rejected write on the main database into an `ApiError` the operator
 * can act on. Anything that is not a known Prisma error is returned unchanged
 * and becomes a generic 500.
 */
function mainWriteError(error: unknown, cursor: WriteCursor): unknown {
  if (!(error instanceof MainPrisma.PrismaClientKnownRequestError)) return error;
  const at = whereItFailed(cursor);
  const meta = (error.meta ?? {}) as Record<string, unknown>;
  switch (error.code) {
    case "P2002": {
      const target = metaText(meta.target);
      return new ConflictError(
        `The main app database already has a row with the same ${target ?? "unique value"} (${at}). Reconcile it there before pushing.`,
      );
    }
    case "P2003": {
      const field = metaText(meta.field_name) ?? metaText(meta.constraint);
      return new ValidationError(
        `The main app database rejected ${at}: ${field ?? "a reference on it"} points at a row it does not have. Push that row first.`,
      );
    }
    default:
      return new ConflictError(
        `The main app database refused the push at ${at} (Prisma ${error.code}). Nothing was written.`,
      );
  }
}

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

/** Depth of a category in the admin tree; used to order parents before children. */
function depthOf(id: string, parentOf: Map<string, string | null>): number {
  let depth = 0;
  const seen = new Set<string>([id]);
  let cursor = parentOf.get(id) ?? null;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    depth += 1;
    cursor = parentOf.get(cursor) ?? null;
  }
  return depth;
}

const byDepth = (parentOf: Map<string, string | null>) => (a: CatalogCategory, b: CatalogCategory) =>
  depthOf(a.id, parentOf) - depthOf(b.id, parentOf) || a.name.localeCompare(b.name);

/**
 * The ancestors of the selected categories that were not selected themselves,
 * ordered parents first. Without them a `parent_id` could point at a row the
 * main database does not have yet.
 */
function ancestorsOf(
  selected: readonly CatalogCategory[],
  byId: Map<string, CatalogCategory>,
): CatalogCategory[] {
  const parentOf = new Map([...byId.values()].map((row) => [row.id, row.parentId] as const));
  const selectedIds = new Set(selected.map((row) => row.id));
  const extra = new Map<string, CatalogCategory>();
  for (const row of selected) {
    const walked = new Set<string>([row.id]);
    let cursor = row.parentId;
    while (cursor && !walked.has(cursor)) {
      walked.add(cursor);
      const parent = byId.get(cursor);
      // A dangling parent_id cannot be pushed; the main insert would fail its
      // foreign key, so stop here and let that row's write report the problem.
      if (!parent) break;
      if (!selectedIds.has(parent.id)) extra.set(parent.id, parent);
      cursor = parent.parentId;
    }
  }
  return [...extra.values()].sort(byDepth(parentOf));
}

/* -------------------------------------------------------------------------- */
/*                                    Push                                    */
/* -------------------------------------------------------------------------- */

export interface PushOptions {
  /**
   * Ids to push; omit (`undefined`) for every row of the kind. An empty array
   * is refused with a 422: "nothing selected" must never become "everything".
   */
  ids?: string[];
  /** `admin_users.id` of the operator, recorded on the audit row. */
  actorUserId: string | null;
}

/**
 * Upserts admin rows into the main database by id, dependencies first, in one
 * transaction. Nothing is ever deleted there.
 *
 * `results` covers the requested kind, in the order the rows were processed;
 * `dependencies` covers the extra rows written to keep foreign keys valid
 * (a country's currencies, a category's ancestors that were not selected), and
 * lists only the ones that were actually missing or stale over there. The
 * `created` / `updated` / `unchanged` counts span both lists.
 *
 * @throws {NotFoundError} an id that the admin catalog does not have.
 * @throws {ValidationError} an empty selection, or more rows than one
 * transaction may carry.
 * @throws {ConflictError} the main database rejected a write (see
 * `mainWriteError`); the transaction rolled back and nothing was written.
 */
export async function pushConstants(kind: ConstantKind, options: PushOptions): Promise<PushResponse> {
  const catalog = await listConstants(kind);
  const byId = new Map(catalog.map((row) => [row.id, row] as const));

  // Only an absent `ids` means "everything". An empty array is a selection of
  // nothing, which the schema already refuses at the route boundary; this is
  // the same rule for any other caller.
  if (options.ids !== undefined && options.ids.length === 0) {
    throw new ValidationError("Select at least one row to push.");
  }
  const requestedIds = options.ids === undefined ? null : [...new Set(options.ids)];
  let selected: CatalogRow[];
  if (requestedIds === null) {
    selected = [...catalog];
  } else {
    selected = requestedIds.map((id) => {
      const row = byId.get(id);
      if (!row) {
        throw new NotFoundError(
          `No ${CONSTANT_KIND_LABELS[kind].singular} with id ${id} in the admin catalog.`,
        );
      }
      return row;
    });
  }

  // Dependencies of other kinds (or earlier rows of this one) that must land first.
  const dependencyGroups: { kind: ConstantKind; rows: CatalogRow[] }[] = [];

  if (kind === "countries") {
    const needed = new Set(
      (selected as CatalogCountry[]).map((row) => row.currencyId).filter((id): id is string => id !== null),
    );
    if (needed.size > 0) {
      const currencies = (await listConstants("currencies")).filter((row) => needed.has(row.id));
      if (currencies.length > 0) dependencyGroups.push({ kind: "currencies", rows: currencies });
    }
  }

  if (kind === "categories") {
    const categoriesById = byId as Map<string, CatalogCategory>;
    const chosen = selected as CatalogCategory[];
    const ancestors = ancestorsOf(chosen, categoriesById);
    if (ancestors.length > 0) dependencyGroups.push({ kind: "categories", rows: ancestors });
    const parentOf = new Map([...categoriesById.values()].map((row) => [row.id, row.parentId] as const));
    selected = [...chosen].sort(byDepth(parentOf));
  }

  // A dependency that is already synced is present in the main database, so the
  // foreign key holds without touching it. Only the missing and the changed
  // ones are carried, which keeps `dependencies` a list of real extra writes.
  const pendingGroups: { kind: ConstantKind; rows: CatalogRow[] }[] = [];
  for (const group of dependencyGroups) {
    const { states } = await compareWithMain(group.kind, group.rows, { includeMainOnly: false });
    const rows = group.rows.filter((row) => states.get(row.id) !== "synced");
    if (rows.length > 0) pendingGroups.push({ kind: group.kind, rows });
  }

  const total = selected.length + pendingGroups.reduce((sum, group) => sum + group.rows.length, 0);
  if (total > MAX_PUSH_ROWS) {
    throw new ValidationError(
      `A push carries at most ${MAX_PUSH_ROWS} rows at a time; this one would carry ${total}. Push in batches.`,
    );
  }

  // Follows the transaction so a rejected write can name the row it failed on.
  const cursor: WriteCursor = { kind, id: null };
  let written: { results: PushResultRow[]; dependencies: { kind: ConstantKind; results: PushResultRow[] }[] };
  try {
    written = await prisma.$transaction(
      async (tx) => {
        const dependencyResults: { kind: ConstantKind; results: PushResultRow[] }[] = [];
        for (const group of pendingGroups) {
          dependencyResults.push({
            kind: group.kind,
            results: await writeGroup(tx, group.kind, group.rows, cursor),
          });
        }
        return {
          results: await writeGroup(tx, kind, selected, cursor),
          dependencies: dependencyResults,
        };
      },
      { timeout: PUSH_TIMEOUT_MS, maxWait: PUSH_MAX_WAIT_MS },
    );
  } catch (error) {
    throw mainWriteError(error, cursor);
  }
  const { results, dependencies } = written;

  const every = [...dependencies.flatMap((group) => group.results), ...results];
  const count = (outcome: PushOutcome) => every.filter((row) => row.outcome === outcome).length;
  const response: PushResponse = {
    kind,
    results,
    dependencies,
    created: count("created"),
    updated: count("updated"),
    unchanged: count("unchanged"),
    pushedAt: new Date().toISOString(),
  };

  await recordPushAudit(options.actorUserId, response, selected.length);
  return response;
}

/**
 * One audit row per successful push.
 *
 * Best effort on purpose: `target_type = 'catalog'` is only allowed once
 * `docs/sql/004_constants.sql` has run, and a database that has not been
 * updated yet must not turn a completed push into a 500.
 */
async function recordPushAudit(
  actorUserId: string | null,
  response: PushResponse,
  requested: number,
): Promise<void> {
  try {
    await prismaAdmin.admin_permission_audit_events.create({
      data: {
        actor_user_id: actorUserId,
        action: "constants_push",
        target_type: "catalog",
        target_id: null,
        metadata: {
          // `target_label` is lifted out of the metadata into `AuditEvent.targetLabel`
          // by the admin-access repository; the rest is rendered as chips, so
          // every value is a scalar or an array of short strings.
          target_label: CONSTANT_KIND_LABELS[response.kind].plural,
          kind: response.kind,
          requested,
          created: response.created,
          updated: response.updated,
          unchanged: response.unchanged,
          ...(response.dependencies.length > 0
            ? {
                dependencies: response.dependencies.map(
                  (group) => `${CONSTANT_KIND_LABELS[group.kind].plural}: ${group.results.length}`,
                ),
              }
            : {}),
        } as AdminPrisma.InputJsonObject,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n").filter(Boolean).at(-1) : String(error);
    console.warn(`[constants] audit skipped: ${reason}`);
  }
}
