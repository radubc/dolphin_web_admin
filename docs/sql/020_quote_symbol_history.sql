-- Quote symbol download history: the endpoint behind the drawer a row click opens
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 019. Re-running is safe: both inserts are guarded by ON CONFLICT
-- and nothing is deleted, altered or dropped.
--
-- Why this file exists
--   The daily quote runs have stored one admin_quotes row per symbol and
--   trading day since 008, but the page only ever showed the newest of them,
--   in the "Latest quote" column. Currency pairs got their download history
--   in 017 (click a pair, see every rate stored for it); the owner asked on
--   2026-10-04 for the same view over quotes. Clicking a row on
--   Integrations > Quote symbols now opens that symbol's history — every quote
--   stored for it, newest trading day first, with the close, the day's change,
--   open / low / high when the provider gave them, which provider served it
--   and when it was fetched. That is one more GET:
--
--     GET /api/v1/admin/integrations/quote-symbols/[id]/quotes?page=&pageSize=
--
--   Registering it here is what puts it on the Access Map and the Services
--   page and lets a non-super-admin role reach it; an endpoint with no row is
--   super-admin only.
--
--   Unlike the pair drawer there is no "Fetch 6 months" and so no second
--   endpoint: the Bank of Canada publishes a free ranged series, while a quote
--   provider charges a credit per symbol per day, so quote history arrives one
--   trading day at a time from the daily run and is never backfilled.
--
-- What this changes
--   admin_endpoints          one row: admin.integrations.quote_symbols.quotes,
--                            mirroring src/lib/admin-access/endpoint-registry.ts
--   admin_endpoint_actions   that endpoint (a read) takes can_read_integrations
--                            or can_write_integrations, the same pair 008 gave
--                            every other integrations read, named explicitly so
--                            it cannot end up with no actions at all
--
-- What this does NOT change
--   No table, column, constraint or index is created, altered or dropped. No
--   row of admin_quote_symbols or admin_quotes is touched: the endpoint only
--   reads what the runs already wrote. No action, role, page or grant is added
--   or changed.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The endpoint (key, method and path must match
--    src/lib/admin-access/endpoint-registry.ts)
--
-- `quotes` is a static segment under the existing
-- /api/v1/admin/integrations/quote-symbols/[id], the same shape as the
-- `rates` segment 017 registered under currency-pairs/[id].
-- ---------------------------------------------------------------------------
INSERT INTO admin_endpoints (key, method, path, name, description, category, auth_kind, rate_limit_policy, require_super_admin) VALUES
  ('admin.integrations.quote_symbols.quotes', 'GET', '/api/v1/admin/integrations/quote-symbols/[id]/quotes', 'Quote symbol history', 'One page of what has been downloaded for a watched symbol, newest trading day first: the close (and open, high and low when the provider gave them), the day''s change, which provider served it and when it was fetched. Read-only; the rows are written by the daily runs and by the on-demand lookup. Addressed by the watch row''s id, so a symbol that has been removed from the watch list answers 404 even though its quotes are still stored.', 'integrations', 'admin', 'api', FALSE)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Its actions: a read, so either integrations action opens it — the same
--    rule 008 gave the two watch-list reads and 017 gave the pair history.
-- ---------------------------------------------------------------------------
INSERT INTO admin_endpoint_actions (endpoint_id, action_id)
SELECT e.id, a.id FROM admin_endpoints e CROSS JOIN admin_actions a
WHERE e.key = 'admin.integrations.quote_symbols.quotes'
  AND a.key IN ('can_read_integrations', 'can_write_integrations')
ON CONFLICT (endpoint_id, action_id) DO NOTHING;

COMMIT;
