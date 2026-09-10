import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

// Shared with `src/lib/prisma-admin.ts`: one pool-size knob for both
// databases is enough at this scale, and it keeps the container's total
// connection count predictable (`DATABASE_POOL_MAX` * 2 clients). Default is
// 10, pg's own default; existing deployments keep that behaviour unless the
// environment says otherwise.
function poolMax(): number {
  const raw = process.env.DATABASE_POOL_MAX?.trim();
  if (!raw) return 10;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.warn(`[prisma] ignoring DATABASE_POOL_MAX="${raw}"; using 10.`);
    return 10;
  }
  return parsed;
}

function createPrismaClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
    max: poolMax(),
    // A client idle this long is released back to Postgres rather than held.
    idleTimeoutMillis: 30000,
    // No connectionTimeoutMillis: keep pg's default of waiting for a free
    // connection rather than failing the request.
  });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Use it like this: 
// import { prisma } from "@/lib/prisma";