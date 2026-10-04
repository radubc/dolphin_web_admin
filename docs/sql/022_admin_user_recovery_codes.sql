-- Operator two-factor recovery codes, and the endpoint that regenerates them
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 021. Re-running is safe: the table and its indexes are created
-- IF NOT EXISTS and the insert is guarded by ON CONFLICT. Nothing is altered
-- or dropped.
--
-- Why this file exists
--   docs/two-factor-plan.md, phase B (owner-approved 2026-10-04): the port of
--   the consumer app's recovery codes (its docs/recovery-codes.md) to the
--   console. Cognito has no backup codes of its own, so when an operator
--   turns the authenticator app on, the console mints ten single-use codes
--   and shows them once. Losing the phone later, the operator signs in at
--   /login with the password and one code instead of the authenticator; the
--   console turns the authenticator (and passkey MFA) off on their account
--   in the ADMIN pool with AdminSetUserMFAPreference, signs them in, and nags
--   them to set it up again. Without this a locked-out operator needs the
--   owner at the AWS CLI.
--
--   The table holds hashes only. A code is ten symbols from a 31-symbol
--   alphabet (no 0/o, 1/i/l), hashed with SHA-256 before it is written;
--   the clear code exists in the server's memory for one request and in the
--   browser for one dialog. One set at a time per operator: issuing codes
--   deletes every row they have and inserts ten (enrolment, "Generate new
--   codes"); turning the authenticator off deletes them; redeeming one marks
--   it used_at and deletes the other nine, so the one used row is the record
--   the drawer's banner and the shell's nudge are derived from until the next
--   enrolment replaces it. A CLI reset by the owner (AdminSetUserMFAPreference
--   with both settings off) touches no row, which is how the drawer can say
--   "turned off by support" from the unused rows left behind.
--
--   user_id is admin_users.id (not the Cognito sub) and the rows go with the
--   allowlist row (ON DELETE CASCADE). No row-level security, like every
--   other admin_* table: the console reads this database as one role and
--   every query the app makes is pinned to one user_id.
--
-- What this adds
--   admin_user_recovery_codes   the hashes: id, user_id, code_hash,
--                               created_at, used_at; unique per operator and
--                               hash, indexed by operator
--   admin_endpoints             one row: admin.me.mfa.recovery_codes
--                               ("Generate new codes"), mirroring
--                               src/lib/admin-access/endpoint-registry.ts,
--                               registered like the other admin.me.* rows in
--                               018 — require_super_admin FALSE and NO
--                               admin_endpoint_actions rows, which the access
--                               map reads as "any enabled operator": it acts
--                               on the caller's own account and on nothing
--                               else. The other two halves of the feature
--                               (the codes on PUT …/mfa/totp, the summary on
--                               GET …/mfa, the delete on DELETE …/mfa/totp)
--                               ride the endpoints 018 already registered,
--                               and the redeem step is a Server Action on
--                               /login, which has no endpoint row at all.
--
-- What this does NOT change
--   No action, role, page or grant is added or changed. No row of any other
--   table is touched. The IAM half — the admin task role needs
--   cognito-idp:AdminGetUser and cognito-idp:AdminSetUserMFAPreference on the
--   ADMIN pool ARN, the new `operator-recovery` policy in
--   infra/service-admin.yaml — rides the normal deploy and is not SQL.
--
-- Afterwards
--   npx prisma db pull --config prisma-admin.config.ts && npm run prisma:generate
--   The app ships with raw, parameterised queries against this table
--   (src/lib/account/recovery-codes.ts) so it compiles and runs before the
--   pull; until this file has run, the reads answer "no codes" and one
--   warning line names this file. After the pull the typed model
--   `admin_user_recovery_codes` exists and the module can switch to it.

BEGIN;

-- ---------------------------------------------------------------------------
-- admin_user_recovery_codes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_user_recovery_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The operator (admin_users.id, never the Cognito sub). Rows go with the
  -- allowlist row.
  user_id     UUID NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  -- SHA-256 of the normalised ten-symbol code, lowercase hex. Never the code.
  code_hash   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when the code was redeemed at sign-in. The other nine rows are then
  -- deleted; this one stays until the next enrolment replaces the set.
  used_at     TIMESTAMPTZ,

  CONSTRAINT admin_user_recovery_codes_code_hash_chk
    CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT admin_user_recovery_codes_user_hash_key
    UNIQUE (user_id, code_hash)
);

-- Every query the app makes is "this operator's rows".
CREATE INDEX IF NOT EXISTS idx_admin_user_recovery_codes_user_id
  ON admin_user_recovery_codes (user_id);

COMMENT ON TABLE admin_user_recovery_codes IS
  'Two-factor recovery codes for operators, as SHA-256 hashes (docs/two-factor-plan.md, phase B). Ten per operator, issued once when the authenticator app is turned on or new codes are generated; redeemed at /login with the password, which turns the authenticator off on the admin pool. used_at marks the one redeemed row, kept until the next enrolment replaces the set. The clear code is never stored.';
COMMENT ON COLUMN admin_user_recovery_codes.user_id IS
  'admin_users.id, not the Cognito sub. Every query is pinned to one operator.';
COMMENT ON COLUMN admin_user_recovery_codes.code_hash IS
  'SHA-256 of the normalised code (ten lowercase symbols from the 31-symbol alphabet, no dash), lowercase hex.';
COMMENT ON COLUMN admin_user_recovery_codes.used_at IS
  'When the code was redeemed at sign-in; NULL while unused. A row with used_at set is what the drawer banner and the shell nudge read until the next enrolment.';

-- ---------------------------------------------------------------------------
-- The endpoint (key, method and path must match
-- src/lib/admin-access/endpoint-registry.ts). Same registration as the nine
-- account_security rows in 018: no actions, any enabled operator.
-- ---------------------------------------------------------------------------
INSERT INTO admin_endpoints (key, method, path, name, description, category, auth_kind, rate_limit_policy, require_super_admin) VALUES
  ('admin.me.mfa.recovery_codes', 'POST', '/api/v1/admin/me/mfa/recovery-codes', 'Generate new recovery codes', 'Replaces the caller''s ten two-factor recovery codes behind a password re-check and answers the new ones once. A password guess, so it charges the sign-in budget per email and a per-operator budget as well as the reset budget per IP; 422 while the authenticator app is off.', 'account_security', 'admin', 'authReset', FALSE)
ON CONFLICT (key) DO NOTHING;

-- No admin_endpoint_actions rows on purpose: see the header and 018.

COMMIT;

-- ---------------------------------------------------------------------------
-- Check
-- ---------------------------------------------------------------------------
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_name = 'admin_user_recovery_codes'
--  ORDER BY ordinal_position;
--
-- Expect five rows: id, user_id, code_hash, created_at, used_at.
--
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'admin_user_recovery_codes'::regclass
--  ORDER BY conname;
--
-- Expect the primary key, the foreign key ON DELETE CASCADE, the code_hash
-- CHECK and the (user_id, code_hash) UNIQUE.
--
-- SELECT e.key, e.method, e.path, e.is_enabled, e.rate_limit_policy,
--        count(a.id) AS actions
--   FROM admin_endpoints e
--   LEFT JOIN admin_endpoint_actions a ON a.endpoint_id = e.id
--  WHERE e.key = 'admin.me.mfa.recovery_codes'
--  GROUP BY e.id;
--
-- Expect one row, is_enabled TRUE, rate_limit_policy authReset, actions 0.
