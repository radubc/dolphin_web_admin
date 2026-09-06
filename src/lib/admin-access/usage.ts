import "server-only";
/**
 * Fire-and-forget usage counting for the Services page.
 *
 * `apiHandler` calls `recordEndpointUsage` after every response when the
 * route declared an `endpoint` key. It must never slow down or fail a request,
 * so it is not awaited by the caller and every failure is swallowed after one
 * log line per process (the usual cause is the SQL in `docs/sql/` not having
 * been run yet).
 */
import { getAdminAccessRepository } from "./repository";
import type { UsageHit } from "./types";

let warned = false;

export function recordEndpointUsage(hit: UsageHit): void {
  void getAdminAccessRepository()
    .recordUsage(hit)
    .catch((error: unknown) => {
      if (warned) return;
      warned = true;
      console.error(
        "[usage] Could not record endpoint usage; is docs/sql/002 applied? Logged once per process.",
        error,
      );
    });
}
