# syntax=docker/dockerfile:1.10
#
# FairSums admin console — production image.
#
# Three stages: install dependencies once (cached separately from source
# changes), generate the two Prisma clients and build the Next.js app, then
# assemble a minimal runtime from `output: "standalone"` (next.config.ts).
# Built for linux/amd64 by the CI/deploy workflows
# (`docker/build-push-action` with `platforms: linux/amd64`); nothing in this
# file hardcodes an architecture.

########################################
# 1. deps — install once, reused unless package.json/package-lock.json change
########################################
FROM node:24-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

########################################
# 2. build — generate both Prisma clients, then build the Next.js app
########################################
FROM node:24-bookworm-slim AS build
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `prisma.config.ts` and `prisma-admin.config.ts` both call
# `env("DATABASE_URL")` / `env("ADMIN_DATABASE_URL")` (the `prisma/config`
# helper) at import time, and that call throws `PrismaConfigEnvError`
# immediately if the variable is unset — even though `prisma generate` itself
# never opens a database connection, only reads the schema file. Verified
# with `env -i ... npx prisma generate --config prisma.config.ts` run from a
# directory with no `.env`: it fails without a value, and succeeds once one
# is present. `.dockerignore` excludes every `.env*` file, so the build
# context never has the real values; these ARGs are harmless placeholders
# that exist only to satisfy that eager check for this one step. They are
# not used for anything else, are not present in the runtime stage below,
# and are not the same as the real `DATABASE_URL` / `ADMIN_DATABASE_URL`
# environment variables the running container reads at request time.
ARG DATABASE_URL=postgresql://build:build@localhost:5432/build
ARG ADMIN_DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV DATABASE_URL=$DATABASE_URL
ENV ADMIN_DATABASE_URL=$ADMIN_DATABASE_URL

# Baked into the build so `next.config.ts` can read it into `deploymentId`
# (version-skew protection across a rolling deployment). The deploy workflow
# passes the commit SHA in.
ARG BUILD_ID
ENV BUILD_ID=$BUILD_ID

RUN npm run prisma:generate

# ECS Express Mode canary deployments run the previous and the new build side
# by side, so every build must embed the same Server Functions encryption key
# (see the "Server Functions encryption key" section of
# node_modules/next/dist/docs/01-app/02-guides/self-hosting.md) — otherwise a
# Server Function closure encrypted by one build can't be decrypted by the
# other, and the login / forgot-password pages (both Server Actions) start
# failing with "Failed to find Server Action" during the canary window. The
# key only needs to exist for this one build step, not at runtime, so it's
# read from a BuildKit secret (never a build ARG, which would leave it
# readable in the image history) and injected as an env var for `next build`
# to pick up. If the secret is missing, Next.js silently falls back to a
# random per-build key, which is exactly the failure mode this avoids — see
# the deploy workflow's guard step for where that's caught instead.
# `required=true` makes BuildKit fail the build outright if the secret is
# missing, instead of silently omitting the mount and letting `next build`
# fall back to a random per-build key.
# Amazon's RDS certificate bundle. RDS certificates are not signed by a CA
# that Node trusts, and node-postgres 8 treats sslmode=require as full
# verification, so the runtime image ships this bundle and DATABASE_URL names
# it. Fetched here, as root, and made world-readable; the runtime stage
# copies it with the app's owner (ADD --chown/--chmod on a URL source left
# the file unreadable to the non-root user on the first deploy).
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem
RUN chmod 0644 /app/certs/rds-global-bundle.pem

RUN --mount=type=secret,id=next_actions_key,env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,required=true \
    npm run build

########################################
# 3. runtime — standalone server only; no source, no full node_modules
########################################
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# `output: "standalone"` traces only the files each route needs and writes
# them to `.next/standalone`, including a minimal `server.js` and a pruned
# `node_modules` (see the Next.js output-file-tracing docs). It deliberately
# does not include `.next/static` or `public/` — those are copied in below.
#
# `src/instrumentation.ts` is ordinary app code, not a separate process: it
# is traced and bundled into `.next/standalone/.next/server` like every other
# server file. Its `register()` hook runs once per Node process, i.e. once
# per container, when the standalone `server.js` boots — not once per
# request and not once per CPU core, since this image runs a single Node
# process. That is what starts (or, with `INTEGRATIONS_SCHEDULER=off`, does
# not start) the integration scheduler.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# Amazon's RDS certificate authorities, fetched in the build stage (see there)
# and copied in with the same owner as the rest of the app so the non-root
# process can read them. DATABASE_URL points at this path with
# sslmode=verify-full&sslrootcert=/app/certs/rds-global-bundle.pem.
COPY --from=build --chown=nextjs:nodejs /app/certs ./certs

USER nextjs

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
# With `output: "standalone"`, `server.js` is run directly with `node`
# instead of `next start`, so the `start` script's `--port 3001` never
# applies here. `server.js` reads `PORT` (and `HOSTNAME`) itself, so this is
# what actually sets the listening address.
ENV PORT=3001
EXPOSE 3001

CMD ["node", "server.js"]
