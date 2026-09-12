-- Cost center, Sales and Billing, Marketing: three new main-section pages
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 011_service_defaults_endpoints.sql. Re-running is safe: the
-- insert is guarded by ON CONFLICT and nothing is created or altered.
--
-- Why this file exists
--   Owner decision, 2026-09-12: three placeholder pages join the rail.
--
--     cost_center    AWS spend, cost per client, and later Plaid and Stripe
--                     charges. The one with actual content today (two
--                     placeholder sections at /cost-center).
--     sales_billing  Subscriptions, invoices and revenue. Not built yet.
--     marketing      Campaigns and acquisition. Not built yet.
--
--   All three ship with require_super_admin = TRUE and no linked actions, the
--   same starting point every unregistered page gets by default
--   (src/lib/admin-access/page-registry.ts): visible to nobody but a
--   super-admin until the owner grants a role on the Access Map. No
--   admin_page_actions rows are inserted because none of the three names an
--   action yet.
--
--   None of the three adds an API endpoint, so admin_endpoints is untouched.
--
-- Nothing is changed or removed. Every existing page keeps its row, its
-- nav_order and its rule.

BEGIN;

-- ---------------------------------------------------------------------------
-- Seed: the three pages (keys, path and nav_order must match
-- src/lib/admin-access/page-registry.ts)
-- ---------------------------------------------------------------------------
INSERT INTO admin_pages (key, kind, path, name, description, nav_order, require_super_admin) VALUES
  ('cost_center',   'page', '/cost-center',   'Cost center',       'AWS spend, cost per client, and later Plaid and Stripe charges.', 32, TRUE),
  ('sales_billing', 'page', '/sales-billing', 'Sales and Billing', 'Subscriptions, invoices and revenue. Not built yet.',             34, TRUE),
  ('marketing',     'page', '/marketing',     'Marketing',         'Campaigns and acquisition. Not built yet.',                       36, TRUE)
ON CONFLICT (key) DO NOTHING;

COMMIT;
