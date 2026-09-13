-- Currency pair download history: the new endpoint behind the drawer, and the
-- clean-up of the rate rows the retired series cache left behind
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 016, and ONCE, before any pair is removed from the watch list:
-- the insert is guarded by ON CONFLICT, but the DELETE cannot tell a stray
-- series row from the history of a pair an operator has since removed (the
-- app keeps that history on Remove), so a later run would delete that too.
--
-- Why this file exists
--   Two things, both about admin_exchange_rates.
--
--   1. A new read endpoint. Clicking a row on Integrations > Currency pairs
--      now opens that pair's download history — every rate stored for it,
--      newest observation day first, with its source (boc / derived) and when
--      it was fetched. That is one more GET:
--
--        GET /api/v1/admin/integrations/currency-pairs/[id]/rates?page=&pageSize=
--
--      Registering it here is what puts it on the Access Map and the Services
--      page and lets a non-super-admin role reach it; an endpoint with no row
--      is super-admin only.
--
--   2. The stray rate rows. Until now the bank_of_canada_rates run also stored
--      **every published series** as a rate row of its own — about 27 X -> CAD
--      rows a day — so that an on-demand lookup for a pair nobody watches
--      could be derived from the database without a second provider call.
--      That worked, but it filled admin_exchange_rates with pairs that are not
--      on admin_currency_pairs and that nothing on the page or in the consumer
--      app ever reads. The owner found them there on 2026-09-12.
--
--      The application no longer writes them: the fetched document is now
--      remembered in process for the day (the memo in
--      src/lib/integrations/jobs/rates.ts), so the daily run and the on-demand
--      lookup still make one Bank of Canada call a day and still answer a
--      brand-new pair without a second one, while the database only ever sees
--      a pair that is on the watch list. Section 2 below removes what the old
--      behaviour already wrote.
--
-- What this changes
--   admin_endpoints          one row: admin.integrations.currency_pairs.rates,
--                            mirroring src/lib/admin-access/endpoint-registry.ts
--   admin_endpoint_actions   that endpoint (a read) takes can_read_integrations
--                            or can_write_integrations, the same pair 008 gave
--                            every other integrations read, named explicitly so
--                            it cannot end up with no actions at all
--   admin_exchange_rates     DELETE of every row whose (from_currency,
--                            to_currency) is not a row of admin_currency_pairs
--
-- What this does NOT change
--   No table, column, constraint or index is created, altered or dropped. No
--   action, role, page or grant is touched. The watch list itself
--   (admin_currency_pairs) is not touched: nothing is removed from it and
--   nothing is added to it. Every rate for a watched pair is kept, however old.
--
-- Before you run section 2
--   The DELETE is the only destructive statement in any file here, so it is
--   worth one minute:
--
--     -- how many rows would go, and for which pairs
--     SELECT r.from_currency, r.to_currency, count(*) AS rows,
--            min(r.date) AS oldest, max(r.date) AS newest
--       FROM admin_exchange_rates r
--      WHERE NOT EXISTS (SELECT 1 FROM admin_currency_pairs p
--                         WHERE p.from_currency = r.from_currency
--                           AND p.to_currency   = r.to_currency)
--      GROUP BY 1, 2
--      ORDER BY rows DESC;
--
--   Expect roughly (currencies published x days the run has been live) rows,
--   all with to_currency = 'CAD' and source = 'boc'. If a pair you actually
--   want to keep is in that list, the fix is to add it to the watch list first
--   (Integrations > Currency pairs > Add Pair, or an INSERT into
--   admin_currency_pairs) and then run this file: the DELETE reads the watch
--   list as it is at that moment.
--
--   A deleted row costs nothing to recreate. The pair's next fetch writes
--   today's rate again; only the older observation days for unwatched pairs
--   are gone, and no reader of this database asks for those.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The endpoint (key, method and path must match
--    src/lib/admin-access/endpoint-registry.ts)
--
-- `rates` is a static segment under the existing
-- /api/v1/admin/integrations/currency-pairs/[id], the same shape as
-- /api/v1/admin/integrations/[key]/runs.
-- ---------------------------------------------------------------------------
INSERT INTO admin_endpoints (key, method, path, name, description, category, auth_kind, rate_limit_policy, require_super_admin) VALUES
  ('admin.integrations.currency_pairs.rates', 'GET', '/api/v1/admin/integrations/currency-pairs/[id]/rates', 'Currency pair history', 'One page of what has been downloaded for a watched pair, newest observation day first: the rate, its source (read from the Bank of Canada''s own series, or derived from two of them) and when it was fetched. Read-only; the rows are written by the daily run and by the on-demand lookup. Addressed by the watch row''s id, so a pair that has been removed from the watch list answers 404.', 'integrations', 'admin', 'api', FALSE)
ON CONFLICT (key) DO NOTHING;

-- Endpoint -> actions (ANY-OF). A read on the Integrations page, so it takes
-- the same two actions 008 seeded and gave every other integrations read:
-- can_read_integrations or can_write_integrations.
--
-- Named explicitly rather than derived from admin_page_actions, for the reason
-- 013 gives: a derived insert is a no-op when the page row or its links are
-- missing, which would leave the endpoint with **zero** actions — and
-- evaluateRule() treats an endpoint with no actions and require_super_admin =
-- FALSE as reachable by any admin. Both actions come from 008, which the
-- header already requires to have run.
INSERT INTO admin_endpoint_actions (endpoint_id, action_id)
SELECT e.id, a.id FROM admin_endpoints e CROSS JOIN admin_actions a
WHERE e.key = 'admin.integrations.currency_pairs.rates'
  AND a.key IN ('can_read_integrations', 'can_write_integrations')
ON CONFLICT (endpoint_id, action_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The stray rate rows
--
-- Every admin_exchange_rates row whose (from_currency, to_currency) is not a
-- row of admin_currency_pairs. In practice these are the X -> CAD series rows
-- the retired cache wrote; the predicate is written against the watch list
-- rather than against 'to_currency = CAD' or 'source = boc' on purpose, so it
-- states the invariant the table now keeps — a rate row exists only for a
-- watched pair — instead of describing the accident that broke it.
--
-- Active or inactive makes no difference: an inactive pair is one an operator
-- switched off, its history is still true and the consumer app may still be
-- reading it from the cache. Only pairs that are not on the list at all go.
--
-- NOT EXISTS rather than NOT IN: NOT IN is a trap with NULLs, and both
-- columns are NOT NULL only because 008 says so today.
-- ---------------------------------------------------------------------------
DELETE FROM admin_exchange_rates r
 WHERE NOT EXISTS (
         SELECT 1
           FROM admin_currency_pairs p
          WHERE p.from_currency = r.from_currency
            AND p.to_currency   = r.to_currency
       );

COMMIT;
