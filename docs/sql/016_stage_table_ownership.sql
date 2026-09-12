-- =============================================================================
-- 016 — hand the 2026-09-12 admin tables to the console role (stage fix)
--
-- Why:
--   On stage the console connects as `fairsums_console`, which owns both
--   databases, and the runbook asks for every numbered script to be run as
--   that role so new tables belong to it. 012–015 were run as
--   `fairsums_admin` (the RDS master user) instead, so the six tables they
--   created belong to `fairsums_admin` and the console gets
--   `permission denied for table admin_cost_daily` (SQLSTATE 42501) on the
--   Cost center, the Overview cards and the customer statistics.
--
-- What it does:
--   Moves ownership of exactly those six tables (indexes and constraints
--   follow the table) to `fairsums_console`. Nothing else is touched; a table
--   that is already owned by the console, or that does not exist, is skipped
--   with a NOTICE. Idempotent.
--
-- How to run in pgAdmin:
--   FairSums stage server, database `admin_penny_squeeze`, connected as
--   `fairsums_admin` (the current owner; only the owner or a superuser may
--   change ownership). Execute the whole script (F5). Not needed locally
--   when the scripts were run as `postgres`, which is also what the local
--   apps connect as.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  t TEXT;
  current_owner TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'admin_cost_daily',
    'admin_cost_snapshots',
    'admin_customer_snapshots',
    'admin_customer_events',
    'admin_pool_metrics_daily',
    'admin_tenant_cost_monthly'
  ] LOOP
    SELECT tableowner INTO current_owner
      FROM pg_tables WHERE schemaname = 'public' AND tablename = t;
    IF current_owner IS NULL THEN
      RAISE NOTICE '%: does not exist, skipped', t;
    ELSIF current_owner = 'fairsums_console' THEN
      RAISE NOTICE '%: already owned by fairsums_console', t;
    ELSE
      EXECUTE format('ALTER TABLE public.%I OWNER TO fairsums_console', t);
      RAISE NOTICE '%: owner % -> fairsums_console', t, current_owner;
    END IF;
  END LOOP;
END
$$;

COMMIT;

-- Verify (expect fairsums_console on all six):
-- SELECT tablename, tableowner FROM pg_tables
--  WHERE schemaname = 'public' AND tablename LIKE 'admin_c%' OR tablename IN ('admin_pool_metrics_daily','admin_tenant_cost_monthly')
--  ORDER BY tablename;
