-- Admin access control for dolphin_web_admin
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- RLS is intentionally not used. Authorization is enforced in the application
-- (default deny; allow only via role → action grants, or super-admin).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- admin_users
-- Only Cognito users that exist here may sign in to the admin app.
-- cognito_sub must come from the admin-only Cognito user pool.
-- ---------------------------------------------------------------------------
CREATE TABLE admin_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cognito_sub     TEXT NOT NULL,
  email           TEXT NOT NULL,
  display_name    TEXT,
  -- Super-admin bypasses role checks and is the only principal that may
  -- grant/revoke roles and manage other admin users (enforced in app code).
  is_super_admin  BOOLEAN NOT NULL DEFAULT FALSE,
  -- Soft disable: row remains for audit; login and all checks must fail.
  disabled_at     TIMESTAMPTZ,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES admin_users (id) ON DELETE SET NULL,
  updated_by      UUID REFERENCES admin_users (id) ON DELETE SET NULL,

  CONSTRAINT admin_users_cognito_sub_key UNIQUE (cognito_sub),
  CONSTRAINT admin_users_email_key UNIQUE (email),
  CONSTRAINT admin_users_email_format_chk
    CHECK (email = lower(email) AND position('@' IN email) > 1)
);

CREATE INDEX idx_admin_users_disabled_at ON admin_users (disabled_at);
CREATE INDEX idx_admin_users_is_super_admin
  ON admin_users (is_super_admin)
  WHERE is_super_admin = TRUE AND disabled_at IS NULL;

COMMENT ON TABLE admin_users IS
  'Allowlist of operators who may authenticate to the admin app (admin Cognito pool).';
COMMENT ON COLUMN admin_users.cognito_sub IS
  'Immutable subject from the admin-only Cognito user pool.';
COMMENT ON COLUMN admin_users.is_super_admin IS
  'When true, app treats all actions as allowed and may manage roles/users.';

-- ---------------------------------------------------------------------------
-- admin_actions
-- Atomic permissions. Keys are stable API/UI identifiers (snake_case).
-- Denied by default until granted through a role.
-- ---------------------------------------------------------------------------
CREATE TABLE admin_actions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key          TEXT NOT NULL,
  description  TEXT NOT NULL,
  -- Optional grouping for UI (e.g. users, tickets, catalogs).
  category     TEXT NOT NULL DEFAULT 'general',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT admin_actions_key_key UNIQUE (key),
  CONSTRAINT admin_actions_key_format_chk
    CHECK (key ~ '^[a-z][a-z0-9_]*$')
);

CREATE INDEX idx_admin_actions_category ON admin_actions (category);

COMMENT ON TABLE admin_actions IS
  'Catalog of fine-grained admin permissions (actions).';
COMMENT ON COLUMN admin_actions.key IS
  'Stable permission id used in code, e.g. can_read_user_list.';

-- ---------------------------------------------------------------------------
-- admin_roles
-- Named bundles of actions (e.g. customer_service_agent).
-- ---------------------------------------------------------------------------
CREATE TABLE admin_roles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key          TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  -- System roles are seeded and should not be deleted by operators.
  is_system    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID REFERENCES admin_users (id) ON DELETE SET NULL,
  updated_by   UUID REFERENCES admin_users (id) ON DELETE SET NULL,

  CONSTRAINT admin_roles_key_key UNIQUE (key),
  CONSTRAINT admin_roles_key_format_chk
    CHECK (key ~ '^[a-z][a-z0-9_]*$')
);

COMMENT ON TABLE admin_roles IS
  'Roles that group admin_actions for assignment to admin_users.';

-- ---------------------------------------------------------------------------
-- admin_role_actions
-- Many-to-many: which actions a role grants.
-- ---------------------------------------------------------------------------
CREATE TABLE admin_role_actions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id     UUID NOT NULL REFERENCES admin_roles (id) ON DELETE CASCADE,
  action_id   UUID NOT NULL REFERENCES admin_actions (id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID REFERENCES admin_users (id) ON DELETE SET NULL,

  CONSTRAINT admin_role_actions_role_action_key UNIQUE (role_id, action_id)
);

CREATE INDEX idx_admin_role_actions_action_id ON admin_role_actions (action_id);

COMMENT ON TABLE admin_role_actions IS
  'Grants: role → action. Absence of a row means the action is denied for that role.';

-- ---------------------------------------------------------------------------
-- admin_user_roles
-- Many-to-many: which roles a user holds.
-- ---------------------------------------------------------------------------
CREATE TABLE admin_user_roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  role_id     UUID NOT NULL REFERENCES admin_roles (id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID REFERENCES admin_users (id) ON DELETE SET NULL,

  CONSTRAINT admin_user_roles_user_role_key UNIQUE (user_id, role_id)
);

CREATE INDEX idx_admin_user_roles_role_id ON admin_user_roles (role_id);

COMMENT ON TABLE admin_user_roles IS
  'Assignment: admin user → role. Effective permissions = union of all role actions.';

