import "server-only";
/**
 * The glue the Constants routes call: the admin catalog (`./repository.ts`),
 * the sync ledger (`./ledger.ts`) and the compare / push jobs
 * (`./jobs.ts`, `./compare.ts`, `./push.ts`), shaped into the responses
 * declared in `./types.ts`.
 *
 * Routes stay thin — they validate `[kind]`, the query string and the body,
 * and call one of these.
 *
 * The rule that shapes everything here: **a read never compares the two
 * databases**. States come from the ledger, which a compare job fills and
 * which every create, edit, delete and push keeps current for its own rows.
 * A row nobody has compared reads as `unknown`, which is honest and cheap;
 * comparing 300 000 rows to render a page of 50 is neither.
 */
import { NotFoundError } from "@/lib/api/errors";
import { COMPARE_INLINE_MAX, compareWork } from "./compare";
import { beginJob, getJob, lastComparedAt, latestJob, listJobs } from "./jobs";
import { countStates, removeState, setState, stateOfRows } from "./ledger";
import { compareState, preparePush, pushWork } from "./push";
import {
  countRows,
  createConstant,
  deleteConstant,
  findPage,
  getConstant,
  isRetirable,
  updateConstant,
  type CatalogRowOf,
} from "./repository";
import {
  CONSTANT_KIND_LABELS,
  LIST_PAGE_SIZE_DEFAULT,
  LIST_PAGE_SIZE_MAX,
  PUSH_INLINE_MAX,
  hasIntegerId,
  isConstantKind,
  type ConstantInputOf,
  type ConstantJob,
  type ConstantKind,
  type ConstantListResponse,
  type ConstantPatchOf,
  type ConstantRowOf,
  type ListQuery,
  type PushInput,
  type PushState,
  type StateCounts,
} from "./types";

/**
 * Narrows the `[kind]` path segment. An unknown catalog is a 404, not a 422:
 * from the caller's side the URL simply does not exist.
 */
export function parseKind(value: string): ConstantKind {
  if (!isConstantKind(value)) throw new NotFoundError("That catalog does not exist.");
  return value;
}

/**
 * Attaches the push state to a catalog row. The cast is the one place the two
 * row shapes meet: `ConstantRowOf<K>` is `CatalogRowOf<K>` plus `pushState`,
 * which TypeScript cannot prove through a conditional type on a generic `K`.
 */
function withState<K extends ConstantKind>(row: CatalogRowOf<K>, pushState: PushState): ConstantRowOf<K> {
  return { ...row, pushState } as unknown as ConstantRowOf<K>;
}

const missing = (kind: ConstantKind, id: string) =>
  new NotFoundError(`No ${CONSTANT_KIND_LABELS[kind].singular} with id ${id} in the admin catalog.`);

/* -------------------------------------------------------------------------- */
/*                                    Read                                    */
/* -------------------------------------------------------------------------- */

/**
 * One page of a catalog, its rows labelled from the ledger, plus the
 * whole-catalog counts, the last compare and the most recent job.
 *
 * Six queries at most, none of which touches the main app database, and none
 * of which grows with the catalog: the page itself, its count, the ledger
 * lookup for the page's ids, the ledger's grouped counts, the row counts and
 * the two job reads.
 */
export async function listConstants<K extends ConstantKind>(
  kind: K,
  query: ListQuery = {},
): Promise<ConstantListResponse<K>> {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.min(
    LIST_PAGE_SIZE_MAX,
    Math.max(1, Math.trunc(query.pageSize ?? LIST_PAGE_SIZE_DEFAULT)),
  );

  const [{ rows, total }, counts, comparedAt, job] = await Promise.all([
    findPage(kind, { page, pageSize, q: query.q, state: query.state, country: query.country }),
    stateCounts(kind),
    lastComparedAt(kind),
    latestJob(kind),
  ]);

  const states = await stateOfRows(
    kind,
    rows.map((row) => row.id),
  );

  return {
    kind,
    rows: rows.map((row) => withState(row, states.get(row.id) ?? "unknown")),
    page,
    pageSize,
    total,
    counts,
    lastComparedAt: comparedAt,
    latestJob: job,
  };
}

/**
 * The catalog's figures. `unknown` is not stored anywhere: it is what is left
 * of the catalog once the ledger's three states are accounted for, which is
 * exactly the set of rows nothing has compared yet.
 *
 * It is measured against `total` — every row, retired ones included — because
 * that is the set the ledger describes: a compare walks the whole catalog and
 * labels retired rows like any other, and the push states are about the main
 * database's copy, not about retirement. Subtracting the retired rows here
 * would under-report `unknown` by exactly the retired count. Clamped at zero,
 * because a ledger entry can outlive its row: a row deleted straight in the
 * database leaves its entry behind, and a compare only re-labels the ids one
 * of the two databases still has.
 */
async function stateCounts(kind: ConstantKind): Promise<StateCounts> {
  const [total, retired, ledger] = await Promise.all([
    countRows(kind),
    isRetirable(kind) ? countRows(kind, { scope: "retired" }) : Promise.resolve(0),
    countStates(kind),
  ]);
  const known = ledger.new + ledger.changed + ledger.synced;
  return {
    total,
    new: ledger.new,
    changed: ledger.changed,
    synced: ledger.synced,
    unknown: Math.max(0, total - known),
    retired,
    mainOnly: ledger.mainOnly,
  };
}

