# Two-factor authentication — admin console plan

**Status: approved by the owner on 2026-10-04** (order A → C → B → D; the
issuer label becomes "FairSums Admin"; the operator step-up rule in phase C
is in). Phase A live on stage and verified 2026-10-04 (operator account lists WEB_AUTHN_MFA beside SOFTWARE_TOKEN_MFA; passkey and password+code both sign in). Phase C verified on stage 2026-10-04. Phase B verified on stage 2026-10-05. Phase D built 2026-10-04: `npm test` covers the server paths of A, B and C (132 tests); docs brought up to date. **All four phases complete.**

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

*Phase B verified on stage 2026-10-05:* QR enrolment, ten codes shown once (after the table-ownership fix — the table had been created by pgAdmin's role, 42501 for the app; SQL 022 now aligns the owner), regenerate refused on a wrong password and issued ten new codes on the right one, a recovery code signed the operator in and cleared both factors (`UserMFASettingList` null; log `two-factor authentication turned off with a recovery code`). The shared five-per-15-minutes password budget was hit during the test and behaved as designed. **Admin phases A–D complete.**

*Phase B built 2026-10-04* (after C, so it took SQL **022**):

- **QR code**: antd `QRCode` (SVG, 180 px, level M) over the existing
  `otpauth://` URI in `two-factor-section.tsx`, caption "Scan with your
  authenticator app, or enter the key below."; the secret and the link stay
  as copyable text.
- **Table**: `docs/sql/022_admin_user_recovery_codes.sql` —
  `admin_user_recovery_codes` (`id`, `user_id` → `admin_users.id` ON DELETE
  CASCADE, `code_hash` CHECK 64 lowercase hex, `created_at`, `used_at`;
  unique `(user_id, code_hash)`, index on `user_id`, no RLS) plus the
  endpoint row `admin.me.mfa.recovery_codes` registered like 018's (no
  actions). **The code ships before the pull**: `src/lib/account/recovery-codes.ts`
  uses `$queryRaw`/`$executeRaw` tagged templates (pinned to one `user_id`,
  no string concatenation) with a comment to switch to the typed model after
  the pull; until the table exists the reads answer "no codes", a claim
  answers "no such code", and one warning names the SQL file.
- **Codes**: `recovery-codes.ts` (generate / format / normalise / hash,
  replace, summarise, claim / unclaim, delete others, delete all,
  `hasRedeemedRecoveryCode`, `findEnabledOperatorBySub`);
  `src/lib/account/recovery.ts` is where the pool's answer and the rows meet
  (`service.ts` stays Cognito-only). `PUT …/mfa/totp` answers
  `issuedRecoveryCodes` once (null when the write failed — the enrolment
  stands); `GET …/mfa` adds `recoveryCodes: { remaining, total, usedAt }`
  (`MfaStatusView` in `types.ts`); `DELETE …/mfa/totp` deletes the rows after
  Cognito accepted; new `POST …/mfa/recovery-codes` (`{ password }`,
  `verifyPasswordForSensitiveAction` ported into `src/lib/auth/cognito.ts`,
  the session's allowlist address, `authLoginAccount` per email +
  `accountMfa` per operator + `authReset` per IP, 401 `password_incorrect`,
  422 while TOTP is off). Registry entry added.
- **Drawer**: the once-only codes dialog (monospace grid, Copy, Download
  `fairsums-admin-recovery-codes.txt`, "I've saved my codes" as the only
  exit), the "Recovery codes — N of 10 left" row with "Generate new codes"
  behind the password dialog, and the banner while TOTP is off and rows
  remain (`used_at` → "turned off with a recovery code on <date>", unused
  rows → "turned off by support").
- **Shell nudge**: the `(app)` layout already resolves the principal, so it
  gained one admin-database read, `hasRedeemedRecoveryCode(principal.user.id)`
  (never a Cognito call on a render; a missing table or a fault is `false`),
  passed to `AppShell` as `twoFactorResetPending`; `TwoFactorResetNotice`
  (`src/components/shell/two-factor-reset-notice.tsx`) is an antd
  notification with an "Open Account & security" button, on every full load
  until the next enrolment, not remembered in `localStorage`.
