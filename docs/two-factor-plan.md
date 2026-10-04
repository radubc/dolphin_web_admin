# Two-factor authentication — admin console plan

**Status: approved by the owner on 2026-10-04** (order A → C → B → D; the
issuer label becomes "FairSums Admin"; the operator step-up rule in phase C
is in). Phase A live on stage and verified 2026-10-04 (operator account lists WEB_AUTHN_MFA beside SOFTWARE_TOKEN_MFA; passkey and password+code both sign in).

Mirrors phases 1 and 2 of the web app's `docs/two-factor-plan.md`
(`~/Developer/projects/penny-squeeze-web`), plus the customer-support action
briefed in that repo's `docs/admin-console/two-factor-reset.md`. The web
app's designs are reused where the two apps are the same; differences are
called out.

## Where the console stands (inventory, 2026-10-04)

Exists and works: password + authenticator-code sign-in
(`src/lib/auth/cognito.ts`, `src/app/login/actions.ts`), passkey sign-in
(`USER_AUTH` / `WEB_AUTHN`), the Account & security drawer with TOTP
enrolment (text key only), passkey register / list / delete
(`src/lib/account/service.ts`, `src/components/account/`), rate-limit presets
(`src/lib/security/rate-limit.ts`), the customer detail drawer with a
"Cognito account" section (`src/components/customers/customer-detail-drawer.tsx`),
admin calls on the customer pool (`src/lib/customers/cognito.ts`, IAM policy
`customer-user-pool` in `infra/service-admin.yaml`), the audit table
`admin_permission_audit_events`, and the numbered-SQL schema workflow
(`docs/database.md`; next file `022_…` — `021` is phase C's).

Absent: any `WebAuthnMfaSettings` call or `WEB_AUTHN_MFA` reading, a QR
code, recovery codes, a customer "turn off two-factor" action, knowledge of
how the operator's own session was authenticated, tests.

**Live risk today.** Both pools were switched to
`FactorConfiguration: MULTI_FACTOR_WITH_USER_VERIFICATION` on 2026-10-04
(see the web repo's `docs/cognito/README.md`). Without the per-user flag,
an operator who turns on the authenticator app is refused passkey sign-in
(AWS rule, confirmed on stage for the web app). Interim fix per operator,
from the web runbook: `admin-set-user-mfa-preference` with both
`--software-token-mfa-settings Enabled=true,PreferredMfa=true` and
`--web-authn-mfa-settings Enabled=true`. Phase A removes the need for it.

## Phase A — Passkeys count as two factors for operators (small)

Port of the web app's phase 1, same shape, same lessons:

1. `src/lib/account/service.ts`: `setPasskeyMfaPreference(accessToken,
   enabled)` → `SetUserMFAPreference` with `WebAuthnMfaSettings { Enabled }`
   **and**, when enabling, `SoftwareTokenMfaSettings { Enabled: true,
   PreferredMfa: true }` in the same request — Cognito refuses the WebAuthn
   setting alone with "WebAuthn MFA requires enabling an additional MFA
   setting" even when TOTP is already on (stage, 2026-10-03).
   `disableTotp` sends both settings off in one call, falling back to the
   TOTP-only call on refusal (web: `disableSoftwareTokenAndPasskeyMfa`).
2. `ensurePasskeyMfa(accessToken)` (new `src/lib/account/passkey-mfa.ts`,
   best-effort, never throws): when TOTP is on, ≥ 1 passkey exists and
   `UserMFASettingList` lacks `WEB_AUTHN_MFA`, set the flag. Called after
   `verifyTotpEnrolment`, after `completePasskeyRegistration`, and in
   `verifyMfaCode` after the code is accepted and before `createSession`
   (this is what heals operators who enrolled before the change). The
   status read stays a read.
3. `getMfaStatus` / `GET /api/v1/admin/me/mfa` gain `passkeyMfaEnabled`
   (`WEB_AUTHN_MFA` in the list; `types.ts` methods union extended) and
   `passkeySignInPaused` (TOTP on, passkeys exist, flag off).
4. Drawer copy: one sentence explaining the model under the two-factor
   heading; a warning `Alert` while `passkeySignInPaused` ("Passkey sign-in
   is paused while two-factor authentication is on. Until an upcoming update,
   sign in with your password and authenticator code.").
5. Stale comments corrected (all say the pool is `OFF` / `LITE` / no relying
   party): `src/lib/account/service.ts:13–19`,
   `src/components/account/two-factor-section.tsx:15–18`,
   `src/components/account/passkeys-section.tsx:19–21`,
   `src/app/api/v1/admin/me/mfa/totp/route.ts:13–15`,
   `.../passkeys/route.ts:13–15`, `src/lib/auth/cognito.ts:67–69` and
   `:1219–1220`, `docs/api.md:77,80`, `docs/sql/018_…:34–37`; `docs/auth.md`
   gets the real passkey/TOTP rule and a "Passkey MFA" subsection.
6. The TOTP issuer label `"Penny Squeeze Admin"` (`src/lib/account/service.ts:50`)
   becomes `"FairSums Admin"` (owner, 2026-10-04). Only new enrolments are
   affected; an existing authenticator entry keeps its old name.

No SQL, no IAM, no pool change. Test on stage with the operator account:
TOTP on + passkey → both sign-ins work; TOTP off → list empty, passkey
still works.

*Phase A built 2026-10-04:* `src/lib/account/passkey-mfa.ts`
(`ensurePasskeyMfa`, best-effort, never throws), `setPasskeyMfaPreference` /
`isPasskeyMfaListed` / the combined off-call in `src/lib/account/service.ts`,
the three trigger points (`PUT …/mfa/totp`, `PUT …/passkeys`, `verifyMfaCode`
before `createSession`), `passkeyMfaEnabled` + `passkeySignInPaused` on
`GET /api/v1/admin/me/mfa` and in `types.ts`, the sentence and the paused
warning in `two-factor-section.tsx` (re-read on `PASSKEYS_CHANGED_EVENT` from
`passkeys-section.tsx`), the issuer "FairSums Admin", the stale comments and
`docs/auth.md` ("Passkey MFA (2026-10-04)"). Not run locally: passkeys do
not work from `localhost`, and the pool calls need a deployed host.

Stage test (`admin.fairsums.app`, the operator account, after deploy):

1. With TOTP on and a passkey registered from before, sign in with email +
   password + code: the sign-in sets the flag. `admin-get-user` lists
   `WEB_AUTHN_MFA` beside `SOFTWARE_TOKEN_MFA`; the drawer shows no "paused"
   warning and "Factors Cognito has on file" names both.
2. Sign out, "Sign in with a passkey": Touch ID / PIN prompt, signed in, no
   code step.
3. Sign out, email + password: the code step still appears.
4. Account & security: turn TOTP off → `UserMFASettingList` empty (the log
   shows no `disable authenticator app and passkey MFA: Cognito refused`
   line, so the combined call was accepted); passkey sign-in works; password
   sign-in asks no code.
5. Turn TOTP on again (new enrolment, issuer "FairSums Admin" in the app):
   `WEB_AUTHN_MFA` is listed straight after the code is accepted, without a
   sign-in. Remove the passkey, add one back: the warning appears and
   disappears with it.

## Phase B — QR code and operator recovery codes (medium)

Port of the web app's phase 2; the design is `docs/recovery-codes.md` in
the web repo and is not repeated here — only the admin differences:

1. **QR code** in the enrolment step of `two-factor-section.tsx` (antd
   `QRCode` from the existing `otpauth://` URI), text key kept.
2. **Table** `admin_user_recovery_codes` (`user_id` → `admin_users.id`,
   uuid, ON DELETE CASCADE; `code_hash`, `created_at`, `used_at`; unique
   `(user_id, code_hash)`; no RLS, like the other admin tables) as
   `docs/sql/022_admin_user_recovery_codes.sql`; owner runs it on the local
   and stage admin databases, then `npx prisma db pull --config
   prisma-admin.config.ts && npx prisma generate`.
3. **Codes**: ten, shown once after `verifyTotpEnrolment` (PUT
   `/api/v1/admin/me/mfa/totp` returns them), Copy / Download; "N of 10
   left" row; "Generate new codes" behind the password (the console has no
   `verifyPasswordForSensitiveAction` yet — add it to `src/lib/auth/cognito.ts`
   as the web app has, a bare `USER_PASSWORD_AUTH` whose `SOFTWARE_TOKEN_MFA`
   challenge counts as proof). Endpoints registered by the same SQL file
   (`admin.me.recovery_codes.*`, Access Map not needed: `admin.me.*`).
4. **Redeem at sign-in**: "Use a recovery code instead" on the code step →
   `redeemRecoveryCode` server action: email + password + code in one
   request; claim the row atomically (`updateMany … used_at: null`), then
   `AdminSetUserMFAPreference` both settings off **on the admin pool**, undo
   the claim on refusal, delete the other rows, sign in with the password,
   `redirect("/")`; fallback `/login?recovery=used`. IAM: the admin task role
   needs `cognito-idp:AdminSetUserMFAPreference` on the **admin** pool ARN —
   add it to whichever policy already grants `AdminCreateUser` on that pool
   for operator invitations (verify in `infra/service-admin.yaml`).
5. **Rate limits**: add `authMfa` (10 / 15 min) and `accountMfa` presets
   as in the web app; the existing budgets stay (nothing removed). Recovery
   and authenticator codes share the `mfa:email:` key.
6. Shell nudge until re-enrolled, same rule as the web app (TOTP off and
   rows exist; `used_at` set → recovery, unused rows → support reset).

## Phase C — Customer support: "Turn off two-factor authentication" (medium)

The brief `docs/admin-console/two-factor-reset.md` (web repo), made concrete:

1. **Read**: `getCustomer` adds a `twoFactor` block from a direct
   `AdminGetUser` on the customer pool (`UserMFASettingList`,
   `PreferredMfaSetting`), shown in the drawer's "Cognito account" section
   as "Two-factor authentication: On (authenticator, passkey) / Off". The
   cached `ListUsers` directory does not carry it.
2. **Action**: button "Turn off two-factor authentication" → confirm dialog
   with the customer's email typed back → `POST
   /api/v1/admin/customers/[id]/two-factor/reset` →
   `AdminSetUserMFAPreference` on the customer pool with
   `SoftwareTokenMfaSettings { Enabled: false, PreferredMfa: false }` and
   `WebAuthnMfaSettings { Enabled: false }`. It never touches the web app's
   `user_recovery_codes` (the console never reads that database); the
   customer re-enrols in FairSums and gets new codes.
3. **Guards**: endpoint key `admin.customers.two_factor_reset` in the
   registry + Access Map grant (`docs/sql/021_…`, since C runs before B);
   audit row `admin_permission_audit_events` with
   `target_type: "customer_two_factor_reset"` (union in
   `src/lib/admin-access/types.ts`), best-effort as `invites.ts` does;
   rate limit 5 / hour per operator; **the operator must be signed in with
   a second factor**: record the sign-in method in the session at
   `createSession` (`"password"`, `"password+totp"`, `"passkey"`) and
   refuse the action for `"password"` with "Sign in with your authenticator
   app or a passkey to use this." (chosen over the `amr` claim, which the
   pool is not known to emit).
4. **IAM**: `cognito-idp:AdminSetUserMFAPreference` added to the
   `customer-user-pool` policy (`infra/service-admin.yaml`, Sid
   `CustomerPoolOnly`); `docs/customers.md:398–401` updated (it currently
   says the policy grants nothing beyond the four actions).
5. **Email to the customer** is phase 3 of the web plan; not sent here.

*Phase C built 2026-10-04* (C went before B, so it took SQL **021**; B's
`admin_user_recovery_codes` becomes `022_…`):

- Session: `SignInMethod` + `Session.signInMethod` in `src/lib/auth/session.ts`
  (signed `psa_sign_in_method` cookie, `src/lib/auth/cookies.ts`; HMAC over
  `sub` + `origin_jti` keyed from `ADMIN_COGNITO_CLIENT_SECRET`, per-process
  random key without one, fails closed to `password`); the three
  `createSession` call sites in `src/app/login/actions.ts` (`password`,
  `password+totp`, `passkey`; the invitation step also `password`);
  `src/lib/api/auth.ts` passes the cookie for browser callers; `refresh.ts`
  reads it against the proof token and re-signs it with the new tokens.
- Customers: `CustomerTwoFactor` / `CustomerDetail` /
  `CustomerTwoFactorResetResponse` in `types.ts`; `readTwoFactor` +
  `resetTwoFactor` (`AdminGetUser`, `AdminSetUserMFAPreference` both settings
  off, addressed by the sub) in `cognito.ts`; the new `two-factor.ts`
  (step-up 403, `customerTwoFactorReset` 5/hour per operator in
  `rate-limit.ts`, 404/503, audit rows `customer_two_factor_reset` /
  `customer_two_factor_reset_failed` with `methodsBefore`, best effort);
  `getCustomer(id, operatorSignInMethod)` adds `twoFactor` (best effort,
  `null` → "Unavailable") and `operatorCanReset`; `GET /customers/[id]`
  reads the caller's method from the cookie session; new route
  `POST /api/v1/admin/customers/[id]/two-factor/reset`; `customersApi.twoFactor.reset`.
- Drawer: `TwoFactorRow` in `customer-detail-drawer.tsx` — the line, the
  danger button only while On *and* `operatorCanReset`, else the server's
  sentence; the confirm `Modal` with the email typed back (case-insensitive,
  button disabled until it matches).
- Registry: `admin.customers.two_factor_reset` (rate limit
  `customerTwoFactorReset`, default `can_write_user`); `AuditTargetType`
  gains `customer_two_factor_reset`; `docs/sql/021_customer_two_factor_reset.sql`
  registers the endpoint, links `can_write_user`, widens the audit check.
- IAM: `cognito-idp:AdminSetUserMFAPreference` in `customer-user-pool` /
  `CustomerPoolOnly` (`infra/service-admin.yaml`); no Description change.
- Docs: `customers.md` (IAM table + the new section), `access-control.md`
  ("Step-up"), `api.md` (preset + endpoint rows, the `get` row), `auth.md`
  (the cookie + the sign-in method), `sql/README.md` (row 21), `CLAUDE.md`
  (the customer-pool permissions line).
- Not run locally: the pool calls need AWS credentials with the new
  permission, and passkeys do not work from `localhost`. `operatorCanReset`
  and the cookie were exercised only through the type check and the build.

Owner steps: run `021_customer_two_factor_reset.sql` on the local and stage
admin databases; deploy (the IAM grant rides the push to stage); on the
Access Map, grant `admin.customers.two_factor_reset` to the roles that
should have it (it ships linked to `can_write_user`; super-admin only until
the SQL has run). Existing sessions keep working and read as password-only
until their next sign-in.

Stage test (`admin.fairsums.app`, after deploy):

1. Operator signed in with email + password only (an account with no
   authenticator app, or a session from before the deploy): open a customer
   whose authenticator is on → the line reads "On (authenticator app…)" and,
   where the button would be, "Sign in with your authenticator app or a
   passkey to use this." `POST …/two-factor/reset` by hand answers 403 with
   that sentence.
2. Sign out; sign in with a passkey (or email + password + code): the button
   is there. A throwaway customer with TOTP on in `testing.fairsums.app` →
   Turn off → the dialog's button stays disabled until the address matches
   (any case) → Turn off. `aws cognito-idp admin-get-user --user-pool-id
   <customer pool> --username <sub>` shows no `UserMFASettingList`; the
   drawer reads "Off"; User Management → Audit log has a
   `customer_two_factor_reset` row with `methodsBefore`. The customer signs
   in to `testing.fairsums.app` with the password alone and sees the
   "turned off by FairSums support" notice; re-enrolling clears it.
3. Refresh the tab after five minutes (the id token has rolled over): the
   button is still offered — the method survived the refresh.
4. Five resets inside an hour from one operator: the sixth is 429 with
   `Retry-After`; the drawer shows the usual rate-limit message.
5. With a task role lacking the permission (or a local profile without it):
   503 `cognito_unavailable`, a `customer_two_factor_reset_failed` audit row,
   nothing changed at Cognito.

## Phase D — Tests and docs (small)

- Unit tests with a mocked Cognito client for the new server paths (the
  console has no test runner today; add the same minimal `node --test` /
  vitest setup the web app uses — check which — rather than a new
  framework).
- `docs/auth.md`, `docs/access-control.md` (step-up rule for the customer
  action), `docs/api.md`, `docs/customers.md`, `CLAUDE.md` line 24.

## Order, effort, owner steps

| # | Phase | Size | Owner steps |
|---|---|---|---|
| A | Passkeys count as two factors | small | deploy; stage test |
| C | Customer two-factor reset | medium | run SQL for the endpoint grant; deploy (IAM) |
| B | QR code + operator recovery codes | medium | run SQL 022; `prisma db pull` (admin config); deploy (IAM) |
| D | Tests and docs | small | — |

A first (it closes the live lockout). C before B because it is the support
path the web app's recovery codes assume exists. Phases 3–7 of the web plan
(re-authentication, security emails, two-step sign-in, require-2FA, device
remembering, risk-based) are not planned for the console yet; the
"operator must use a second factor" guard in C is the one step-up rule it
gets now.
