-- Service endpoints: the defaults the consumer app pulls at tenant creation
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 010_customers.sql. Re-running is safe: the insert is guarded by
-- ON CONFLICT and nothing is created or altered.
--
-- Why this file exists
--   Owner decision, 2026-09-11: the default categories and the default
--   financial institutions are no longer pushed into the main app database.
--   The consumer web app PULLS them from this console over HTTP when it
--   creates a tenant and copies them into that tenant's own rows, so the
--   admin catalog (the Constants page) is the single source of these
--   defaults. Two new machine endpoints serve them:
--
--     GET /api/v1/service/defaults/categories
--     GET /api/v1/service/defaults/financial-institutions
--
--   Both authenticate with an API_KEYS entry (x-api-key), the same way the
--   quote and exchange-rate lookups do, so auth_kind is 'service' and the
--   access map rule is NOT applied to them — they get no admin_endpoint_actions
--   rows on purpose. Registering them here is what puts them on the Services
--   page with their usage counters; the endpoints themselves work without this
--   file (usage is keyed by endpoint key, not by id, and a service endpoint
--   consults no rule).
--
--   Nothing is removed. The push and compare endpoints keep their rows and
--   keep working for the other eight catalogs; they answer 409 conflict for
--   these two kinds, which is application logic (PULLED_KINDS in
--   src/lib/constants/types.ts), not a database rule.

BEGIN;

-- ---------------------------------------------------------------------------
-- Seed: endpoints (keys, methods and paths must match
-- src/lib/admin-access/endpoint-registry.ts)
-- ---------------------------------------------------------------------------
INSERT INTO admin_endpoints (key, method, path, name, description, category, auth_kind, rate_limit_policy, require_super_admin) VALUES
  ('service.defaults.categories',              'GET', '/api/v1/service/defaults/categories',              'Default categories',             'Machine clients (API_KEYS): every live default category, for the consumer app to copy into a tenant it is creating. A missing or empty catalog is a 503, never an empty list.',        'catalogs', 'service', 'service', FALSE),
  ('service.defaults.financial_institutions',  'GET', '/api/v1/service/defaults/financial-institutions',  'Default financial institutions',  'Machine clients (API_KEYS): the default financial institutions, for the consumer app to copy into a tenant it is creating. A missing or empty catalog is a 503, never an empty list.', 'catalogs', 'service', 'service', FALSE)
ON CONFLICT (key) DO NOTHING;

COMMIT;
