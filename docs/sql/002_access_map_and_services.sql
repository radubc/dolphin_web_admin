-- Access map and service registry for dolphin_web_admin
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 001_admin_access.sql. Safe to run once; re-running fails on the
-- CREATE TABLE statements by design so nothing is silently recreated.
--
-- What this adds
--   admin_pages            every page and quick action of the console, with
--                          the rule that gates it (any of the linked actions,
--                          or super-admin only, or open to every operator)
--   admin_page_actions     page -> required action (ANY-OF semantics)
--   admin_endpoints        every API endpoint, with its rule and its metadata
--   admin_endpoint_actions endpoint -> required action (ANY-OF semantics)
--   admin_endpoint_usage   one row per endpoint per day: calls, errors, timing
--   two new actions        can_manage_access_map, can_read_services
--
-- How a rule is read (enforced in application code, see docs/access-control.md)
--   1. Caller must be an enabled admin_users row (the allowlist). Always.
--   2. Super-admins pass every rule.
--   3. is_enabled = FALSE hides a page / returns 503 for an endpoint.
--   4. require_super_admin = TRUE: only super-admins.
--   5. Otherwise the caller must hold at least ONE of the linked actions.
--      No linked actions at all means "any enabled operator".
--   A page or endpoint the code knows about but that has no row here is
--   treated as super-admin only until it is registered (the Access Map page
--   offers a Register button).

BEGIN;

-- ---------------------------------------------------------------------------
-- New actions in the catalog
-- ---------------------------------------------------------------------------
INSERT INTO admin_actions (key, description, category) VALUES
  ('can_manage_access_map', 'Open the Access Map and see which actions gate each page and endpoint', 'admin_access'),
  ('can_read_services', 'Open the Services page: endpoint catalog, limits and usage', 'admin_access')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- admin_pages
-- kind = 'page' rows are rail tabs and routes; kind = 'quick_action' rows are
-- entries behind the "New" button. Icons and colours stay in code, keyed by
-- `key`; everything that decides *who* may open it lives here.
-- ---------------------------------------------------------------------------
CREATE TABLE admin_pages (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key                  TEXT NOT NULL,
  kind                 TEXT NOT NULL DEFAULT 'page',
  -- Route for pages ('/user-management'); NULL for quick actions.
  path                 TEXT,
  name                 TEXT NOT NULL,
  description          TEXT,
  -- Order on the rail / in the New popover, ascending.
  nav_order            INTEGER NOT NULL DEFAULT 100,
  is_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  require_super_admin  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by           UUID REFERENCES admin_users (id) ON DELETE SET NULL,

  CONSTRAINT admin_pages_key_key UNIQUE (key),
  CONSTRAINT admin_pages_key_format_chk CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT admin_pages_kind_chk CHECK (kind IN ('page', 'quick_action'))
);

CREATE INDEX idx_admin_pages_kind_nav_order ON admin_pages (kind, nav_order);

COMMENT ON TABLE admin_pages IS
  'Access map: every page and quick action of the admin console and the rule that gates it.';
COMMENT ON COLUMN admin_pages.require_super_admin IS
  'When true only super-admins may open it, whatever actions are linked.';

CREATE TABLE admin_page_actions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id     UUID NOT NULL REFERENCES admin_pages (id) ON DELETE CASCADE,
  action_id   UUID NOT NULL REFERENCES admin_actions (id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT admin_page_actions_page_action_key UNIQUE (page_id, action_id)
);

CREATE INDEX idx_admin_page_actions_action_id ON admin_page_actions (action_id);

COMMENT ON TABLE admin_page_actions IS
  'Page -> required action. A caller needs ANY ONE of a page''s actions. No rows = any operator.';

