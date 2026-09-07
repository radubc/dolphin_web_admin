-- Constants: register the catalog endpoints and allow catalog audit events
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 003_bootstrap_owner.sql. Re-running is safe: every insert is
-- guarded by ON CONFLICT, and the check constraint is dropped IF EXISTS before
-- being re-added.
--
-- Why this file exists
--   The Constants page edits four reference catalogs that the admin database
--   masters — countries, currencies, financial_institutions, categories — and
--   pushes them into the main app database (DATABASE_URL) that the consumer
--   app reads. The push upserts by id and never deletes over there, because a
--   row in the main database may be referenced by tenant data.
--
--   No table is created or altered here for the catalogs themselves: they
--   already exist in this database. What is missing is (1) the access-map rows
--   for the six new API endpoints, without which they are super-admin only,
--   and (2) permission for the audit trail to record a push.
--
-- What this adds
--   admin_endpoints           six rows: list / get / create / update / delete
--                             / push, mirroring
--                             src/lib/admin-access/endpoint-registry.ts
--   admin_endpoint_actions    their ANY-OF action links: can_read_catalogs or
--                             can_write_catalogs to read, can_write_catalogs
--                             to change or push
--   audit check constraint    target_type may now also be 'catalog', so a push
--                             can write one admin_permission_audit_events row
--                             (action = 'constants_push', target_id = NULL)
--
-- The two actions themselves (can_read_catalogs, can_write_catalogs) were
-- seeded by 001_admin_access.sql; nothing new is needed in admin_actions.

BEGIN;

-- ---------------------------------------------------------------------------
-- Audit trail: allow 'catalog' as a target type
-- The full list from 002 plus the new value. Dropping first keeps the file
-- re-runnable; the constraint is recreated in the same transaction, so the
-- table is never left unguarded.
-- ---------------------------------------------------------------------------
ALTER TABLE admin_permission_audit_events
  DROP CONSTRAINT IF EXISTS admin_permission_audit_events_target_type_chk;
ALTER TABLE admin_permission_audit_events
  ADD CONSTRAINT admin_permission_audit_events_target_type_chk
    CHECK (target_type IN (
      'admin_user',
      'admin_role',
      'admin_action',
      'admin_user_role',
      'admin_role_action',
      'admin_page',
      'admin_endpoint',
      -- A whole reference catalog: written once per successful push, with the
      -- kind and the created / updated / unchanged counts in metadata.
      'catalog'
    ));

-- ---------------------------------------------------------------------------
-- Seed: the Constants endpoints
-- Keys, methods and paths must match endpoint-registry.ts exactly — the key is
-- what each Route Handler declares in adminHandler(..., { endpoint: '…' }),
-- and the path is spelled the way Next spells it, with [kind] and [id].
-- The rule columns are yours to change afterwards on the Access Map.
-- ---------------------------------------------------------------------------
INSERT INTO admin_endpoints (key, method, path, name, description, category, auth_kind, rate_limit_policy, require_super_admin) VALUES
  ('admin.constants.list',   'GET',    '/api/v1/admin/constants/[kind]',      'List constants',   'One reference catalog (countries, currencies, financial institutions, categories) from the admin database, each row labelled new / changed / synced against the main app database.',              'catalogs', 'admin', 'api', FALSE),
  ('admin.constants.create', 'POST',   '/api/v1/admin/constants/[kind]',      'Create constant',  'Adds a row to a reference catalog in the admin database. Nothing reaches the main app database until a push.',                                                                                  'catalogs', 'admin', 'api', FALSE),
  ('admin.constants.get',    'GET',    '/api/v1/admin/constants/[kind]/[id]', 'Get constant',     'One catalog row by id, with its push state against the main app database.',                                                                                                                   'catalogs', 'admin', 'api', FALSE),
  ('admin.constants.update', 'PATCH',  '/api/v1/admin/constants/[kind]/[id]', 'Update constant',  'Partial edit of one catalog row in the admin database. The main app database is unaffected until a push.',                                                                                   'catalogs', 'admin', 'api', FALSE),
  ('admin.constants.delete', 'DELETE', '/api/v1/admin/constants/[kind]/[id]', 'Delete constant',  'Retires a category (deleted_at) or removes a country, currency or institution from the admin catalog. Never deletes anything from the main app database.',                                     'catalogs', 'admin', 'api', FALSE),
  ('admin.constants.push',   'POST',   '/api/v1/admin/constants/[kind]/push', 'Push constants',   'Upserts the selected rows (or the whole catalog) into the main app database by id, dependencies first. It never deletes there: rows are referenced by tenant data.',                          'catalogs', 'admin', 'api', FALSE)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Endpoint -> actions (ANY-OF: one of the linked actions is enough).
-- Reading a catalog is open to either catalog action; changing one or pushing
-- it into the main app database needs can_write_catalogs.
-- ---------------------------------------------------------------------------
INSERT INTO admin_endpoint_actions (endpoint_id, action_id)
SELECT e.id, a.id FROM admin_endpoints e CROSS JOIN admin_actions a
WHERE (e.key IN ('admin.constants.list', 'admin.constants.get')
         AND a.key IN ('can_read_catalogs', 'can_write_catalogs'))
   OR (e.key IN ('admin.constants.create', 'admin.constants.update',
                 'admin.constants.delete', 'admin.constants.push')
         AND a.key = 'can_write_catalogs')
ON CONFLICT (endpoint_id, action_id) DO NOTHING;

COMMIT;
