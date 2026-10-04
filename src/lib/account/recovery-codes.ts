import "server-only";
/**
 * Two-factor recovery codes for operators (`docs/two-factor-plan.md`, phase
 * B; the design is the consumer app's `docs/recovery-codes.md`, section 1).
 *
 * Ten single-use codes, handed out once when the authenticator app is turned
 * on (and again from "Generate new codes"), stored as SHA-256 hashes in
 * `admin_user_recovery_codes` (`docs/sql/022_admin_user_recovery_codes.sql`)
 * and redeemed at `/login` together with the password. Cognito has no backup
 * codes of its own, so these are the console's.
 *
 * `user_id` is `admin_users.id`, never the Cognito sub. Every query is pinned
 * to one `user_id`.
 *
 * The clear code exists in the server's memory for the length of one request
 * and in the browser for the length of one dialog. It is never stored, logged
 * or returned a second time; what the database holds is the digest.
 *
 * ## Raw queries, for now
 *
 * The table does not exist in `prisma-admin/schema.prisma` until the owner
 * has run SQL 022 and pulled the schema (`npx prisma db pull --config
 * prisma-admin.config.ts && npm run prisma:generate`), so the data access
 * below is `$queryRaw` / `$executeRaw` tagged templates (parameterised, no
 * string concatenation) against the table by name. That is what lets this
 * ship and compile before the pull: until the table exists the reads answer
 * "no codes", a claim answers "no such code", and one warning line names the
 * SQL file. **Switch to the typed model (`prismaAdmin.admin_user_recovery_codes`)
 * once the schema has been pulled** — the shapes are written to make that a
 * mechanical change.
 */
import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@/generated/prisma-admin/client";
import { prismaAdmin } from "@/lib/prisma-admin";

/**
 * 23 letters + 8 digits = 31 symbols. No `0`/`o`, no `1`/`i`/`l`: the pairs
 * people misread. Lowercase, and a typed uppercase letter is lowercased before
 * matching, so the case never matters.
 */
export const RECOVERY_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Symbols per code: 31¹⁰ ≈ 2⁴⁹·⁵, hopeless to guess under the sign-in limits. */
export const RECOVERY_CODE_LENGTH = 10;

/** Codes per set. One set at a time per person. */
export const RECOVERY_CODE_COUNT = 10;

/** The shape a person sees: five symbols, a dash, five symbols. */
const DISPLAY_GROUP = 5;

/**
 * Largest byte value that maps evenly onto the alphabet: 31 × 8 = 248. A byte
 * at or above it is thrown away rather than taken modulo 31, so every symbol
 * is exactly as likely as every other.
 */
const REJECTION_THRESHOLD =
  Math.floor(256 / RECOVERY_CODE_ALPHABET.length) * RECOVERY_CODE_ALPHABET.length;

const ALPHABET_SET: ReadonlySet<string> = new Set(RECOVERY_CODE_ALPHABET);

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One fresh code in its normalised form (ten lowercase symbols, no dash),
 * from `crypto.randomBytes` with rejection sampling.
 */
export function generateRecoveryCode(): string {
  let code = "";
  while (code.length < RECOVERY_CODE_LENGTH) {
    // A few more bytes than symbols, so a rejection rarely costs another call.
    const bytes = randomBytes(RECOVERY_CODE_LENGTH * 2);
    for (const byte of bytes) {
      if (byte >= REJECTION_THRESHOLD) continue;
      code += RECOVERY_CODE_ALPHABET[byte % RECOVERY_CODE_ALPHABET.length];
      if (code.length === RECOVERY_CODE_LENGTH) break;
    }
  }
  return code;
}

/**
 * A set of distinct codes, normalised. Distinct because the table has a unique
 * key on `(user_id, code_hash)` and a duplicate would make the insert fail;
 * at 31¹⁰ possibilities a collision is close to impossible, but the loop costs
 * nothing.
 */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    codes.add(generateRecoveryCode());
  }
  return [...codes];
}

/**
 * The form a person types or reads from the dialog: `xxxxx-xxxxx`. The input
 * must already be normalised.
 */
export function formatRecoveryCode(normalised: string): string {
  return `${normalised.slice(0, DISPLAY_GROUP)}-${normalised.slice(DISPLAY_GROUP)}`;
}

