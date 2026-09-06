/**
 * GET /api/health — public liveness/readiness probe.
 *
 * Public on purpose (it is listed in `PUBLIC_API_PATHS` in `src/proxy.ts`) so a
 * load balancer or uptime monitor can call it without credentials. For that
 * reason it reveals nothing beyond up/down: no error messages, no versions.
 *
 * Unversioned: operational endpoints are not part of the `/api/v1` contract.
 *
 * The admin console reads two databases, so both are probed and reported
 * separately; either one down makes the service degraded. Because the endpoint
 * is anonymous, the probe is shared and cached briefly so a burst of callers
 * costs one round of queries, not one pool connection each.
 */
import { ServiceUnavailableError } from "@/lib/api/errors";
import { apiHandler } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { prisma } from "@/lib/prisma";
import { prismaAdmin } from "@/lib/prisma-admin";
import { RATE_LIMITS } from "@/lib/security/rate-limit";

/** A probe must fail fast: a hung connection is a failed health check. */
const DB_TIMEOUT_MS = 2000;

/** How long one probe result is reused before the databases are asked again. */
const PROBE_CACHE_MS = 5000;

interface ProbeResult {
  /** The consumer app's database (`DATABASE_URL`). */
  db: boolean;
  /** The admin database (`ADMIN_DATABASE_URL`). */
  adminDb: boolean;
}

async function probe(
  label: string,
  query: () => Promise<unknown>,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} probe timed out.`)),
      DB_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([query(), timeout]);
    return true;
  } catch (error) {
    console.error(`[api] Health check ${label} probe failed:`, error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeDatabases(): Promise<ProbeResult> {
  const [db, adminDb] = await Promise.all([
    probe("main database", () => prisma.$queryRaw`SELECT 1`),
    probe("admin database", () => prismaAdmin.$queryRaw`SELECT 1`),
  ]);
  return { db, adminDb };
}

let cachedProbe: { result: ProbeResult; expiresAt: number } | null = null;
let inFlightProbe: Promise<ProbeResult> | null = null;

/** Deduplicates concurrent probes and reuses the last verdict for a few seconds. */
async function databaseStatus(): Promise<ProbeResult> {
  const now = Date.now();
  if (cachedProbe && cachedProbe.expiresAt > now) {
    return cachedProbe.result;
  }
  if (!inFlightProbe) {
    inFlightProbe = probeDatabases()
      .then((result) => {
        cachedProbe = { result, expiresAt: Date.now() + PROBE_CACHE_MS };
        return result;
      })
      .finally(() => {
        inFlightProbe = null;
      });
  }
  return inFlightProbe;
}

const status = (reachable: boolean) => (reachable ? "ok" : "unavailable");

export const GET = apiHandler(
  async () => {
    const { db, adminDb } = await databaseStatus();
    if (!db || !adminDb) {
      throw new ServiceUnavailableError(
        "database_unavailable",
        "The service is temporarily unavailable.",
        { status: "degraded", db: status(db), adminDb: status(adminDb) },
      );
    }
    return ok({
      status: "ok",
      db: "ok",
      adminDb: "ok",
      timestamp: new Date().toISOString(),
    });
  },
  // Its own budget: the probe is anonymous and unversioned, so it must not
  // spend (or be starved by) the shared per-IP API allowance.
  { rateLimit: RATE_LIMITS.health },
);