/** One row with the push state the ledger holds for it. */
export async function getWithState<K extends ConstantKind>(
  kind: K,
  id: string,
): Promise<ConstantRowOf<K>> {
  const row = await getConstant(kind, id);
  if (!row) throw missing(kind, id);
  const states = await stateOfRows(kind, [row.id]);
  return withState(row, states.get(row.id) ?? "unknown");
}

/* -------------------------------------------------------------------------- */
/*                                   Write                                    */
/* -------------------------------------------------------------------------- */

/**
 * Creates a row in the admin catalog and records its state.
 *
 * A generated UUID is new by construction, so those kinds skip the
 * comparison. The sequence-keyed kinds (`cryptocurrencies`, `etfs`, `stocks`)
 * cannot: the number the admin sequence just handed out may already exist in
 * the main database — pushed by an earlier row that has since been deleted
 * here — in which case the honest state is `changed`, and claiming `new` would
 * hide a row a push is about to overwrite.
 */
export async function createWithState<K extends ConstantKind>(
  kind: K,
  input: ConstantInputOf<K>,
): Promise<ConstantRowOf<K>> {
  const row = await createConstant(kind, input);
  const state = hasIntegerId(kind) ? await compareState(kind, row) : "new";
  await setState(kind, row.id, state);
  return withState(row, state);
}

/** Applies a patch and re-reads the one row's state, which the edit may have changed. */
export async function updateWithState<K extends ConstantKind>(
  kind: K,
  id: string,
  patch: ConstantPatchOf<K>,
): Promise<ConstantRowOf<K>> {
  const row = await updateConstant(kind, id, patch);
  const state = await compareState(kind, row);
  await setState(kind, row.id, state);
  return withState(row, state);
}

/**
 * Categories, account types and markets are retired (`deleted_at`); the other
 * kinds are removed from the admin catalog outright. A stock still referenced
 * by an admin-side portfolio, trade or watchlist is refused with a 409.
 *
 * A retirement is a change like any other, so the row is re-compared and stays
 * in the ledger — `changed` until it is pushed. A hard delete leaves nothing
 * to describe, so its ledger entry goes; the copy in the main database will
 * turn up as `main_only` at the next compare.
 */
export async function removeConstant(kind: ConstantKind, id: string): Promise<void> {
  await deleteConstant(kind, id);
  if (!isRetirable(kind)) {
    await removeState(kind, id);
    return;
  }
  const row = await getConstant(kind, id);
  if (!row) {
    await removeState(kind, id);
    return;
  }
  await setState(kind, row.id, await compareState(kind, row));
}

/* -------------------------------------------------------------------------- */
/*                                    Jobs                                    */
/* -------------------------------------------------------------------------- */

/**
 * Starts a push of the requested rows into the main app database.
 *
 * The target is resolved first, so a bad id list is a plain 404 or 422 with no
 * job left behind. Requests of at most `PUSH_INLINE_MAX` rows are then run
 * inline and answered with the finished job; bigger ones answer `running` at
 * once and are followed through the jobs endpoints.
 */
export async function startPush(
  kind: ConstantKind,
  input: PushInput,
  actorUserId: string | null,
): Promise<ConstantJob> {
  const target = await preparePush(kind, input);
  return beginJob({
    kind,
    type: "push",
    requestedBy: actorUserId,
    request: pushRequestRecord(input),
    total: target.total,
    inline: target.total <= PUSH_INLINE_MAX,
    work: pushWork(kind, target, { actorUserId, request: input }),
  });
}

/**
 * The push request as the job row records it. A long id list is kept only in
 * part: the job exists to be read by a person, and 5000 ids in a JSONB column
 * serve nobody. The count is always exact.
 */
function pushRequestRecord(input: PushInput): { scope?: string; ids?: string[]; count?: number; truncated?: boolean } {
  if (input.ids === undefined) return { scope: input.scope };
  const ids = input.ids.slice(0, PUSH_REQUEST_IDS_KEPT);
  return {
    ids,
    count: input.ids.length,
    ...(input.ids.length > ids.length ? { truncated: true } : {}),
  };
}

/** How many ids of a long push request are kept on the job row. */
const PUSH_REQUEST_IDS_KEPT = 100;

/**
 * Starts a compare that rebuilds the kind's ledger. Catalogs of at most
 * `COMPARE_INLINE_MAX` rows finish before the response is sent.
 */
export async function startCompare(
  kind: ConstantKind,
  actorUserId: string | null,
): Promise<ConstantJob> {
  const total = await countRows(kind);
  return beginJob({
    kind,
    type: "compare",
    requestedBy: actorUserId,
    request: {},
    total,
    inline: total <= COMPARE_INLINE_MAX,
    work: compareWork(kind, total),
  });
}

/** The kind's recent jobs, newest first. */
export function listConstantJobs(kind: ConstantKind, limit: number): Promise<ConstantJob[]> {
  return listJobs(kind, limit);
}

/** One job of this kind, for polling. */
export async function getConstantJob(kind: ConstantKind, jobId: string): Promise<ConstantJob> {
  const job = await getJob(kind, jobId);
  if (!job) throw new NotFoundError(`No job with id ${jobId} for ${CONSTANT_KIND_LABELS[kind].plural}.`);
  return job;
}
