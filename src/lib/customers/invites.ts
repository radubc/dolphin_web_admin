import "server-only";
/**
 * Invitations to the consumer app, recorded in the **admin database**
 * (`admin_customer_invites`) and carried out in the **customer Cognito pool**.
 *
 * The row is written before Cognito is called and is never deleted:
 *
 * - the create succeeds → the row keeps the `sub`, when the email went out and
 *   how many times;
 * - the create fails → the row stays as `failed` with Cognito's reason, so an
 *   operator can see what happened. A retry is a **new** invitation, not a
 *   repair of the old one;
 * - the person signs in → the consumer app writes a `users` row with that
 *   `sub`, and `reconcileAcceptedInvites()` flips the invitation to
 *   `accepted`. Nothing is written to the main database, ever: acceptance is
 *   read there and recorded here.
 *
 * Revoking deletes the pool account, and only while it has never been used
 * (`deleteUnconfirmedUser` refuses anything else). A person who has signed in
 * is a customer, not an invitation.
 *
 * A missing `admin_customer_invites` table surfaces as Prisma's P2021, which
 * `adminHandler` renders as 503 `admin_schema_missing` — the app does not
 * pretend to have a list it does not have.
 */
import { Prisma } from "@/generated/prisma-admin/client";
import { ApiError, ConflictError, NotFoundError, ServiceUnavailableError } from "@/lib/api/errors";
import { prismaAdmin } from "@/lib/prisma-admin";
import {
  COGNITO_UNAVAILABLE,
  INVITE_ALREADY_USED_MESSAGE,
  availability,
  createInvitedUser,
  deleteUnconfirmedUser,
  resendInvitation,
  translateCognitoError,
} from "./cognito";
import { recordEventQuietly } from "./lifecycle";
import { findLiveUserByEmail, findUsersByCognitoSub } from "./repository";
import type { ResolvedInviteListQuery } from "./schemas";
import type { CreateInviteInput, CustomerInvite, InviteStatus } from "./types";

/** How many open invitations one acceptance sweep looks at. */
const RECONCILE_MAX = 500;

/** Cognito messages are short; the column is TEXT but the UI shows one line. */
const ERROR_MAX = 500;

const inviteInclude = { admin_users: { select: { email: true } } } satisfies Prisma.admin_customer_invitesInclude;

type InviteRow = Prisma.admin_customer_invitesGetPayload<{ include: typeof inviteInclude }>;

const INVITE_STATUSES: readonly InviteStatus[] = ["invited", "accepted", "revoked", "failed"];

function toInvite(row: InviteRow): CustomerInvite {
  return {
    id: row.id,
    email: row.email,
    cognitoUsername: row.cognito_username,
    cognitoSub: row.cognito_sub,
    // The column is a plain TEXT with a CHECK; anything unexpected reads as
    // `failed` rather than as a value the UI has no case for.
    status: (INVITE_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as InviteStatus)
      : "failed",
    note: row.note,
    invitedBy: row.invited_by,
    invitedByEmail: row.admin_users?.email ?? null,
    createdAt: row.created_at.toISOString(),
    lastSentAt: row.last_sent_at?.toISOString() ?? null,
    sendCount: row.send_count,
    acceptedAt: row.accepted_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    error: row.error,
  };
}

/** Refuses the write before anything is recorded when the pool is unusable. */
function requireSendable(): void {
  const { canSend, reason } = availability();
  if (!canSend) {
    throw new ServiceUnavailableError(
      COGNITO_UNAVAILABLE,
      reason ?? "Invitations cannot be sent from this deployment.",
    );
  }
}

/**
 * One audit row per invitation change.
 *
 * Best effort on purpose, for the same reason the catalog push takes:
 * `target_type = 'customer_invite'` is only allowed once
 * `docs/sql/010_customers.sql` has run, and a database that has not been
 * updated yet must not turn a sent invitation into a 500. The temporary
 * password is never part of it — we never see it.
 */
