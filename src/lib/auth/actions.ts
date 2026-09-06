"use server";

import { redirect } from "next/navigation";
import { clearSession } from "./session";

/**
 * Signs the user out of this browser and sends them back to the login page.
 *
 * The JS-free fallback, kept for any form that cannot post straight to the
 * logout route. The sign-out control on a page posts to `/api/auth/logout`
 * instead (see `src/app/page.tsx`), and that is the path that *revokes* the
 * refresh token: this action runs on a POST to a page, where the `/api/auth`-
 * scoped refresh cookie is not sent, so it has no token to hand to Cognito.
 *
 * Deleting a cookie is not subject to that scoping, though — a `Set-Cookie`
 * with `Path=/api/auth` and an expired date is honoured by the browser whatever
 * path the response came from — so all five cookies do go away here. The
 * refresh token simply stays valid at Cognito until it expires on its own.
 */
export async function logout(): Promise<void> {
  await clearSession();
  redirect("/login");
}