-- ---------------------------------------------------------------------------
-- admin_endpoints
-- One row per Route Handler export (method + path). `key` is what the code
-- declares: apiHandler(..., { endpoint: 'admin.users.list' }).
-- auth_kind: 'public' (no credential), 'session' (any signed-in Cognito user of
-- the admin pool), 'admin' (allowlist + this rule).
-- ---------------------------------------------------------------------------
CREATE TABLE admin_endpoints (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key                  TEXT NOT NULL,
  method               TEXT NOT NULL,
  path                 TEXT NOT NULL,
  name                 TEXT NOT NULL,
  description          TEXT,
  category             TEXT NOT NULL DEFAULT 'general',
  auth_kind            TEXT NOT NULL DEFAULT 'admin',
  -- Name of a RATE_LIMITS preset in code (api, authLogin, health, ...).
  rate_limit_policy    TEXT NOT NULL DEFAULT 'api',
  require_super_admin  BOOLEAN NOT NULL DEFAULT FALSE,
  is_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  -- Free text for operators: caveats, owners, links.
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by           UUID REFERENCES admin_users (id) ON DELETE SET NULL,

  CONSTRAINT admin_endpoints_key_key UNIQUE (key),
  CONSTRAINT admin_endpoints_method_path_key UNIQUE (method, path),
  CONSTRAINT admin_endpoints_key_format_chk CHECK (key ~ '^[a-z][a-z0-9_.]*$'),
  CONSTRAINT admin_endpoints_method_chk
    CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  CONSTRAINT admin_endpoints_auth_kind_chk
    CHECK (auth_kind IN ('public', 'session', 'admin'))
);

CREATE INDEX idx_admin_endpoints_category ON admin_endpoints (category);

COMMENT ON TABLE admin_endpoints IS
  'Service registry: every API endpoint, its metadata, and the rule that gates it.';

CREATE TABLE admin_endpoint_actions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id  UUID NOT NULL REFERENCES admin_endpoints (id) ON DELETE CASCADE,
  action_id    UUID NOT NULL REFERENCES admin_actions (id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT admin_endpoint_actions_endpoint_action_key UNIQUE (endpoint_id, action_id)
);

CREATE INDEX idx_admin_endpoint_actions_action_id ON admin_endpoint_actions (action_id);

COMMENT ON TABLE admin_endpoint_actions IS
  'Endpoint -> required action. ANY ONE of them suffices. No rows = any operator (for auth_kind admin).';

-- ---------------------------------------------------------------------------
-- admin_endpoint_usage
-- Written by the handler wrapper on every call, one row per endpoint per UTC
-- day. Keyed by endpoint key (not id) so calls to an endpoint that is not yet
-- registered are still counted.
-- ---------------------------------------------------------------------------
CREATE TABLE admin_endpoint_usage (
  endpoint_key       TEXT NOT NULL,
  day                DATE NOT NULL,
  calls              BIGINT NOT NULL DEFAULT 0,
  -- 5xx responses
  errors             BIGINT NOT NULL DEFAULT 0,
  -- 401 / 403 responses
  denied             BIGINT NOT NULL DEFAULT 0,
  -- 429 responses
  rate_limited       BIGINT NOT NULL DEFAULT 0,
  total_duration_ms  BIGINT NOT NULL DEFAULT 0,
  last_called_at     TIMESTAMPTZ,

  CONSTRAINT admin_endpoint_usage_pkey PRIMARY KEY (endpoint_key, day)
);

CREATE INDEX idx_admin_endpoint_usage_day ON admin_endpoint_usage (day DESC);

COMMENT ON TABLE admin_endpoint_usage IS
  'Per-endpoint daily counters for the Services page. Best effort; written fire-and-forget.';

-- ---------------------------------------------------------------------------
-- Audit trail: allow the two new target types
-- ---------------------------------------------------------------------------
ALTER TABLE admin_permission_audit_events
  DROP CONSTRAINT admin_permission_audit_events_target_type_chk;
ALTER TABLE admin_permission_audit_events
  ADD CONSTRAINT admin_permission_audit_events_target_type_chk
    CHECK (target_type IN (
      'admin_user',
      'admin_role',
      'admin_action',
      'admin_user_role',
      'admin_role_action',
      'admin_page',
      'admin_endpoint'
    ));