- **Redeem at sign-in**: "Use a recovery code instead" on the code step →
  a third step with its own rc-form store (`key="recovery"`: address read-only, password,
  code, "Back to the authenticator code", "Start over") →
  `redeemRecoveryCode` in `src/app/login/actions.ts`: validation → the
  sign-in pair + `authMfa` on `mfa:email:<address>`, each charged whatever
  the other answers (the code step charges `mfa:email:<pool username>`
  additively — the same key wherever the pool username is the address) →
  `decideRecoveryRedeem` in
  `src/lib/auth/recovery-redeem.ts` (password proof → `adminFindUser(email)`
  on the ADMIN pool, bound to the proven address with the email-attribute
  check → enabled `admin_users` row by `cognito_sub` → atomic claim →
  `adminTurnOffSecondFactor` both settings off, claim undone on refusal →
  delete the other nine best-effort → `signInWithPassword`) →
  `createSession(tokens, undefined, "password")` → `redirect("/")`, fallback
  `/login?recovery=used` with the notice "Two-factor authentication was
  turned off with a recovery code. Sign in with your password, then set it
  up again in Account & security." One neutral error for a wrong password /
  unknown or disabled account / wrong code; a generic one for an AWS or
  database fault. `src/lib/auth/cognito-admin.ts` is the only module that
  addresses the admin pool with AWS credentials.