-- ---------------------------------------------------------------------------
-- admin_permission_audit_events
-- Append-only trail for membership and grant changes (app writes these).
-- ---------------------------------------------------------------------------
CREATE TABLE admin_permission_audit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id   UUID REFERENCES admin_users (id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  target_type     TEXT NOT NULL,
  target_id       UUID,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT admin_permission_audit_events_action_chk
    CHECK (action ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT admin_permission_audit_events_target_type_chk
    CHECK (target_type IN (
      'admin_user',
      'admin_role',
      'admin_action',
      'admin_user_role',
      'admin_role_action'
    ))
);

CREATE INDEX idx_admin_permission_audit_events_created_at
  ON admin_permission_audit_events (created_at DESC);
CREATE INDEX idx_admin_permission_audit_events_actor
  ON admin_permission_audit_events (actor_user_id);
CREATE INDEX idx_admin_permission_audit_events_target
  ON admin_permission_audit_events (target_type, target_id);

COMMENT ON TABLE admin_permission_audit_events IS
  'Audit log for admin user/role/action grant and revoke operations.';

-- ---------------------------------------------------------------------------
-- Seed: permission catalog (actions)
-- Expand as the admin UI grows. Keys are the contract with application code.
-- ---------------------------------------------------------------------------
INSERT INTO admin_actions (key, description, category) VALUES
  ('can_manage_admin_users', 'Create, update, disable admin users and assign roles', 'admin_access'),
  ('can_manage_roles', 'Create and edit roles and their action grants', 'admin_access'),
  ('can_read_admin_audit', 'Read admin permission audit events', 'admin_access'),

  ('can_read_user_list', 'View the end-user list from the main database', 'users'),
  ('can_read_user_detail', 'View a single end-user record', 'users'),
  ('can_write_user', 'Update end-user records in the main database', 'users'),
  ('can_disable_user', 'Disable or soft-delete an end-user', 'users'),

  ('can_read_tenant_list', 'View tenants', 'tenants'),
  ('can_read_tenant_detail', 'View a single tenant', 'tenants'),
  ('can_write_tenant', 'Create or update tenants', 'tenants'),

  ('can_access_tickets', 'Open the support tickets area', 'tickets'),
  ('can_read_tickets', 'View tickets', 'tickets'),
  ('can_write_tickets', 'Create or update tickets', 'tickets'),
  ('can_assign_tickets', 'Assign tickets to agents', 'tickets'),
  ('can_close_tickets', 'Close or resolve tickets', 'tickets'),

  ('can_read_catalogs', 'View shared catalog data in the admin database', 'catalogs'),
  ('can_write_catalogs', 'Create or update catalog / reference data', 'catalogs');

-- ---------------------------------------------------------------------------
-- Seed: example roles
-- ---------------------------------------------------------------------------
INSERT INTO admin_roles (key, name, description, is_system) VALUES
  (
    'customer_service_agent',
    'Customer service agent',
    'Read users/tenants and work support tickets; no admin-access management.',
    TRUE
  ),
  (
    'user_support_readonly',
    'User support (read-only)',
    'Read-only access to end users and tenants.',
    TRUE
  ),
  (
    'catalog_editor',
    'Catalog editor',
    'Maintain shared reference data in the admin database.',
    TRUE
  );

-- Role → action grants
INSERT INTO admin_role_actions (role_id, action_id)
SELECT r.id, a.id
FROM admin_roles r
CROSS JOIN admin_actions a
WHERE r.key = 'customer_service_agent'
  AND a.key IN (
    'can_read_user_list',
    'can_read_user_detail',
    'can_read_tenant_list',
    'can_read_tenant_detail',
    'can_access_tickets',
    'can_read_tickets',
    'can_write_tickets',
    'can_assign_tickets',
    'can_close_tickets'
  );

INSERT INTO admin_role_actions (role_id, action_id)
SELECT r.id, a.id
FROM admin_roles r
CROSS JOIN admin_actions a
WHERE r.key = 'user_support_readonly'
  AND a.key IN (
    'can_read_user_list',
    'can_read_user_detail',
    'can_read_tenant_list',
    'can_read_tenant_detail'
  );

INSERT INTO admin_role_actions (role_id, action_id)
SELECT r.id, a.id
FROM admin_roles r
CROSS JOIN admin_actions a
WHERE r.key = 'catalog_editor'
  AND a.key IN (
    'can_read_catalogs',
    'can_write_catalogs'
  );

-- ---------------------------------------------------------------------------
-- Helper view: effective permissions per user (union of role actions)
-- Super-admins are NOT expanded here; the app treats is_super_admin as all-allow.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW admin_user_effective_actions AS
SELECT DISTINCT
  u.id AS user_id,
  u.cognito_sub,
  u.email,
  a.key AS action_key,
  a.category AS action_category
FROM admin_users u
JOIN admin_user_roles ur ON ur.user_id = u.id
JOIN admin_role_actions ra ON ra.role_id = ur.role_id
JOIN admin_actions a ON a.id = ra.action_id
WHERE u.disabled_at IS NULL;

COMMENT ON VIEW admin_user_effective_actions IS
  'Effective action keys for enabled admin users via their roles (excludes super-admin bypass).';

COMMIT;