-- ---------------------------------------------------------------------------
-- Seed: pages and quick actions (keys are the contract with code)
-- ---------------------------------------------------------------------------
INSERT INTO admin_pages (key, kind, path, name, description, nav_order, require_super_admin) VALUES
  ('overview',        'page', '/',                'Overview',        'Landing page after sign-in.',                                   10, FALSE),
  ('constants',       'page', '/constants',       'Constants',       'Reference data shared by every tenant.',                        20, FALSE),
  ('user_management', 'page', '/user-management', 'User Management', 'Operators, roles, grants and the audit trail.',                 30, FALSE),
  ('support',         'page', '/support',         'Support',         'Support tickets and the help desk.',                            40, FALSE),
  ('access_map',      'page', '/access-map',      'Access Map',      'Which actions gate each page, quick action and API endpoint.',  50, FALSE),
  ('services',        'page', '/services',        'Services',        'API endpoint catalog: purpose, limits and usage.',              60, FALSE),
  ('invite_user',     'quick_action', NULL,       'Invite user',     'Add an operator to the admin pool.',                            10, TRUE);

-- Page -> actions (ANY-OF). Overview and Support have no rows: any operator.
INSERT INTO admin_page_actions (page_id, action_id)
SELECT p.id, a.id FROM admin_pages p CROSS JOIN admin_actions a
WHERE (p.key = 'constants'       AND a.key IN ('can_read_catalogs', 'can_write_catalogs'))
   OR (p.key = 'user_management' AND a.key IN ('can_manage_admin_users', 'can_manage_roles', 'can_read_admin_audit'))
   OR (p.key = 'support'         AND a.key IN ('can_access_tickets'))
   OR (p.key = 'access_map'      AND a.key IN ('can_manage_access_map'))
   OR (p.key = 'services'        AND a.key IN ('can_read_services'));

