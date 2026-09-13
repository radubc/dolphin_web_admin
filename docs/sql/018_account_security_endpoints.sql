-- Account & security: the endpoints an operator uses on their own account
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 017_currency_pair_history.sql. Re-running is safe: every insert is
-- guarded by ON CONFLICT and nothing is created, altered or deleted.
--
-- Why this file exists
--   The console gained an "Account & security" surface, opened from the avatar
--   menu, where the signed-in operator can change their own password, enrol an
--   authenticator app and manage their passkeys. It is a drawer, not a page,
--   so there is nothing to register in admin_pages — but each of its nine
--   Route Handlers goes through adminHandler() and therefore wants a row here,
--   which is what puts them on the Services page with their usage counters and
--   what lets the owner disable one from the Access Map.
--
--   Every one of them acts on the *caller's own* Cognito account and on
--   nothing else: the operations are Cognito's self-service API
--   (ChangePassword, AssociateSoftwareToken, VerifySoftwareToken,
--   SetUserMFAPreference and the four WebAuthn calls), and each is
--   authenticated with the access token from the caller's own session cookie,
--   which is what names the subject. There is no user id in any of these
--   requests, so there is nobody else to reach.
--
--   That is why they are registered with require_super_admin = FALSE and with
--   NO admin_endpoint_actions rows: evaluateRule() treats a registered
--   endpoint with an empty action list as "any enabled operator", which is the
--   right rule for a person changing their own password. `admin.me` (the
--   capabilities read) is registered exactly the same way in 002.
--
--   Nothing is removed and no behaviour changes: an endpoint with no row is
--   super-admin only, so before this file runs the drawer works for the owner
--   and answers 403 for everyone else.
--
-- What still has to happen in Cognito
--   The MFA and passkey endpoints are complete but AWS refuses them until the
--   admin user pool is reconfigured — MfaConfiguration OPTIONAL with software
--   tokens on, and for passkeys the Essentials tier plus a WebAuthn relying
--   party. They answer 503 (mfa_not_enabled / passkeys_not_enabled) quoting
--   Cognito's own sentence until then. The settings and the aws cli commands
--   are in docs/auth.md. This SQL is unaffected either way.

BEGIN;

-- ---------------------------------------------------------------------------
-- Seed: endpoints (keys, methods and paths must match
-- src/lib/admin-access/endpoint-registry.ts)
-- ---------------------------------------------------------------------------
INSERT INTO admin_endpoints (key, method, path, name, description, category, auth_kind, rate_limit_policy, require_super_admin) VALUES
  ('admin.me.password.change',   'POST',   '/api/v1/admin/me/password',       'Change own password',            'The caller replaces their own Cognito password. Cognito checks the current one, which is the re-authentication the change needs. Acts on no other account.',                                     'account_security', 'admin', 'authReset', FALSE),
  ('admin.me.mfa.get',           'GET',    '/api/v1/admin/me/mfa',            'Own MFA status',                 'Which second factors Cognito has switched on for the caller. Read live from the pool with the caller''s access token; nothing is cached.',                                                       'account_security', 'admin', 'api',       FALSE),
  ('admin.me.mfa.totp.start',    'POST',   '/api/v1/admin/me/mfa/totp',       'Start authenticator enrolment',  'AssociateSoftwareToken: mints the shared secret and its otpauth:// URI, shown once and stored nowhere. 503 mfa_not_enabled while the pool''s MfaConfiguration is OFF.',                          'account_security', 'admin', 'api',       FALSE),
  ('admin.me.mfa.totp.verify',   'PUT',    '/api/v1/admin/me/mfa/totp',       'Verify authenticator enrolment', 'VerifySoftwareToken with a six-digit code, then SetUserMFAPreference to switch the factor on. A code guess, so it carries the reset budget per operator as well as per IP.',                    'account_security', 'admin', 'authReset', FALSE),
  ('admin.me.mfa.totp.disable',  'DELETE', '/api/v1/admin/me/mfa/totp',       'Turn off authenticator app',     'SetUserMFAPreference with software-token MFA disabled for the caller''s own account.',                                                                                                          'account_security', 'admin', 'api',       FALSE),
  ('admin.me.passkeys.list',     'GET',    '/api/v1/admin/me/passkeys',       'List own passkeys',              'ListWebAuthnCredentials for the caller. 503 passkeys_not_enabled while the pool has no WebAuthn relying party configured.',                                                                      'account_security', 'admin', 'api',       FALSE),
  ('admin.me.passkeys.start',    'POST',   '/api/v1/admin/me/passkeys',       'Start passkey registration',     'StartWebAuthnRegistration: Cognito''s CredentialCreationOptions for navigator.credentials.create(). Cognito is the relying party and owns the challenge.',                                       'account_security', 'admin', 'api',       FALSE),
  ('admin.me.passkeys.complete', 'PUT',    '/api/v1/admin/me/passkeys',       'Complete passkey registration',  'CompleteWebAuthnRegistration with the browser''s RegistrationResponseJSON, forwarded to Cognito untouched: it verifies the attestation, the challenge and the origin.',                          'account_security', 'admin', 'api',       FALSE),
  ('admin.me.passkeys.delete',   'DELETE', '/api/v1/admin/me/passkeys/[id]',  'Delete a passkey',               'DeleteWebAuthnCredential. The id is scoped to the caller''s own account by Cognito, so a credential belonging to anybody else is simply not found.',                                            'account_security', 'admin', 'api',       FALSE)
ON CONFLICT (key) DO NOTHING;

-- No admin_endpoint_actions rows on purpose: see the header. An empty action
-- list on a registered, enabled endpoint means "any enabled operator", which
-- is what a self-service account setting has to be.

COMMIT;

-- ---------------------------------------------------------------------------
-- Check
-- ---------------------------------------------------------------------------
-- SELECT e.key, e.method, e.path, e.is_enabled, count(a.id) AS actions
--   FROM admin_endpoints e
--   LEFT JOIN admin_endpoint_actions a ON a.endpoint_id = e.id
--  WHERE e.category = 'account_security'
--  GROUP BY e.id
--  ORDER BY e.path, e.method;
--
-- Expect nine rows, is_enabled TRUE, actions 0 on every one.
