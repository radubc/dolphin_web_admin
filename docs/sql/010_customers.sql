-- Customers: invitations to the consumer app
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 009_markets_and_alpha_vantage.sql. Re-running is safe: the table
-- and its indexes are created IF NOT EXISTS, every insert is guarded by
-- ON CONFLICT, and the one constraint that is replaced is dropped IF EXISTS
-- first, inside the same transaction.
--
-- Why this file exists
--   The consumer app has no self-service sign-up. A person gets in because an
--   operator created their Cognito account and Cognito emailed them a
--   temporary password; the `users` row in the MAIN app database only appears
--   afterwards, the first time they sign in. So "who has been invited" is a
--   fact only this console knows, and it has nowhere to live.
--
--   * admin_customer_invites is that record: one row per invitation, written
--     BEFORE Cognito is called and never deleted. A refused create stays as
--     'failed' with the reason; a withdrawn one stays as 'revoked'; and when a
--     `users` row with the account's sub turns up, the app flips the row to
--     'accepted'. Nothing here is ever written to the main app database — the
--     admin app only reads that one.
--
--   The Cognito account itself lives in the CUSTOMER user pool (the consumer
--   app's pool, CUSTOMER_COGNITO_USER_POOL_ID), never the admin pool. A
--   temporary password is never seen by this app and is not stored anywhere.
--
-- What this adds
--   admin_customer_invites    the invitation records, with a partial unique
--                             index that allows only one OPEN invitation per
--                             address
--   admin_actions             one row: can_invite_users
--   admin_pages               the `customers` page (nav_order 25) and the
--                             `invite_customer` quick action, plus their
--                             action links
--   admin_endpoints           the six Customers endpoints, mirroring
--                             src/lib/admin-access/endpoint-registry.ts
--   admin_endpoint_actions    reads: any of can_read_user_list,
--                             can_read_user_detail, can_invite_users;
--                             the three invite writes: can_invite_users
--   audit check constraint    target_type may now also be 'customer_invite',
--                             so creating, resending and revoking an
--                             invitation each write one
--                             admin_permission_audit_events row
--
-- Nothing is changed or removed. The `users`, `user_tenants` and `tenants`
-- tables the Customers page reads live in the main app database and are not
-- touched by this file or by the feature.

BEGIN;

-- ---------------------------------------------------------------------------
-- admin_customer_invites
-- One row per invitation. `status` is a plain TEXT with a CHECK rather than an
-- enum, matching every other status column in this schema (an enum would make
-- adding a state a type change in two databases).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_customer_invites (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored lowercased by the app; the unique index lowercases anyway.
  email            TEXT NOT NULL,
  -- The username the pool account was created with (the email address).
  cognito_username TEXT NOT NULL,
  -- The account's `sub`, once Cognito answered. NULL when the create failed;
  -- this is what a `users` row is matched on to detect acceptance.
  cognito_sub      TEXT,
  status           TEXT NOT NULL DEFAULT 'invited',
  -- The operator's own note: 'beta tester', 'friend of X'.
  note             TEXT,
  invited_by       UUID REFERENCES admin_users (id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The last time the invitation email went out (create or resend).
  last_sent_at     TIMESTAMPTZ,
  send_count       INTEGER NOT NULL DEFAULT 0,
  accepted_at      TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  -- Cognito's message when a create or a resend was refused.
  error            TEXT,

  CONSTRAINT admin_customer_invites_status_chk
    CHECK (status IN ('invited', 'accepted', 'revoked', 'failed'))
);

-- Only ONE open invitation per address, case-insensitively. Accepted, revoked
-- and failed rows are history and may repeat: a retry is a new invitation.
CREATE UNIQUE INDEX IF NOT EXISTS admin_customer_invites_open_email_key
  ON admin_customer_invites (lower(email))
  WHERE status = 'invited';

CREATE INDEX IF NOT EXISTS idx_admin_customer_invites_status
  ON admin_customer_invites (status);
CREATE INDEX IF NOT EXISTS idx_admin_customer_invites_cognito_sub
  ON admin_customer_invites (cognito_sub);
CREATE INDEX IF NOT EXISTS idx_admin_customer_invites_created_at
  ON admin_customer_invites (created_at DESC);

COMMENT ON TABLE admin_customer_invites IS
  'Invitations to the consumer app: one row per invitation, written before Cognito is called and never deleted. invited -> accepted when a users row with the same cognito_sub appears in the main app database; revoked when an operator withdrew it (the unused pool account is deleted); failed when Cognito refused, with the reason in error. Temporary passwords are never seen or stored.';
COMMENT ON COLUMN admin_customer_invites.cognito_sub IS
  'The customer pool account''s sub. NULL when the create failed. Matched against the main app database''s users.cognito_sub to detect that the person has signed in.';
COMMENT ON COLUMN admin_customer_invites.send_count IS
  'How many times the invitation email has gone out: 1 after the create, +1 per resend.';

-- ---------------------------------------------------------------------------
-- Audit trail: allow 'customer_invite' as a target type
-- The full list from 002 and 004 plus the new value. Dropping first keeps the
-- file re-runnable; the constraint is recreated in the same transaction, so
-- the table is never left unguarded.
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
      -- A whole reference catalog: written once per successful push.
      'catalog',
      -- One invitation to the consumer app: created, resent, revoked, or a
      -- create Cognito refused. target_id is the invitation id and the
      -- metadata carries the email address; never a password.
      'customer_invite'
    ));

