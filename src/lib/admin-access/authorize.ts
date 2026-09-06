import "server-only";
/**
 * Authorization for the admin console: the allowlist, and the access map
 * stored in the admin database (`admin_pages`, `admin_endpoints`).
 *
 * Authentication (`verifySession` / `authenticate`) says who the caller is.
 * Nothing here trusts that alone: the Cognito `sub` has to match an enabled
 * `admin_users` row, and every page and endpoint is then judged by its rule —
 * `evaluateRule` in `./types`, the same function the client uses to decide
 * what to draw. Default deny: no row, a disabled row, an unregistered page or
 * endpoint (for anyone but a super-admin), or a missing action all refuse.
 *
 * Entry points, one per caller kind:
 *
 * - Layouts call `requireAdminSession()`: session plus allowlist.
 * - Pages call `requirePageAccess(pageKey)`: the above plus the page's rule;
 *   a refused caller lands on `/no-access`.
 * - Route Handlers are exported through `adminHandler(fn, { endpoint })`,
 *   which layers the principal lookup and the endpoint's rule over
 *   `protectedHandler`. Refusals are 403 `forbidden`; a disabled endpoint is
 *   503 `endpoint_disabled`. The message never says *why* the caller was
 *   refused.
 *
 * When the admin database has no `admin_*` tables yet (the SQL in `docs/sql/`
 * has not been run), every check would fail with a Postgres "relation does
 * not exist"; that is caught once here and turned into a redirect to `/setup`
 * so the person sees instructions instead of a 500.
 */
import { cache } from "react";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import {
  ApiError,
  ConflictError,
  ForbiddenError,
  isApiError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "@/lib/api/errors";
import { protectedHandler, type HandlerOptions } from "@/lib/api/handler";
import { requireSession } from "@/lib/auth/require-session";
import type { Session } from "@/lib/auth/session";
import { isMissingTableError } from "./prisma-repository";
import { AdminAccessError, getAdminAccessRepository } from "./repository";
import {
  capabilitiesOf,
  evaluateRule,
  type AccessDecision,
  type AdminPrincipal,
  type PageRule,
} from "./types";

/** Where a signed-in person with no allowlist row, or no access to a page, is sent. */
export const NO_ACCESS_PATH = "/no-access";

/** Where every check sends the browser while the admin schema is missing. */
export const SETUP_PATH = "/setup";

/* -------------------------------------------------------------------------- */
/*                                  Principal                                 */
/* -------------------------------------------------------------------------- */

/**
 * The principal for a verified session, or `null` when the person is not an
 * enabled admin. Memoised per request with React `cache`, so a layout and a
 * page in the same render share one lookup. Also stamps `last_login_at`,
 * throttled by the repository.
 *
 * @throws the repository's error when the admin schema is missing; callers
 * decide whether that becomes a redirect (pages) or a 503 (API).
 */
export const resolvePrincipal = cache(async (session: Session): Promise<AdminPrincipal | null> => {
  const repository = getAdminAccessRepository();
  const principal = await repository.findPrincipalBySub(session.userId);
  if (!principal) return null;
  await repository.recordLogin(principal.user.id, { email: session.email, name: session.name });
  return principal;
});

/**
 * The gate every authenticated layout goes through, on top of `requireSession`.
 * Returns the session and the principal, or never returns.
 */
export async function requireAdminSession(): Promise<{ session: Session; principal: AdminPrincipal }> {
  const session = await requireSession();
  let principal: AdminPrincipal | null;
  try {
    principal = await resolvePrincipal(session);
  } catch (error) {
    if (isMissingTableError(error)) redirect(SETUP_PATH);
    throw error;
  }
  if (!principal) {
    redirect(NO_ACCESS_PATH);
  }
  return { session, principal };
}

/* -------------------------------------------------------------------------- */
/*                                    Pages                                   */
/* -------------------------------------------------------------------------- */

/** All page and quick-action rules, once per request. */
export const loadPageRules = cache(async (): Promise<PageRule[]> => {
  return getAdminAccessRepository().listPageRules();
});

/** The rules this principal may open, in rail order. Unregistered = super-admin only. */
export async function accessiblePages(principal: AdminPrincipal): Promise<PageRule[]> {
  const rules = await loadPageRules();
  const capabilities = capabilitiesOf(principal);
  return rules.filter(
    (rule) => rule.inCode && evaluateRule(capabilities, rule.registered ? rule : null) === "allow",
  );
}

/** The decision for one page key, for a principal. */
export async function pageDecision(principal: AdminPrincipal, pageKey: string): Promise<AccessDecision> {
  const rule = (await loadPageRules()).find((candidate) => candidate.key === pageKey);
  if (!rule || !rule.inCode) return principal.isSuperAdmin ? "allow" : "unregistered";
  return evaluateRule(capabilitiesOf(principal), rule.registered ? rule : null);
}

/**
 * The gate every authenticated page goes through. Verifies the session, the
 * allowlist and the page's rule from the access map. Returns the session and
 * the principal, or never returns.
 */
export async function requirePageAccess(pageKey: string): Promise<{ session: Session; principal: AdminPrincipal }> {
  const { session, principal } = await requireAdminSession();
  const decision = await pageDecision(principal, pageKey);
  if (decision !== "allow") {
    redirect(NO_ACCESS_PATH);
  }
  return { session, principal };
}

/* -------------------------------------------------------------------------- */
/*                                  Endpoints                                 */
/* -------------------------------------------------------------------------- */

/** Per-route options. `endpoint` is required: it names the rule to enforce. */
export interface AdminHandlerOptions extends HandlerOptions {
  /** The endpoint's key in `endpoint-registry.ts` and `admin_endpoints`. */
  endpoint: string;
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
  if (isMissingTableError(error)) {
    return new ServiceUnavailableError(
      "admin_schema_missing",
      "The admin database schema is not installed. Run the SQL in docs/sql.",
    );
  }
  return error;
}

/**
 * `protectedHandler` plus the admin-access checks: allowlist, then the
 * endpoint's rule from the database. `fn` receives the principal in place of
 * the bare session.
 */
export function adminHandler<Ctx = unknown>(
  fn: (request: NextRequest, ctx: Ctx, principal: AdminPrincipal) => Promise<Response>,
  options: AdminHandlerOptions,
): (request: NextRequest, ctx: Ctx) => Promise<Response> {
  const { endpoint, ...handlerOptions } = options;
  return protectedHandler<Ctx>(async (request, ctx, session) => {
    try {
      const principal = await resolvePrincipal(session);
      if (!principal) {
        throw new ForbiddenError();
      }
      const rule = await getAdminAccessRepository().getEndpointRule(endpoint);
      if (rule && !rule.isEnabled && !principal.isSuperAdmin) {
        throw new ServiceUnavailableError("endpoint_disabled", "This endpoint is switched off.");
      }
      if (evaluateRule(capabilitiesOf(principal), rule) !== "allow") {
        throw new ForbiddenError();
      }
      return await fn(request, ctx, principal);
    } catch (error) {
      const translated = toApiError(error);
      if (translated instanceof ApiError) throw translated;
      throw error;
    }
  }, { ...handlerOptions, endpoint });
}
