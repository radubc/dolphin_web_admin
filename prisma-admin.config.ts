// Prisma CLI config for the admin_penny_squeeze database
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma-admin/schema.prisma",
  migrations: {
    path: "prisma-admin/migrations",
  },
  datasource: {
    url: env("ADMIN_DATABASE_URL"),
  },
});
