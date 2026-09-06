import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma-admin/client";

const globalForPrismaAdmin = globalThis as unknown as {
  prismaAdmin: PrismaClient;
};

function createPrismaAdminClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.ADMIN_DATABASE_URL!,
  });
  return new PrismaClient({ adapter });
}

export const prismaAdmin =
  globalForPrismaAdmin.prismaAdmin ?? createPrismaAdminClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrismaAdmin.prismaAdmin = prismaAdmin;
}

// Use it like this:
// import { prismaAdmin } from "@/lib/prisma-admin";