async function recordInviteAudit(
  actorUserId: string | null,
  action: string,
  invite: { id: string; email: string },
  extra: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  try {
    await prismaAdmin.admin_permission_audit_events.create({
      data: {
        actor_user_id: actorUserId,
        action,
        target_type: "customer_invite",
        target_id: invite.id,
        metadata: {
          // `target_label` is lifted out of metadata into `AuditEvent.targetLabel`
          // by the admin-access repository.
          target_label: invite.email,
          email: invite.email,
          inviteId: invite.id,
          ...extra,
        } as Prisma.InputJsonObject,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n").filter(Boolean).at(-1) : String(error);
    console.warn(`[customers] audit skipped: ${reason}`);
  }
}

/* -------------------------------------------------------------------------- */
/*                             Acceptance detection                           */
/* -------------------------------------------------------------------------- */

/**
 * Flips every open invitation whose `sub` now has a `users` row to
 * `accepted`, dated by the `users` row's `created_at` (the moment the
 * consumer app first saw them).
 *
 * Called before both list endpoints. It is a read of the main database and a
 * write of the admin one; the main database is never touched.
 */
export async function reconcileAcceptedInvites(): Promise<number> {
  const open = await prismaAdmin.admin_customer_invites.findMany({
    where: { status: "invited", cognito_sub: { not: null } },
    select: { id: true, cognito_sub: true },
    take: RECONCILE_MAX,
  });
  const pending = open.filter((row): row is { id: string; cognito_sub: string } => row.cognito_sub !== null);
  if (pending.length === 0) return 0;

  const users = await findUsersByCognitoSub(pending.map((row) => row.cognito_sub));
  let accepted = 0;
  for (const row of pending) {
    const user = users.get(row.cognito_sub);
    if (user === undefined) continue;
    // Scoped to `status: "invited"` (not a plain `update` by id) so two
    // concurrent sweeps — or a sweep racing `resendInvite`'s own reconcile —
    // cannot both write the same row.
    const result = await prismaAdmin.admin_customer_invites.updateMany({
      where: { id: row.id, status: "invited" },
      data: { status: "accepted", accepted_at: user.createdAt ?? new Date(), error: null },
    });
    accepted += result.count;
  }
  return accepted;
}

/* -------------------------------------------------------------------------- */
/*                                    Read                                    */
/* -------------------------------------------------------------------------- */

export interface InvitePage {
  items: CustomerInvite[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<InviteStatus, number>;
}

/**
 * One page of invitations, newest first, plus the counts per status.
 *
 * The counts describe the whole table, not the filtered page: they are the
 * summary line above the list, and a summary that changed with the search box
 * would say less than nothing.
 */
export async function listInvites(query: ResolvedInviteListQuery): Promise<InvitePage> {
  const where: Prisma.admin_customer_invitesWhereInput = {};
  if (query.status !== "all") where.status = query.status;
  const q = query.q?.trim();
  if (q !== undefined && q !== "") {
    where.OR = [
      { email: { contains: q, mode: "insensitive" } },
      { note: { contains: q, mode: "insensitive" } },
    ];
  }

  const [total, rows, grouped] = await Promise.all([
    prismaAdmin.admin_customer_invites.count({ where }),
    prismaAdmin.admin_customer_invites.findMany({
      where,
      include: inviteInclude,
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prismaAdmin.admin_customer_invites.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const counts: Record<InviteStatus, number> = { invited: 0, accepted: 0, revoked: 0, failed: 0 };
  for (const row of grouped) {
    if ((INVITE_STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status as InviteStatus] = row._count._all;
    }
  }
  return { items: rows.map(toInvite), total, page: query.page, pageSize: query.pageSize, counts };
}

/** Any RFC 4122 variant; `admin_customer_invites.id` is a Postgres `uuid`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One invitation by id. An id that is not a UUID is a 404 rather than a
 * database error: from the caller's side that invitation does not exist, and
 * the shape of the id is not something the answer should confirm.
 */
async function requireInvite(id: string): Promise<InviteRow> {
  if (!UUID.test(id)) throw new NotFoundError("That invitation does not exist.");
  const row = await prismaAdmin.admin_customer_invites.findUnique({ where: { id }, include: inviteInclude });
  if (row === null) throw new NotFoundError("That invitation does not exist.");
  return row;
}

/* -------------------------------------------------------------------------- */
/*                                   Writes                                   */
/* -------------------------------------------------------------------------- */

/**
 * Creates the invitation: the row first, then the Cognito account, then the
 * result back onto the row.
 *
 * Two refusals happen before anything is written — an open invitation for the
 * same address, and an address that already has a consumer-app account — and
 * the database's partial unique index on `lower(email) WHERE status =
 * 'invited'` is the last word if two operators press the button together.
 */
export async function createInvite(
  input: CreateInviteInput,
  actorUserId: string | null,
): Promise<CustomerInvite> {
  requireSendable();
  const email = input.email.trim().toLowerCase();

  const open = await prismaAdmin.admin_customer_invites.findFirst({
    where: { status: "invited", email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
  if (open !== null) {
    throw new ConflictError(
      "There is already an open invitation for that address. Resend it, or revoke it and start again.",
    );
  }
  const existingUser = await findLiveUserByEmail(email);
  if (existingUser !== null) {
    throw new ConflictError("Someone with that address already has an account in the consumer app.");
  }

  let row: InviteRow;
  try {
    row = await prismaAdmin.admin_customer_invites.create({
      data: {
        email,
        cognito_username: email,
        status: "invited",
        note: input.note ?? null,
        invited_by: actorUserId,
        send_count: 0,
      },
      include: inviteInclude,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ConflictError("There is already an open invitation for that address.");
    }
    throw error;
  }

  try {
    const account = await createInvitedUser(email, { name: input.name, locale: input.locale });
    const sent = await prismaAdmin.admin_customer_invites.update({
      where: { id: row.id },
      data: {
        cognito_username: account.username,
        cognito_sub: account.sub,
        last_sent_at: new Date(),
        send_count: 1,
        error: null,
      },
      include: inviteInclude,
    });
    await recordInviteAudit(actorUserId, "customer_invite_created", sent, { name: input.name ?? null });
    // The lifecycle log's first step. Written here rather than left to the
    // nightly diff because this is the one moment the console *knows* an
    // invitation was sent, to the second and with the operator attached; the
    // diff would only ever see "a new sub appeared" the following night, and
    // could not tell it from an account created in the AWS console.
    if (account.sub !== null) {
      await recordEventQuietly({
        sub: account.sub,
        event: "invited",
        at: new Date(),
        source: "console",
        details: { email, inviteId: sent.id, invitedBy: actorUserId },
      });
    }
    return toInvite(sent);
  } catch (error) {
    const apiError = error instanceof ApiError ? error : translateCognitoError(error, "creating a customer account");
    await prismaAdmin.admin_customer_invites.update({
      where: { id: row.id },
      data: { status: "failed", error: apiError.message.slice(0, ERROR_MAX) },
    });
    await recordInviteAudit(actorUserId, "customer_invite_failed", row, { reason: apiError.code });
    throw apiError;
  }
}

/**
 * Sends the invitation email again. Only an open invitation can be resent: an
 * accepted one has nothing to send, and a revoked or failed one has no pool
 * account behind it.
 */
export async function resendInvite(id: string, actorUserId: string | null): Promise<CustomerInvite> {
  requireSendable();
  const row = await requireInvite(id);
  if (row.status !== "invited") {
    throw new ConflictError(
      `That invitation is ${row.status}, so there is nothing to resend. Create a new invitation instead.`,
    );
  }

  try {
    await resendInvitation(row.cognito_username);
  } catch (error) {
    const apiError = error instanceof ApiError ? error : translateCognitoError(error, "resending a customer invitation");
    if (apiError instanceof ConflictError && apiError.message === INVITE_ALREADY_USED_MESSAGE) {
      // Not a send failure to record: the account has already been confirmed,
      // which is exactly what `reconcileAcceptedInvites()` looks for. Bring
      // the row up to date if the `users` row has already appeared, otherwise
      // leave it as-is (the sweep will catch it once it does) and just
      // rethrow the 409 for the caller.
      if (row.cognito_sub !== null) {
        const users = await findUsersByCognitoSub([row.cognito_sub]);
        const user = users.get(row.cognito_sub);
        if (user !== undefined) {
          await prismaAdmin.admin_customer_invites.updateMany({
            where: { id: row.id, status: "invited" },
            data: { status: "accepted", accepted_at: user.createdAt ?? new Date(), error: null },
          });
        }
      }
      throw apiError;
    }
    // The invitation stays open: the account is still there and a later
    // attempt may work. The reason is kept on the row so the page can say why
    // the last one did not.
    await prismaAdmin.admin_customer_invites.update({
      where: { id: row.id },
      data: { error: apiError.message.slice(0, ERROR_MAX) },
    });
    throw apiError;
  }

  const sent = await prismaAdmin.admin_customer_invites.update({
    where: { id: row.id },
    data: { last_sent_at: new Date(), send_count: { increment: 1 }, error: null },
    include: inviteInclude,
  });
  await recordInviteAudit(actorUserId, "customer_invite_resent", sent, { sendCount: sent.send_count });
  return toInvite(sent);
}

/**
 * Withdraws an open invitation: the unused pool account is deleted and the row
 * is marked `revoked`. An account that has already been used is refused by
 * `deleteUnconfirmedUser` with a 409 — that person is a customer now.
 *
 * A pool account that is already gone is not an error: the invitation is
 * withdrawn either way, which is what the operator asked for.
 *
 * `requireSendable()` gates this too, even though revoking sends nothing: a
 * revoke that only flipped the row's status while the pool is unreachable (or
 * not configured) would mark the invitation withdrawn while the Cognito
 * account — and its temporary password — is still live, so the record would
 * be lying about whether the invitation can still be used.
 */
export async function revokeInvite(id: string, actorUserId: string | null): Promise<CustomerInvite> {
  requireSendable();
  const row = await requireInvite(id);
  if (row.status !== "invited") {
    throw new ConflictError(`That invitation is ${row.status}, so there is nothing to revoke.`);
  }

  try {
    await deleteUnconfirmedUser(row.cognito_username);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    console.warn(`[customers] revoking an invitation whose pool account is already gone: ${row.id}`);
  }

  const revoked = await prismaAdmin.admin_customer_invites.update({
    where: { id: row.id },
    data: { status: "revoked", revoked_at: new Date(), error: null },
    include: inviteInclude,
  });
  await recordInviteAudit(actorUserId, "customer_invite_revoked", revoked);
  // A revoke deletes the pool account, so to the lifecycle log this *is* a
  // deletion — the same event the nightly diff would infer tomorrow from the
  // sub no longer being in the directory, recorded now with the reason and
  // the operator. The unique key means the diff's later attempt is a no-op
  // only if it lands on the same instant, which it will not; the diff dates
  // its events at midnight of the snapshot day, so a revoke can produce two
  // `deleted` rows a day apart. Churn dedupes per sub per month, so it is
  // still one departure.
  if (row.cognito_sub !== null) {
    await recordEventQuietly({
      sub: row.cognito_sub,
      event: "deleted",
      at: new Date(),
      source: "console",
      details: {
        email: row.email,
        inviteId: row.id,
        reason: "invitation revoked",
        revokedBy: actorUserId,
      },
    });
  }
  return toInvite(revoked);
}
