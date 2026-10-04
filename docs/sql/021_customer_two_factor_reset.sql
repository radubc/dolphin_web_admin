-- Customer support: "Turn off two-factor authentication" on the Customers page
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 020. Re-running is safe: the inserts are guarded by ON CONFLICT
-- and the constraint is dropped and recreated in the same transaction, so
-- the table is never left unguarded. No table, column or index is created,
-- altered or dropped.
--
-- Why this file exists
--   docs/two-factor-plan.md, phase C (owner-approved 2026-10-04). The
--   consumer app's recovery codes assume one support path exists for a
--   person who has lost both their authenticator app and their codes: an
--   operator opens the customer in the Customers drawer and presses "Turn off
--   two-factor authentication". The console makes one Cognito admin call on
--   the customer pool (AdminSetUserMFAPreference, authenticator app and
--   passkey MFA both off); the person then signs in with their password
--   alone and enrols again in FairSums, which issues them new codes. Nothing
--   else about the account changes, and the consumer app's
--   user_recovery_codes table is never touched from here.
--
--   That is one more POST:
--
--     POST /api/v1/admin/customers/[id]/two-factor/reset
--
--   Registering it here is what puts it on the Access Map and the Services
--   page and lets a non-super-admin role reach it; an endpoint with no row is
--   super-admin only. The route itself adds three guards the Access Map does
--   not express: the operator's own session must have been signed in with a
--   second factor (the authenticator code or a passkey — a password-only
--   session is refused with 403 and the drawer shows why instead of the
--   button); five per hour per operator; and one audit row per attempt that
--   reaches Cognito, which is the second change below.
--
-- What this changes
--   admin_endpoints          one row: admin.customers.two_factor_reset,
--                            mirroring src/lib/admin-access/endpoint-registry.ts
--   admin_endpoint_actions   that endpoint takes can_write_user (001:
--                            "Update end-user records"), the closest action
--                            the catalog has to changing a customer's account.
--                            Named explicitly so it cannot end up with no
--                            actions at all; change the grant on the Access
--                            Map if a different role should hold it.
--   audit check constraint   target_type may now also be
--                            'customer_two_factor_reset': the full list from
--                            010 plus the new value.
--
-- What this does NOT change
--   No action, role, page or grant is added or changed beyond the one link.
--   No row of any other table is touched. The IAM side — the admin task
--   role needs cognito-idp:AdminSetUserMFAPreference on the customer pool,
--   added to the customer-user-pool policy in infra/service-admin.yaml —
--   rides the normal deploy and is not SQL.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The endpoint (key, method and path must match
--    src/lib/admin-access/endpoint-registry.ts)
--
-- `two-factor/reset` is a static segment under the existing
-- /api/v1/admin/customers/[id], the same shape as the `activity` segment 014
-- registered there.
-- ---------------------------------------------------------------------------
INSERT INTO admin_endpoints (key, method, path, name, description, category, auth_kind, rate_limit_policy, require_super_admin) VALUES
  ('admin.customers.two_factor_reset', 'POST', '/api/v1/admin/customers/[id]/two-factor/reset', 'Turn off a customer''s two-factor authentication', 'AdminSetUserMFAPreference on the customer pool with the authenticator app and passkey MFA both off, for a person who has lost their authenticator and their recovery codes. No body. The operator must be signed in with a second factor (authenticator code or passkey), else 403; 5 per hour per operator; one audit row per attempt. Changes nothing else about the account and never touches the consumer app''s recovery codes. Answers the fresh twoFactor block.', 'customers', 'admin', 'customerTwoFactorReset', FALSE)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Its action: a write on a customer's account, so can_write_user. The
--    three Customers reads keep their own trio (010, 014); this one is
--    deliberately narrower.
-- ---------------------------------------------------------------------------
INSERT INTO admin_endpoint_actions (endpoint_id, action_id)
SELECT e.id, a.id FROM admin_endpoints e CROSS JOIN admin_actions a
WHERE e.key = 'admin.customers.two_factor_reset'
  AND a.key IN ('can_write_user')
ON CONFLICT (endpoint_id, action_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Audit trail: allow 'customer_two_factor_reset' as a target type
-- The full list from 002, 004 and 010 plus the new value. Dropping first
-- keeps the file re-runnable; the constraint is recreated in the same
-- transaction, so the table is never left unguarded.
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
      'customer_invite',
      -- A customer's two-factor authentication turned off by support
      -- (customer_two_factor_reset) or a call Cognito refused
      -- (customer_two_factor_reset_failed). target_id is the customer's
      -- users.id; the metadata carries the email, the sub and the factors
      -- the account had before (methodsBefore). Never a code or a secret.
      'customer_two_factor_reset'
    ));

COMMIT;

-- ---------------------------------------------------------------------------
-- Check
-- ---------------------------------------------------------------------------
-- SELECT e.key, e.method, e.path, e.is_enabled, e.rate_limit_policy,
--        string_agg(a.key, ', ' ORDER BY a.key) AS actions
--   FROM admin_endpoints e
--   LEFT JOIN admin_endpoint_actions ea ON ea.endpoint_id = e.id
--   LEFT JOIN admin_actions a ON a.id = ea.action_id
--  WHERE e.key = 'admin.customers.two_factor_reset'
--  GROUP BY e.id;
--
-- Expect one row, is_enabled TRUE, rate_limit_policy customerTwoFactorReset,
-- actions can_write_user.
--
-- SELECT pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conname = 'admin_permission_audit_events_target_type_chk';
--
-- Expect the list to end with 'customer_two_factor_reset'.