/**
 * What a typed code becomes before it is hashed or matched: lowercased, with
 * everything outside the alphabet dropped (the dash, spaces, a pasted bullet).
 * `null` when the result is not exactly ten symbols — which is also what
 * happens when someone types `O` for `0` or `l` for `1`: neither is in the
 * alphabet, so the code is refused before any lookup, by design.
 */
export function normaliseRecoveryCode(input: string): string | null {
  let normalised = "";
  for (const character of input.toLowerCase()) {
    if (ALPHABET_SET.has(character)) normalised += character;
  }
  return normalised.length === RECOVERY_CODE_LENGTH ? normalised : null;
}

/** SHA-256 of the normalised code, lowercase hex: what `code_hash` holds. */
export function hashRecoveryCode(normalised: string): string {
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

/* -------------------------------------------------------------------------- */
/* The table                                                                  */
/* -------------------------------------------------------------------------- */

/** What `GET /api/v1/admin/me/mfa` reports about an operator's codes. */
export interface RecoveryCodesSummary {
  /** Rows with `used_at IS NULL`. */
  remaining: number;
  /** Rows in every state: 0 or 10 in practice, 1 after a recovery. */
  total: number;
  /** The latest `used_at` (ISO 8601) when a recovery has happened, else null. */
  usedAt: string | null;
}

/** The SQL file that creates the table, named in the one warning below and in the 503 "Generate new codes" answers. */
export const RECOVERY_CODES_TABLE_SQL = "docs/sql/022_admin_user_recovery_codes.sql";

/**
 * Postgres `42P01` (undefined table) as Prisma reports it: `P2021` from a
 * typed query, `P2010` with `meta.code` from a raw one. Both are "SQL 022 has
 * not been run here", which the reads below answer as "no codes" rather than
 * failing the Account drawer, the layout or a sign-in.
 */
export function isMissingTableError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2021") return true;
  const meta = error.meta as { code?: unknown } | undefined;
  return error.code === "P2010" && meta?.code === "42P01";
}

/** One warning per process: the table is missing and every read is empty. */
const globalForRecoveryCodes = globalThis as unknown as {
  pennySqueezeAdminRecoveryCodesTableWarned?: boolean;
};

function warnMissingTableOnce(): void {
  if (globalForRecoveryCodes.pennySqueezeAdminRecoveryCodesTableWarned) return;
  globalForRecoveryCodes.pennySqueezeAdminRecoveryCodesTableWarned = true;
  console.warn(
    `[account] admin_user_recovery_codes does not exist yet; recovery codes read as empty until ${RECOVERY_CODES_TABLE_SQL} has been run.`,
  );
}

/**
 * Replaces the operator's set: every row they have is deleted and ten fresh
 * ones inserted, in one transaction. Returns the clear codes in display form
 * (`xxxxx-xxxxx`) — the one and only time they leave the server.
 *
 * Throws when the table is missing: the callers treat a failed write as
 * "codes could not be created" and say so, never as success.
 */
export async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  const now = new Date();
  const rows = codes.map(
    (code) => Prisma.sql`(${userId}::uuid, ${hashRecoveryCode(code)}, ${now})`,
  );
  await prismaAdmin.$transaction([
    prismaAdmin.$executeRaw`DELETE FROM admin_user_recovery_codes WHERE user_id = ${userId}::uuid`,
    prismaAdmin.$executeRaw`INSERT INTO admin_user_recovery_codes (user_id, code_hash, created_at) VALUES ${Prisma.join(rows)}`,
  ]);
  return codes.map(formatRecoveryCode);
}

/**
 * The three figures the Account drawer is built from, derived from one read
 * of the operator's rows (ten at most) rather than two counts and a lookup.
 * An absent table reads as no codes.
 */
export async function summariseRecoveryCodes(userId: string): Promise<RecoveryCodesSummary> {
  let rows: { used_at: Date | null }[];
  try {
    rows = await prismaAdmin.$queryRaw<{ used_at: Date | null }[]>`
      SELECT used_at FROM admin_user_recovery_codes WHERE user_id = ${userId}::uuid`;
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    warnMissingTableOnce();
    rows = [];
  }
  let remaining = 0;
  let latestUsed: Date | null = null;
  for (const { used_at } of rows) {
    if (used_at === null) {
      remaining += 1;
    } else if (latestUsed === null || used_at > latestUsed) {
      latestUsed = used_at;
    }
  }
  return {
    remaining,
    total: rows.length,
    usedAt: latestUsed?.toISOString() ?? null,
  };
}

