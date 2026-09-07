-- Constants: sync ledger, jobs, and the compare / jobs endpoints
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 006_account_types_unique_index.sql. Re-running is safe: tables
-- and indexes are created IF NOT EXISTS, inserts are guarded by ON CONFLICT.
--
-- Why this file exists
--   The market-data catalogs (stocks, ETFs, cryptocurrencies) will hold about
--   300,000 rows. Until now the Constants page compared every row against the
--   main app database on every page load and pushed a whole catalog in one
--   transaction. Neither survives that size. From this file on:
--
--   * admin_constant_sync is a ledger: one row per (kind, id) with the state
--     the last compare or push found — new, changed, synced — plus main_only
--     rows for ids the main database has and the admin catalog does not. The
--     list endpoint reads states and counts from here instead of comparing.
--     Create / update / delete on the Constants page keep their own row's
--     entry current; a "Compare" job rebuilds the whole kind.
--
--   * admin_constant_jobs records every compare and push: what was asked,
--     progress, counters, outcome. Jobs run inside the app process in batches
--     (each batch its own transaction); the row is how the page follows them
--     and how an interrupted job (process restarted) is recognised — a
--     running job whose heartbeat_at is stale.
--
-- What this adds
--   admin_constant_sync       the ledger
--   admin_constant_jobs       job records
--   admin_endpoints           three rows: compare, jobs.list, jobs.get,
--                             mirroring src/lib/admin-access/endpoint-registry.ts
--   admin_endpoint_actions    can_write_catalogs for compare; either catalog
--                             action for reading jobs
--
-- Nothing is changed or removed. The catalog tables themselves are untouched.

BEGIN;

-- ---------------------------------------------------------------------------
-- admin_constant_sync
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_constant_sync (
  kind         TEXT NOT NULL,
  -- The catalog row's primary key as text (UUID or integer), so one table
  -- serves every kind.
  row_id       TEXT NOT NULL,
  state        TEXT NOT NULL,
  compared_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT admin_constant_sync_pkey PRIMARY KEY (kind, row_id),
  CONSTRAINT admin_constant_sync_state_chk
    CHECK (state IN ('new', 'changed', 'synced', 'main_only'))
);

CREATE INDEX IF NOT EXISTS idx_admin_constant_sync_kind_state
  ON admin_constant_sync (kind, state);

COMMENT ON TABLE admin_constant_sync IS
  'Constants sync ledger: how each admin catalog row relates to the main app database, as of the last compare or push. main_only rows are ids the main database has and the admin catalog does not.';

-- ---------------------------------------------------------------------------
-- admin_constant_jobs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_constant_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             TEXT NOT NULL,
  type             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued',
  -- Rows the job set out to process; NULL until counted.
  total            INTEGER,
  processed        INTEGER NOT NULL DEFAULT 0,
  -- Push counters.
  created          INTEGER NOT NULL DEFAULT 0,
  updated          INTEGER NOT NULL DEFAULT 0,
  unchanged        INTEGER NOT NULL DEFAULT 0,
  -- Push: rows of other kinds written first so foreign keys hold.
  dependency_rows  INTEGER NOT NULL DEFAULT 0,
  -- Compare: ids found only in the main database.
  main_only        INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  -- The push request as received (ids or scope), for the record.
  request          JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by     UUID REFERENCES admin_users (id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  -- Touched after every batch while running; stale = interrupted.
  heartbeat_at     TIMESTAMPTZ,

  CONSTRAINT admin_constant_jobs_type_chk   CHECK (type IN ('compare', 'push')),
  CONSTRAINT admin_constant_jobs_status_chk CHECK (status IN ('queued', 'running', 'succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_admin_constant_jobs_kind_created_at
  ON admin_constant_jobs (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_constant_jobs_status
  ON admin_constant_jobs (status);

COMMENT ON TABLE admin_constant_jobs IS
  'Constants compare and push jobs: request, progress, counters, outcome. A running job with a stale heartbeat_at was interrupted by a process restart; rerun it.';

-- ---------------------------------------------------------------------------
-- Seed: the three new endpoints (keys and paths must match the registry)
-- ---------------------------------------------------------------------------
INSERT INTO admin_endpoints (key, method, path, name, description, category, auth_kind, rate_limit_policy, require_super_admin) VALUES
  ('admin.constants.compare',  'POST', '/api/v1/admin/constants/[kind]/compare',       'Compare constants', 'Starts a job that compares one catalog with the main app database and rebuilds its sync ledger (new / changed / synced / main-only). Small catalogs finish before the response.', 'catalogs', 'admin', 'api', FALSE),
  ('admin.constants.jobs.list','GET',  '/api/v1/admin/constants/[kind]/jobs',          'List constant jobs', 'Recent compare and push jobs for one catalog, newest first, with progress and counters.',                                                                                   'catalogs', 'admin', 'api', FALSE),
  ('admin.constants.jobs.get', 'GET',  '/api/v1/admin/constants/[kind]/jobs/[jobId]',  'Get constant job',   'One compare or push job by id, for polling progress.',                                                                                                                       'catalogs', 'admin', 'api', FALSE)
ON CONFLICT (key) DO NOTHING;

INSERT INTO admin_endpoint_actions (endpoint_id, action_id)
SELECT e.id, a.id FROM admin_endpoints e CROSS JOIN admin_actions a
WHERE (e.key IN ('admin.constants.jobs.list', 'admin.constants.jobs.get')
         AND a.key IN ('can_read_catalogs', 'can_write_catalogs'))
   OR (e.key = 'admin.constants.compare' AND a.key = 'can_write_catalogs')
ON CONFLICT (endpoint_id, action_id) DO NOTHING;

COMMIT;
