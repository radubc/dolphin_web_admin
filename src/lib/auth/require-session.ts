/**
 * The one gate every authenticated page and layout goes through.
 *
 * `verifySession()` is the cryptographic check; this wrapper adds the single
 * decision that used to be copy-pasted into each page: what to do when it comes
 * back null. Server-only, because it is a thin skin over `verifySession()`,
 * which reads httpOnly cookies.
 */
import "server-only";
import { redirect } from "next/navigation";
import { EXPIRED_SESSION_REDIRECT } from "./cookies";
import { verifySession, type Session } from "./session";

/**
 * Returns the verified session, or never returns.
 *
 * `redirect()` throws, so callers can treat the result as always present.
 */
export async function requireSession(): Promise<Session> {
  const session = await verifySession();
  if (!session) {
    // A cookie was present but did not verify (expired, tampered with, wrong
    // pool). Send the browser through the proxy so the stale cookies get
    // cleared instead of bouncing between "/" and "/login".
    redirect(EXPIRED_SESSION_REDIRECT);
  }

  return session;
}