/**
 * Deletes every row the operator has: the authenticator was turned off from
 * the drawer. Returns how many went; an absent table is zero.
 */
export async function deleteRecoveryCodes(userId: string): Promise<number> {
  try {
    return await prismaAdmin.$executeRaw`DELETE FROM admin_user_recovery_codes WHERE user_id = ${userId}::uuid`;
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    warnMissingTableOnce();
    return 0;
  }
}

/**
 * Whether the operator has redeemed a code and not enrolled again since: a
 * row with `used_at` set survives exactly until the next enrolment replaces
 * the set. One cheap read for the `(app)` layout; no Cognito call. An absent
 * table, or any other database fault, is `false` — a layout render must not
 * fail over a nudge.
 */
export async function hasRedeemedRecoveryCode(userId: string): Promise<boolean> {
  try {
    const rows = await prismaAdmin.$queryRaw<{ id: string }[]>`
      SELECT id FROM admin_user_recovery_codes
       WHERE user_id = ${userId}::uuid AND used_at IS NOT NULL
       LIMIT 1`;
    return rows.length > 0;
  } catch (error) {
    if (isMissingTableError(error)) {
      warnMissingTableOnce();
    } else {
      console.error(`[account] user ${userId}: the recovery-code nudge could not be read.`, error);
    }
    return false;
  }
}

/**
 * Claims a code atomically: one `UPDATE` over `(user_id, code_hash, used_at
 * IS NULL)`, so two requests carrying the same code cannot both pass (a
 * select followed by an update would let both through), and a claim that
 * matches nothing costs nothing. True when exactly one row was claimed. An
 * absent table is "no such code".
 */
export async function claimRecoveryCode(
  userId: string,
  codeHash: string,
  now: Date = new Date(),
): Promise<boolean> {
  let count: number;
  try {
    count = await prismaAdmin.$executeRaw`
      UPDATE admin_user_recovery_codes SET used_at = ${now}
       WHERE user_id = ${userId}::uuid AND code_hash = ${codeHash} AND used_at IS NULL`;
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    warnMissingTableOnce();
    return false;
  }
  return count === 1;
}

/**
 * Puts a claimed code back (`used_at = NULL`) when the step after the claim —
 * turning the factor off at Cognito — was refused, so the code is not spent
 * on a recovery that did not happen.
 */
export async function unclaimRecoveryCode(userId: string, codeHash: string): Promise<void> {
  await prismaAdmin.$executeRaw`
    UPDATE admin_user_recovery_codes SET used_at = NULL
     WHERE user_id = ${userId}::uuid AND code_hash = ${codeHash}`;
}

/**
 * After a successful recovery: the operator's other rows go, the redeemed one
 * stays with its `used_at` as the record the drawer banner and the shell
 * notice are derived from. Returns how many were deleted.
 */
export async function deleteOtherRecoveryCodes(
  userId: string,
  keepCodeHash: string,
): Promise<number> {
  return prismaAdmin.$executeRaw`
    DELETE FROM admin_user_recovery_codes
     WHERE user_id = ${userId}::uuid AND code_hash <> ${keepCodeHash}`;
}

/* -------------------------------------------------------------------------- */
/* The operator behind a Cognito sub                                          */
/* -------------------------------------------------------------------------- */

/**
 * The `admin_users` row for a pool `sub`, as the recovery step needs it:
 * only an **enabled** allowlist row may redeem a code. A disabled operator
 * cannot use the console whatever their factors are, and turning a factor off
 * for them would be a change nobody asked for; the caller answers the neutral
 * error. `null` when there is no such live row. Typed query: `admin_users`
 * has always been in the schema.
 */
export async function findEnabledOperatorBySub(sub: string): Promise<{ id: string } | null> {
  const row = await prismaAdmin.admin_users.findUnique({
    where: { cognito_sub: sub },
    select: { id: true, disabled_at: true },
  });
  if (row === null || row.disabled_at !== null) return null;
  return { id: row.id };
}
