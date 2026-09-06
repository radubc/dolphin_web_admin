import "server-only";
/**
 * Authorization for the admin console: the allowlist, the action keys and the
 * super-admin bypass described in `docs/admin-access/README.md`.
 *
 * Authentication (`verifySession` / `authenticate`) says who the caller is.
 * Nothing here trusts that alone: the Cognito `sub` has to match an enabled
 * `admin_users` row, and every route or control then names the action it
 * needs. Default deny: no row, a disabled row, or a missing action all refuse.
 *
 * Two entry points, one per caller kind:
 *
 * - Pages and layouts call `requireAdminSession()`, which redirects a
 *   signed-in but non-allowlisted person to `/no-access`.
 * - Route Handlers are exported through `adminHandler()`, which layers the
 *   principal lookup and the action check over `protectedHandler` and answers
 *   refusals with 403 `forbidden`. The message never says *why*: "not on the
 *   allowlist" and "missing action" look the same from outside.
 */
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { ApiError, ForbiddenError, isApiError, ValidationError, ConflictError, NotFoundError } from "@/lib/api/errors";
import { protectedHandler, type HandlerOptions } from "@/lib/api/handler";
import { requireSession } from "@/lib/auth/require-session";
import type { Session } from "@/lib/auth/session";
import { AdminAccessError, getAdminAccessRepository } from "./repository";
import { canDo, type ActionKey, type AdminPrincipal } from "./types";

/** Where a signed-in person with no allowlist row is sent. */
export const NO_ACCESS_PATH = "/no-access";

/**
 * The principal for a verified session, or `null` when the person is not an
 * enabled admin. Also stamps `last_login_at` and refreshes the row's email and
 * name from the token, throttled by the repository.
 */
export async function resolvePrincipal(session: Session): Promise<AdminPrincipal | null> {
  const repository = getAdminAccessRepository();
  const principal = await repository.findPrincipalBySub(session.userId);
  if (!principal) return null;
  await repository.recordLogin(principal.user.id, {
    email: session.email,
    name: session.name,
  });
  return principal;
}

/**
 * The gate every authenticated page goes through, on top of `requireSession`.
 * Returns the session and the principal, or never returns.
 */
export async function requireAdminSession(): Promise<{
  session: Session;
  principal: AdminPrincipal;
}> {
  const session = await requireSession();
  const principal = await resolvePrincipal(session);
  if (!principal) {
    redirect(NO_ACCESS_PATH);
  }
  return { session, principal };
}

/** Throws 403 unless the principal is a super-admin or holds `action`. */
export function assertAction(principal: AdminPrincipal, action: ActionKey): void {
  if (!canDo(principal, action)) {
    throw new ForbiddenError();
  }
}

/** Throws 403 unless the principal is a super-admin. */
export function assertSuperAdmin(principal: AdminPrincipal): void {
  if (!principal.isSuperAdmin) {
    throw new ForbiddenError();
  }
}

/** Per-route authorization. Omit both to require only an enabled allowlist row. */
export interface AdminHandlerOptions extends HandlerOptions {
  /** The action key the caller must hold (super-admins always pass). */
  action?: ActionKey;
  /** Only super-admins may call this. Stronger than `action`; both may be set. */
  superAdmin?: boolean;
}

/**
 * Translates a repository rule violation into the API envelope. Anything else
 * is left for `apiHandler`, which logs it and answers a generic 500.
 */
function toApiError(error: unknown): unknown {
  if (isApiError(error)) return error;
  if (error instanceof AdminAccessError) {
    switch (error.code) {
      case "not_found":
        return new NotFoundError(error.message);
      case "conflict":
        return new ConflictError(error.message);
      case "invalid":
        return new ValidationError(error.message);
    }
  }
  return error;
}

/**
 * `protectedHandler` plus the admin-access checks. `fn` receives the principal
 * in place of the bare session; the session is reachable as `principal.user`
 * plus whatever the id token carried.
 */
export function adminHandler<Ctx = unknown>(
  fn: (request: NextRequest, ctx: Ctx, principal: AdminPrincipal) => Promise<Response>,
  options: AdminHandlerOptions = {},
): (request: NextRequest, ctx: Ctx) => Promise<Response> {
  const { action, superAdmin, ...handlerOptions } = options;
  return protectedHandler<Ctx>(async (request, ctx, session) => {
    const principal = await resolvePrincipal(session);
    if (!principal) {
      throw new ForbiddenError();
    }
    if (superAdmin) assertSuperAdmin(principal);
    if (action) assertAction(principal, action);
    try {
      return await fn(request, ctx, principal);
    } catch (error) {
      const translated = toApiError(error);
      if (translated instanceof ApiError) throw translated;
      throw error;
    }
  }, handlerOptions);
}