-- ---------------------------------------------------------------------------
-- Seed: endpoints. Metadata mirrors src/lib/admin-access/endpoint-registry.ts;
-- the rule columns and the action links are yours to change afterwards.
-- ---------------------------------------------------------------------------
INSERT INTO admin_endpoints (key, method, path, name, description, category, auth_kind, rate_limit_policy, require_super_admin) VALUES
  ('health',                 'GET',    '/api/health',                    'Health probe',                 'Liveness and readiness: probes the main and admin databases. Public and unversioned so a load balancer can call it.',            'operations',     'public',  'health',      FALSE),
  ('auth.refresh.post',      'POST',   '/api/auth/refresh',              'Refresh session (fetch)',      'Exchanges the refresh-token cookie for a new id/access token pair. Called by apiFetch on token_expired.',                      'authentication', 'public',  'authRefresh', FALSE),
  ('auth.refresh.get',       'GET',    '/api/auth/refresh',              'Refresh session (navigation)', 'Same exchange for a browser navigation; the proxy sends an expired page session here and it redirects back.',                'authentication', 'public',  'authRefresh', FALSE),
  ('auth.logout.post',       'POST',   '/api/auth/logout',               'Sign out (form or fetch)',     'Revokes the refresh token at Cognito and clears every session cookie. A form POST gets a 303 to /login, a fetch gets 204.',  'authentication', 'public',  'authRefresh', FALSE),
  ('auth.logout.get',        'GET',    '/api/auth/logout',               'Sign out (navigation)',        'Sign-out for a typed URL or bookmark. Same effect as the POST, always redirects to /login.',                                'authentication', 'public',  'authRefresh', FALSE),
  ('me',                     'GET',    '/api/v1/me',                     'Session identity',             'The signed-in Cognito identity from the id token: user id, email, name. Does not consult the allowlist.',                   'session',        'session', 'api',         FALSE),
  ('admin.me',               'GET',    '/api/v1/admin/me',               'Operator capabilities',        'The caller''s allowlist row, super-admin flag and effective actions. The UI uses it to decide which controls to draw.',      'admin_access',   'admin',   'api',         FALSE),
  ('admin.users.list',       'GET',    '/api/v1/admin/users',            'List admin users',             'Every operator on the allowlist, enabled or disabled, with their role keys.',                                                'admin_access',   'admin',   'api',         FALSE),
  ('admin.users.create',     'POST',   '/api/v1/admin/users',            'Invite admin user',            'Adds an operator: email, display name, roles, super-admin flag. Writes an audit event.',                                     'admin_access',   'admin',   'api',         TRUE),
  ('admin.users.get',        'GET',    '/api/v1/admin/users/[id]',       'Get admin user',               'One operator by id.',                                                                                                        'admin_access',   'admin',   'api',         FALSE),
  ('admin.users.update',     'PATCH',  '/api/v1/admin/users/[id]',       'Update admin user',            'Display name, roles, super-admin flag, disable/enable. Refuses self-lockout and removing the last super-admin.',              'admin_access',   'admin',   'api',         TRUE),
  ('admin.roles.list',       'GET',    '/api/v1/admin/roles',            'List roles',                   'The role catalog with each role''s action grants and member count.',                                                          'admin_access',   'admin',   'api',         FALSE),
  ('admin.roles.create',     'POST',   '/api/v1/admin/roles',            'Create role',                  'A new role with its key, name, description and action grants.',                                                              'admin_access',   'admin',   'api',         TRUE),
  ('admin.roles.get',        'GET',    '/api/v1/admin/roles/[id]',       'Get role',                     'One role by id.',                                                                                                            'admin_access',   'admin',   'api',         FALSE),
  ('admin.roles.update',     'PATCH',  '/api/v1/admin/roles/[id]',       'Update role',                  'Name, description and action grants. Grants and revocations are audited individually.',                                      'admin_access',   'admin',   'api',         TRUE),
  ('admin.roles.delete',     'DELETE', '/api/v1/admin/roles/[id]',       'Delete role',                  'Removes a non-system role that no enabled user holds.',                                                                      'admin_access',   'admin',   'api',         TRUE),
  ('admin.actions.list',     'GET',    '/api/v1/admin/actions',          'List actions',                 'The permission catalog (admin_actions).',                                                                                    'admin_access',   'admin',   'api',         FALSE),
  ('admin.audit.list',       'GET',    '/api/v1/admin/audit',            'List audit events',            'Membership and grant changes, newest first, cursor-paged.',                                                                  'admin_access',   'admin',   'api',         FALSE),
  ('admin.pages.list',       'GET',    '/api/v1/admin/pages',            'List page rules',              'The access map for pages and quick actions, merged with what the code knows so unregistered items are visible.',            'access_map',     'admin',   'api',         FALSE),
  ('admin.pages.upsert',     'PUT',    '/api/v1/admin/pages/[key]',      'Save page rule',               'Registers or updates one page/quick action rule: required actions, super-admin only, enabled, order.',                      'access_map',     'admin',   'api',         TRUE),
  ('admin.endpoints.list',   'GET',    '/api/v1/admin/endpoints',        'List endpoint rules',          'The service registry merged with the code''s endpoint catalog: metadata, rule, rate-limit preset.',                          'access_map',     'admin',   'api',         FALSE),
  ('admin.endpoints.upsert', 'PUT',    '/api/v1/admin/endpoints/[key]',  'Save endpoint rule',           'Registers or updates one endpoint rule: required actions, super-admin only, enabled, notes.',                                'access_map',     'admin',   'api',         TRUE),
  ('admin.usage.list',       'GET',    '/api/v1/admin/usage',            'Endpoint usage',               'Daily call counters per endpoint for the Services page: calls, errors, denials, rate limits, timing.',                       'access_map',     'admin',   'api',         FALSE);

-- Endpoint -> actions (ANY-OF). Rows with require_super_admin = TRUE need none.
INSERT INTO admin_endpoint_actions (endpoint_id, action_id)
SELECT e.id, a.id FROM admin_endpoints e CROSS JOIN admin_actions a
WHERE (e.key IN ('admin.users.list', 'admin.users.get')          AND a.key = 'can_manage_admin_users')
   OR (e.key IN ('admin.roles.list', 'admin.roles.get')          AND a.key = 'can_manage_roles')
   OR (e.key = 'admin.actions.list'                              AND a.key IN ('can_manage_roles', 'can_manage_access_map'))
   OR (e.key = 'admin.audit.list'                                AND a.key = 'can_read_admin_audit')
   OR (e.key = 'admin.pages.list'                                AND a.key = 'can_manage_access_map')
   OR (e.key = 'admin.endpoints.list'                            AND a.key IN ('can_manage_access_map', 'can_read_services'))
   OR (e.key = 'admin.usage.list'                                AND a.key = 'can_read_services');

COMMIT;