-- ---------------------------------------------------------------------------
-- Seed: the action
-- Category 'users', beside can_read_user_list and can_read_user_detail, which
-- 001_admin_access.sql already seeded.
-- ---------------------------------------------------------------------------
INSERT INTO admin_actions (key, description, category) VALUES
  ('can_invite_users', 'Invite people to the consumer app (creates the Cognito account and sends the email)', 'users')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: the Customers page and the Invite customer quick action
-- ---------------------------------------------------------------------------
INSERT INTO admin_pages (key, kind, path, name, description, nav_order, require_super_admin) VALUES
  ('customers',       'page',         '/customers', 'Customers',       'The consumer app''s users: who they are, how active they are, and the invitations sent to them.', 25, FALSE),
  ('invite_customer', 'quick_action', NULL,         'Invite customer', 'Create a consumer-app account and email the invitation.',                                      20, FALSE)
ON CONFLICT (key) DO NOTHING;

INSERT INTO admin_page_actions (page_id, action_id)
SELECT p.id, a.id FROM admin_pages p CROSS JOIN admin_actions a
WHERE (p.key = 'customers'
         AND a.key IN ('can_read_user_list', 'can_read_user_detail', 'can_invite_users'))
   OR (p.key = 'invite_customer'
         AND a.key = 'can_invite_users')
ON CONFLICT (page_id, action_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: endpoints (keys, methods and paths must match
-- src/lib/admin-access/endpoint-registry.ts, and the path is spelled the way
-- Next spells it, with [id])
-- ---------------------------------------------------------------------------
INSERT INTO admin_endpoints (key, method, path, name, description, category, auth_kind, rate_limit_policy, require_super_admin) VALUES
  ('admin.customers.list',           'GET',    '/api/v1/admin/customers',                        'List customers',                 'One page of the consumer app''s users with their tenants, last activity, account and transaction counts, and what the customer Cognito pool says about each account.', 'customers', 'admin', 'api', FALSE),
  ('admin.customers.get',            'GET',    '/api/v1/admin/customers/[id]',                   'Get customer',                   'One customer by users.id, with the same figures as the list.',                                                                                                        'customers', 'admin', 'api', FALSE),
  ('admin.customers.invites.list',   'GET',    '/api/v1/admin/customers/invites',                'List customer invitations',      'Invitations sent to the consumer app, newest first, with counts per status and whether this deployment can send any.',                                                'customers', 'admin', 'api', FALSE),
  ('admin.customers.invites.create', 'POST',   '/api/v1/admin/customers/invites',                'Invite a customer',              'Creates the account in the customer Cognito pool and lets Cognito email the temporary password. 409 when the address already has an account or an open invitation.',   'customers', 'admin', 'api', FALSE),
  ('admin.customers.invites.resend', 'POST',   '/api/v1/admin/customers/invites/[id]/resend',    'Resend a customer invitation',   'Sends the invitation email again for an invitation nobody has acted on yet.',                                                                                         'customers', 'admin', 'api', FALSE),
  ('admin.customers.invites.revoke', 'DELETE', '/api/v1/admin/customers/invites/[id]',           'Revoke a customer invitation',   'Deletes the unused pool account and marks the invitation revoked. Refuses (409) once the person has signed in.',                                                      'customers', 'admin', 'api', FALSE)
ON CONFLICT (key) DO NOTHING;

-- Endpoint -> actions (ANY-OF). The three reads take any of the two user-read
-- actions or the invite action (someone who may invite must be able to see
-- who has been invited); the three writes take can_invite_users.
INSERT INTO admin_endpoint_actions (endpoint_id, action_id)
SELECT e.id, a.id FROM admin_endpoints e CROSS JOIN admin_actions a
WHERE (e.key IN ('admin.customers.list',
                 'admin.customers.get',
                 'admin.customers.invites.list')
         AND a.key IN ('can_read_user_list', 'can_read_user_detail', 'can_invite_users'))
   OR (e.key IN ('admin.customers.invites.create',
                 'admin.customers.invites.resend',
                 'admin.customers.invites.revoke')
         AND a.key = 'can_invite_users')
ON CONFLICT (endpoint_id, action_id) DO NOTHING;

COMMIT;
