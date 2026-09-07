import "server-only";
/**
 * The glue the Constants routes call: the admin catalog (`./repository.ts`)
 * plus its state against the main database (`./push.ts`), shaped into the
 * responses declared in `./types.ts`.
 *
 * Routes stay thin — they validate `[kind]` and the body and call one of these.
 */
import { NotFoundError } from "@/lib/api/errors";
import { compareWithMain, pushConstants, type PushOptions } from "./push";
import {
  createConstant,
  deleteConstant,
  getConstant,
  listConstants,
  updateConstant,
  type CatalogRowOf,
} from "./repository";
import {
  CONSTANT_KIND_LABELS,
  isConstantKind,
  type ConstantInputOf,
  type ConstantKind,
  type ConstantListResponse,
  type ConstantPatchOf,
  type ConstantRowOf,
  type PushResponse,
  type PushState,
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

/** Every row of one kind, each labelled against the main database. */
export async function listWithState<K extends ConstantKind>(kind: K): Promise<ConstantListResponse<K>> {
  const rows = await listConstants(kind);
  const { states, mainOnlyIds, comparedAt } = await compareWithMain(kind, rows);
  return {
    kind,
    rows: rows.map((row) => withState(row, states.get(row.id) ?? "new")),
    mainOnlyIds,
    comparedAt,
  };
}

/** One row with its push state. */
export async function getWithState<K extends ConstantKind>(
  kind: K,
  id: string,
): Promise<ConstantRowOf<K>> {
  const row = await getConstant(kind, id);
  if (!row) throw missing(kind, id);
  const { states } = await compareWithMain(kind, [row], { includeMainOnly: false });
  return withState(row, states.get(row.id) ?? "new");
}

/**
 * Creates a row in the admin catalog. Its id is brand new, so the main
 * database cannot have it: the state is always `new`, no comparison needed.
 */
export async function createWithState<K extends ConstantKind>(
  kind: K,
  input: ConstantInputOf<K>,
): Promise<ConstantRowOf<K>> {
  const row = await createConstant(kind, input);
  return withState(row, "new");
}

/** Applies a patch and re-reads the state, which the edit may have changed. */
export async function updateWithState<K extends ConstantKind>(
  kind: K,
  id: string,
  patch: ConstantPatchOf<K>,
): Promise<ConstantRowOf<K>> {
  const row = await updateConstant(kind, id, patch);
  const { states } = await compareWithMain(kind, [row], { includeMainOnly: false });
  return withState(row, states.get(row.id) ?? "new");
}

/** Categories are retired; the other kinds are removed from the admin catalog. */
export async function removeConstant(kind: ConstantKind, id: string): Promise<void> {
  await deleteConstant(kind, id);
}

/** Upserts the selected rows (or the whole kind) into the main database. */
export async function push(kind: ConstantKind, options: PushOptions): Promise<PushResponse> {
  return pushConstants(kind, options);
}