- **IAM**: no existing policy granted anything on the admin pool (operators
  are invited with the CLI, not the console), so a sibling policy
  `operator-recovery` / Sid `AdminPoolRecoveryOnly` was added to the task
  role with `cognito-idp:AdminGetUser` and `AdminSetUserMFAPreference` on
  the admin pool ARN, built from the same SSM parameters the task definition
  reads (`{{resolve:ssm:…ADMIN_COGNITO_REGION}}` and `…USER_POOL_ID`; the
  environment stack exports an ARN only for the customers' pool). No
  Description change.
- **Rate limits**: `authMfa` (10 / 15 min) and `accountMfa` (10 / 15 min)
  added; nothing removed. *2026-10-06 (owner, both apps):* the sign-in budgets
  count failed attempts only — a successful check refunds its slot
  (`refundRateLimit()`; `authMfa` on an accepted code, the sign-in pair on an
  accepted password; `accountMfa` and `customerTwoFactorReset` stay
  per-operation and are never refunded). See `auth.md` and `api.md`.
- **Tests**: `npm test` — the consumer app's `node --test` setup
  (`scripts/test-loader.mjs`, `--conditions=react-server`) covering the pure
  code helpers, `adminFindUser` / `adminTurnOffSecondFactor` against a
  stubbed pool, and the redeem ordering against a scripted gateway
  (`recovery-redeem.test.ts`).
- **Docs**: `auth.md` ("Use a recovery code instead", "Recovery codes"),
  `api.md`, `sql/README.md` (row 22), `CLAUDE.md`.
- Not run locally: the admin calls need AWS credentials with the new
  permission, and the table does not exist until 022 has run; the drawer
  and the sign-in form were exercised through the type check, the lint and
  the build only.

Owner steps: run `022_admin_user_recovery_codes.sql` on the local and stage
admin databases — the file now ends with a `DO` block that hands the table
to the role that owns `admin_users` (the stage test of 2026-10-04 found the
table owned by pgAdmin's role, so the app's role got `42501 permission
denied` on every query: the drawer was a 500, enrolment showed no codes,
"Generate new codes" failed); **if 022 was run before this line was added,
run the `DO` block alone** and check the verify query's two `tableowner`
values match; `npx prisma db pull --config prisma-admin.config.ts && npx
prisma generate` (then, optionally, switch `recovery-codes.ts` to the typed
model); deploy (the IAM policy rides the push to stage); for a local run,
give the AWS profile `cognito-idp:AdminGetUser` and
`AdminSetUserMFAPreference` on the admin pool.

Stage test (`admin.fairsums.app`, a throwaway operator account, after deploy):

1. Enrol: the drawer shows the QR code, then ten codes; Copy and Download
   work; the row says "10 of 10 left".
2. Sign out; email + password; "Use a recovery code instead"; wrong password
   + right code → neutral error; right password + a code with `O` typed for
   `0` → "Enter the ten-character recovery code."; right password + a wrong
   code → neutral error; eleven tries → "Too many attempts".
3. Right password + right code → signed in, the shell notice appears, the
   drawer shows the banner, `admin-get-user` on the admin pool shows
   `UserMFASettingList` empty, the table holds one row with `used_at`; the
   customer two-factor reset reads the session as password-only.
4. Enrol again → ten new rows, banner and notice gone, `WEB_AUTHN_MFA` back
   beside `SOFTWARE_TOKEN_MFA` when a passkey exists.
5. "Generate new codes" with a wrong password → 401 and the field error;
   right password → ten new codes, the old ones refused at sign-in.
6. Turn the authenticator off from the drawer → zero rows.
7. CLI `admin-set-user-mfa-preference … Enabled=false` on an enrolled
   account → the "turned off by support" banner; enrol again.
8. With a task role lacking the permission: the neutral-looking "couldn't
   be turned off right now" message, the log naming
   `cognito-idp:AdminSetUserMFAPreference` and `operator-recovery`, and the
   code still unused in the table.

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

*Phase C verified on stage 2026-10-04:* SQL 021 run; operator signed in with a passkey saw the button, a password-only session would see the sentence; the throwaway customer's two-factor was turned off (`UserMFASettingList` null, log `[customers] two-factor authentication turned off for sub …`). **Phase C complete.** Phase B next.

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

*Phase D built 2026-10-04.* The runner is phase B's `node --test` setup
(`npm test`, `scripts/test-loader.mjs`, `--conditions=react-server`); 37
tests in 3 files became 132 in 8. Every test stubs the pool or a gateway and
loads no module that imports `next/headers`, the pattern `recovery-redeem.ts`
set. The inventory:

| File | What it covers |
| --- | --- |
| `src/lib/account/passkey-mfa.test.ts` | Phase A, `ensurePasskeyMfa`: the flag is set only for TOTP on + at least one passkey + flag off; supplied facts are not re-read and the status read's own passkey answer is reused; a refused set answers `passkeySignInPaused`; a failed read or list answers unchanged; nothing throws. `isPasskeyMfaListed` matches `WEB_AUTHN_MFA` (any case) and not `SOFTWARE_TOKEN_MFA`. |
| `src/lib/customers/two-factor.test.ts` | Phase C, `resetCustomerTwoFactor`: 403 for a `password` session before any other work and without spending the budget; five an hour per operator with the sixth 429 before Cognito is asked (the real in-process limiter, a fresh operator id per test); 404; 503 `cognito_unavailable` when the pool is unconfigured; the read-before / reset / re-read / audit order and the answer; the done and failed audit rows (`methodsBefore`, `methodsAfter`, `reason`); a throwing audit write never fails the reset or hides a refusal; a non-`ApiError` becomes 503. `describeTwoFactor`, `operatorCanResetTwoFactor`. `resetTwoFactor` / `readTwoFactor` against a stubbed pool: both settings off in one `AdminSetUserMFAPreference` addressed by the sub, the list-to-methods mapping, 404 / 503 translation with the AWS message kept out of the response. |
| `src/lib/auth/sign-in-method.test.ts` | Phase C, the `psa_sign_in_method` cookie: round trip for the three methods; a forged value, a value signed for another `sub` or `origin_jti`, an unknown method with a real signature, and a wrong-length signature (the constant-time compare does not throw) all read as `password`; a payload without `origin_jti` reads as `password` and a token without one gets no cookie; the key is derived from `ADMIN_COGNITO_CLIENT_SECRET` (a rotated secret invalidates) with the per-process fallback. |
| `src/lib/account/recovery.test.ts` | Phase B gaps: `issueRecoveryCodesAfterEnrolment` and `clearRecoveryCodesAfterDisable` never throw — a failed write or delete is logged, a failed summary read answers the empty summary; `regenerateRecoveryCodes`: the order, 401 `password_incorrect` (wrong and temporary password), 503 `auth_unavailable` (outage, `CognitoConfigError`), 422 while the app is off, a missing table (P2021, and P2010 / 42P01 from a raw query) → 503 `admin_schema_missing`. |
| `src/lib/auth/cognito.test.ts` | Phase B, `verifyPasswordForSensitiveAction`: one `USER_PASSWORD_AUTH` with the SECRET_HASH over the address (none without a secret); tokens → proof `tokens`; `SOFTWARE_TOKEN_MFA` and the other second-factor challenges → proof `challenge`, unanswered; `NEW_PASSWORD_REQUIRED` and an unknown challenge → failure `challenge`; the credential verdicts → `incorrect`; a throttle, a network fault or an empty answer → `unavailable`; the password is never logged. |
| `src/lib/account/recovery-codes.test.ts` | Phase B (existing): the alphabet, generation, display, normalisation, hashing. |
| `src/lib/auth/cognito-admin.test.ts` | Phase B (existing): `adminFindUser` (the address binding) and `adminTurnOffSecondFactor` against a stubbed admin pool. |
| `src/lib/auth/recovery-redeem.test.ts` | Phase B (existing): the order of a recovery-code sign-in against a scripted gateway. |

Seams added for the tests, each an optional trailing parameter whose default
is the real thing, so no caller and no behaviour changed: `PasskeyMfaGateway`
on `ensurePasskeyMfa`; `TwoFactorResetGateway` on `resetCustomerTwoFactor`
and `describeTwoFactor` (the rate limiter stays real) and `CustomerPoolAccess`
on `readTwoFactor` / `resetTwoFactor` (the twin of `PoolAccess` in
`cognito-admin.ts`); `RecoveryGateway` on the three `recovery.ts` functions;
`PasswordCheckClient` on `verifyPasswordForSensitiveAction`. The sign-in
method constants and the cookie's HMAC helpers moved verbatim from
`session.ts` into `src/lib/auth/sign-in-method.ts` (which imports no
`next/headers`); `session.ts` re-exports the public names and
`customers/two-factor.ts` imports from the new module.

What is **not** covered without a live pool (the stage tests above remain the
check for these): Cognito's own acceptance or refusal of the calls (the
same-request rule for `WebAuthnMfaSettings`, the combined off-call, the
`MULTI_FACTOR_WITH_USER_VERIFICATION` requirement); the passkey ceremonies
(not from `localhost`); the Route Handlers and `adminHandler` (auth, CSRF,
the access-map rule, the per-IP budgets and `authLoginAccount` /
`accountMfa` charged by the recovery-codes route); the Server Actions in
`src/app/login/actions.ts` (`verifyMfaCode`'s `ensurePasskeyMfa` call,
`redeemRecoveryCode`'s validation and budgets, the `createSession` methods);
`createSession`, `verifyIdToken` and `refreshSession` (they need
`next/headers` and the pool's JWKS); the raw-SQL half of
`recovery-codes.ts` (the atomic claim, the missing-table reads before SQL
022); the drawer, the shell notice and the login form; the two IAM policies;
the audit table's check constraint (SQL 021).

## Order, effort, owner steps

| # | Phase | Size | Owner steps |
|---|---|---|---|
| A | Passkeys count as two factors | small | deploy; stage test |
| C | Customer two-factor reset | medium | run SQL for the endpoint grant; deploy (IAM) |
| B | QR code + operator recovery codes | medium | run SQL 022; `prisma db pull` (admin config); deploy (IAM) |
| D | Tests and docs | small | — (built 2026-10-04) |

A first (it closes the live lockout). C before B because it is the support
path the web app's recovery codes assume exists. Phases 3–7 of the web plan
(re-authentication, security emails, two-step sign-in, require-2FA, device
remembering, risk-based) are not planned for the console yet; the
"operator must use a second factor" guard in C is the one step-up rule it
gets now.
