import type { Metadata } from "next";
import UserManagementPage from "@/components/user-management/user-management-page";
import { requireAdminSession } from "@/lib/admin-access/authorize";
import { capabilitiesOf } from "@/lib/admin-access/types";

export const metadata: Metadata = {
  title: "User Management · Penny Squeeze Admin",
};

/**
 * The User Management route.
 *
 * A Server Component that verifies the session and the allowlist, then hands
 * the caller's capabilities to the client page. The page decides which views
 * and controls to draw from them; every write is re-checked by the API.
 */
export default async function Page() {
  const { principal } = await requireAdminSession();

  return <UserManagementPage capabilities={capabilitiesOf(principal)} />;
}
