# Sign-in and sessions

The console uses its **own** Cognito user pool, separate from the consumer
app's. Region, pool id, client id and (optionally) the client secret come from
`.env`; `src/lib/auth/config.ts` reads `ADMIN_COGNITO_*` first and falls back
to the `COGNITO_*` and `NEXT_PUBLIC_COGNITO_*` spellings.

## Two-factor authentication — overview

The pieces, each described in its own section below or in a sibling guide,
and where each stands as of 2026-10-04 ([`two-factor-plan.md`](./two-factor-plan.md)
is the plan and the build log):

| Piece | What it is | Status |
| --- | --- | --- |
| [Passkey MFA](#passkey-mfa-2026-10-04) | a passkey counts as both factors for an operator with the authenticator app on; `ensurePasskeyMfa()` sets the per-user flag at enrolment, passkey registration and TOTP sign-in | phase A — built and verified on stage 2026-10-04 |
| [Recovery codes](#recovery-codes), redeemed with [Use a recovery code instead](#use-a-recovery-code-instead) | ten single-use codes issued at enrolment; one of them, with the password, turns the factor off on the admin pool at `/login` | phase B — built 2026-10-04; the owner steps (SQL 022, `prisma db pull`, deploy) and the stage test are pending |
| [The sign-in method cookie](#the-session) | `psa_sign_in_method`, signed against the id token's `sub` and `origin_jti`, says whether the session was signed in with a second factor; older sessions and bearer callers read as `password` | phase C — built and verified on stage 2026-10-04 |
| The customer reset ([customers.md](./customers.md)) | support turns a customer's two-factor authentication off on the customer pool; the step-up guard is that cookie | phase C — built and verified on stage 2026-10-04 |

`npm test` covers the server-side rules of all four against stubbed pools and
gateways (phase D, 2026-10-04); what still needs a live pool is listed in the
plan.

## Sign-in

`/login` is a Server Action (`src/app/login/actions.ts`) calling Cognito's
`USER_PASSWORD_AUTH` flow through `src/lib/auth/cognito.ts`. Before Cognito is
asked, two rate limits apply: per client IP (skipped when the IP is unknown,
see below) and per email address (5 attempts per 15 minutes). Wrong password
and unknown user share one message; the server log keeps the distinction.

Both budgets count failed attempts only — a successful check refunds its slot
(owner, 2026-10-06, both apps). The charge is still made before Cognito is
asked; once Cognito accepts the password — tokens, `NEW_PASSWORD_REQUIRED` or
`SOFTWARE_TOKEN_MFA` — the attempt gives both charges back
(`refundRateLimit()` in `src/lib/security/rate-limit.ts`; which verdicts count
is `src/lib/auth/sign-in-refund.ts`). A wrong password, an unknown account, an
outage or a throttle keeps them spent, so a guess still costs one and an
honest sign-in costs nothing.

Cognito requirements on the app client: `ALLOW_USER_PASSWORD_AUTH`, token
revocation on, and the client secret in `.env` if the client has one.
`ALLOW_REFRESH_TOKEN_AUTH` is no longer needed — refreshes go through
`GetTokensFromRefreshToken` (see [Refresh](#refresh)), which works with the flow
removed and with refresh-token rotation enabled.

Sign-in is a **two-step** form (`login-form.tsx`). Step one is always email and
password; what Cognito answers decides whether there is a step two:

| Cognito's answer | What happens |
| --- | --- |
| tokens | the session is written and the browser goes to `/` |
| `NEW_PASSWORD_REQUIRED` | step two: [set your own password](#invited-operators-new_password_required) |
| `SOFTWARE_TOKEN_MFA` | step two: [the six-digit code](#two-step-verification-at-sign-in) |
| anything else | one message: "this account requires an extra step … that isn't supported yet" |

Both second steps carry Cognito's opaque `Session` continuation token in a
hidden form field — never in the URL, so it stays out of history, logs and
referrers. It is single-use and lives about three minutes; when it expires the
form falls back to step one and says why. "Start over" does the same on demand.

Under the password button, step one also offers
[signing in with a passkey](#signing-in-with-a-passkey) — a different flow with
the same ending.

## Invited operators (`NEW_PASSWORD_REQUIRED`)

Operators are created in the admin pool with `AdminCreateUser`, so their first
sign-in uses the temporary password Cognito emailed and comes back as the
`NEW_PASSWORD_REQUIRED` challenge rather than as tokens. `completeInvitation()`
in `src/app/login/actions.ts` answers it with `RespondToAuthChallenge`, and
only then is a session created — the account is not usable until the person
has their own password.

If the pool marks standard attributes as required, Cognito lists them in
`ChallengeParameters.requiredAttributes` and refuses the challenge without
them. `src/lib/auth/required-attributes.ts` is the single description of what
the step may ask for: the Client Component renders one input per entry, the
Server Action re-validates every value against the same rules, and
`src/lib/auth/cognito.ts` refuses the challenge outright (with a "contact
support" message) if the pool asks for something with no sensible input, rather
than inventing a value. `locale` is filled in from the browser and never shown;
`email` is dropped, because whoever ran `AdminCreateUser` already set it.

The module is a port of the consumer app's
(`../penny-squeeze-web/src/lib/auth/required-attributes.ts`) — keep the two in
step.

Rate limiting is the sign-in budget, not a separate one: the second step
finishes an authentication, so it must not be a way around the per-IP and
per-address limits. An accepted new password refunds the pair (failed
attempts only); a refused one, or a dead session, keeps it spent.

## Two-step verification at sign-in

When the operator has an authenticator app registered, `InitiateAuth` answers
`SOFTWARE_TOKEN_MFA` instead of issuing tokens. The form shows a six-digit code
step and `verifyMfaCode()` answers it with `RespondToAuthChallenge`
(`ChallengeResponses.SOFTWARE_TOKEN_MFA_CODE`, plus the SECRET_HASH when the
app client has a secret). A wrong code lands under the input and the same
session is usually worth another try; once Cognito retires the session the form
returns to step one. Same budget again: a code guess costs a sign-in attempt —
and an accepted code refunds it, together with the `authMfa` slot below
(failed attempts only, owner 2026-10-06).

The pool's `MfaConfiguration` is `OPTIONAL` with software tokens enabled, so
this branch is live: anyone who enrols an app in
[Account & security](#authenticator-app) gets the code step from then on.

Since phase B of [`two-factor-plan.md`](./two-factor-plan.md) the code step
also charges `authMfa` on `mfa:email:<pool username>` — the budget it shares
with the recovery-code step below — on top of the sign-in budget.

### Use a recovery code instead

Under the code step's button, **Use a recovery code instead** swaps the step
for a third step with its own form: the address read-only, the **password** again, and one of
the ten [recovery codes](#recovery-codes) the operator saved when they set
the authenticator up. "Back to the authenticator code" swaps back; the
Cognito challenge itself is untouched and its session is not sent.

`redeemRecoveryCode()` in `src/app/login/actions.ts` takes the password and
the code **in one request** (the design is the consumer app's
`docs/recovery-codes.md`, section 3): the password is proven by
`InitiateAuth` right there and held nowhere else, so a recovery code alone
can never switch two-factor off and there is no cookie or token to steal or
replay. The order, which `src/lib/auth/recovery-redeem.ts` owns and
`npm test` covers:

1. **Validate** — address, password length, and the code normalised
   (lowercased, everything outside the 31-symbol alphabet dropped; not ten
   symbols → "Enter the ten-character recovery code.").
2. **Rate limits**, charged whatever the outcome — each one even when the
   other refuses: the sign-in pair (`authLogin` per IP, `authLoginAccount`
   per email) because a password is checked, and `authMfa` on
   `mfa:email:<address>` — the address the password is about to be proven
   for, never the hidden `username` the browser posted; the same key the
   code step uses wherever the pool username is the address. Failed attempts
   only (owner, 2026-10-06): a proven password refunds the sign-in pair
   whatever follows, and a code that matched an unused row refunds `authMfa`
   even if Cognito then refused the switch-off — so a wrong code after a
   right password refunds the pair and keeps the `authMfa` slot spent, and a
   wrong password, an outage or a throttle refunds nothing. The action reads
   both facts from the gateway calls, because the `neutral` outcome below
   deliberately does not say which half failed.
3. **Password** — `verifyPasswordForSensitiveAction()` in
   `src/lib/auth/cognito.ts`: a bare `USER_PASSWORD_AUTH` whose
   `SOFTWARE_TOKEN_MFA` challenge counts as proof and is left unanswered.
   Tokens (no second factor asked: the factor is already off) and
   `NEW_PASSWORD_REQUIRED` both send the form back to step one.
4. **Who** — `AdminGetUser` by **the address the password was just proven
   for**, never by the hidden `username` the browser posted, and the answer's
   `email` attribute is compared with it (`adminFindUser()` in
   `src/lib/auth/cognito-admin.ts`); then the enabled `admin_users` row by
   `cognito_sub`.
5. **Claim the code first** — one atomic `UPDATE … WHERE used_at IS NULL`,
   so two requests carrying the same code cannot both pass.
6. **Cognito off** — `adminTurnOffSecondFactor()`: `AdminSetUserMFAPreference`
   on the **admin** pool with the authenticator app and passkey MFA both off,
   signed with the task role's `operator-recovery` policy. A refusal puts the
   code back and answers "Two-factor authentication couldn't be turned off
   right now. Try again in a moment."
7. The other nine rows are deleted (best effort); the redeemed one stays as
   the record the drawer banner and the shell nudge are derived from.
8. **Sign in** with the same password — tokens now — and `createSession(…,
   "password")`: a password-only session, so the customer two-factor reset
   refuses it until the operator enrols again. Should Cognito still answer a
   challenge, `/login?recovery=used` explains and the password alone works.

One neutral sentence covers a wrong password, an unknown or disabled account
and a wrong code — "That password or recovery code isn't right. Check both
and try again." — and every path spends the same budgets, so the recovery
form is no cheaper an oracle than the code step. Logging names ids and
Cognito error names only; never the address, the password, the code or its
hash.

## Signing in with a passkey

Under the password button, step one offers **Sign in with a passkey**. It uses
the email address already typed in the form — a passkey is bound to an account,
so Cognito needs to know which one before it can produce a challenge — and
nothing else. The password field is not validated on this path.

It is Cognito's **choice-based** (`USER_AUTH`) flow, in two Server Actions with
the browser's authenticator prompt between them. Both live in
`src/app/login/actions.ts`; the Cognito half is `startWebAuthnSignIn()` and
`respondToWebAuthnChallenge()` in `src/lib/auth/cognito.ts`, and the encoding
half is `getPasskeyAssertion()` in `src/lib/account/webauthn.ts` — the mirror of
the registration helper next to it.

1. **`startPasskeySignIn(email)`** → `InitiateAuth`,
   `AuthFlow: "USER_AUTH"`, `AuthParameters: { USERNAME, PREFERRED_CHALLENGE:
   "WEB_AUTHN", SECRET_HASH }`. Cognito answers `ChallengeName: "WEB_AUTHN"`
   with a `Session` and `ChallengeParameters.CREDENTIAL_REQUEST_OPTIONS`, a JSON
   *string* holding a WebAuthn `PublicKeyCredentialRequestOptionsJSON`.
   If it answers `SELECT_CHALLENGE` instead, the action makes the choice
   explicit with `RespondToAuthChallenge(ChallengeName: "SELECT_CHALLENGE",
   ChallengeResponses: { USERNAME, ANSWER: "WEB_AUTHN", SECRET_HASH })` and gets
   the `WEB_AUTHN` challenge (and a fresh session) back.
2. The options, the session and the **pool username** Cognito named
   (`USER_ID_FOR_SRP`) go to the browser. The session is held in the page's
   memory and posted back in the action's payload — never in the URL, the same
   discipline as the invitation and MFA steps' hidden fields.
3. The browser runs `navigator.credentials.get()` and the assertion is
   serialised as a WebAuthn `AuthenticationResponseJSON`
   (`parseRequestOptionsFromJSON` / `credential.toJSON()` where the browser has
   them, a hand-rolled base64url pass where it does not).
4. **`completePasskeySignIn`** → `RespondToAuthChallenge(ChallengeName:
   "WEB_AUTHN", Session, ChallengeResponses: { USERNAME, CREDENTIAL: <json>,
   SECRET_HASH })`. Tokens come back and the session is written exactly as on
   the password path — same five cookies, same redirect to `/`, same allowlist
   check afterwards by the authenticated layout.

Every call carries `SECRET_HASH`, because the app client has a secret, and it is
always computed over the username actually being sent: the typed address on the
first call, the pool username Cognito handed back on the ones after it.

Cognito is the relying party throughout. This app never sees the private key,
never validates a signature, and forwards the assertion untouched; all it checks
is that the payload is JSON of a sane size (8 KB,
`MAX_PASSKEY_CREDENTIAL_LENGTH`).

Both actions charge the sign-in budget — per IP and per email address, the same
`authLogin` / `authLoginAccount` policies as a password attempt — because both
are steps of an authentication and neither may become a way around the limits.
(The second leg charges `authPasskey` per account in place of
`authLoginAccount`.) Failed attempts only (owner, 2026-10-06): a verified
assertion refunds both legs' charges — this leg's IP and `authPasskey` slots
and the pair the first leg spent for the same address. The first leg refunds
nothing on its own, since it proves nothing: a ceremony that is abandoned, or
started for an address with no passkey, stays counted.

### What can go wrong

| Situation | What the person sees |
| --- | --- |
| The browser has no WebAuthn (`window.PublicKeyCredential` undefined) | no button at all |
| The email box is empty | "Email is required", the app's usual missing-field summary |
| Unknown address, or an account with no passkey (Cognito offers `PASSWORD`, or refuses with `UserNotFoundException` / `NotAuthorizedException`) | one message: "We couldn't start a passkey sign-in for that email address. Sign in with your password instead." |
| The person dismisses the system prompt (`NotAllowedError` / `AbortError`) | nothing. No request is sent and the form is untouched |
| The browser refuses for its own reason — most often a relying-party mismatch on `localhost` | the browser's own sentence, under "Your browser could not use a passkey for this site." |
| The challenge session expired or was already used (`WebAuthnChallengeNotFoundException`, `NotAuthorizedException`) | "Your sign-in session expired. Start again." — the form never left step one, so pressing the button again is the whole recovery |
| The origin is not the pool's relying party (`WebAuthnOriginNotAllowedException`, `WebAuthnRelyingPartyMismatchException`, `WebAuthnClientMismatchException`) | "This site is not an allowed origin for the pool's passkey settings." |
| Passkeys are off for the pool (`WebAuthnConfigurationMissingException`, `WebAuthnNotEnabledException`, `FeatureUnavailableInTierException`) | "Passkey sign-in is not enabled for this console yet." |
| `USER_AUTH` is missing from the app client's auth flows | "Passkey sign-in is not configured for this client." |
| Either sign-in limit is hit | the usual "Too many attempts. Please wait and try again." |

Unknown address and "no passkey registered" deliberately share one message. The
password path's neutral wording exists for the same reason, and here it matters
more: there is no secret in the request, so a distinguishable answer would turn
the button into a free account-existence oracle.

> **It does not work on `localhost`.** A pool has exactly one WebAuthn relying
> party id and the admin pool's is `admin.fairsums.app`. A browser refuses to
> use a credential whose relying party does not match the page's host, so on
> `http://localhost:3001` the button fails with the *browser's* error before
> Cognito is ever asked — nothing is misconfigured in the app. Test it on a
> deployed host, or point a development pool's relying party at `localhost`.

## The session

On success six httpOnly cookies are written (`src/lib/auth/session.ts`), and
every one of them is dated from the tokens themselves:

| Cookie | Path | Lifetime | Holds |
| --- | --- | --- | --- |
| `psa_id_token` | `/` | the id token's own `exp` minus 60 s | the id token: the credential every check verifies |
| `psa_access_token` | `/` | the access token's own `exp` minus 60 s | the access token, for the Account & security calls |
| `psa_session` | `/` | id token `exp` + 30 minutes | a marker saying a refresh token exists |
| `psa_sign_in_method` | `/` | id token `exp` + 30 minutes | how this session was signed in — `password`, `password+totp` or `passkey` — with an HMAC binding it to the token's `sub` and `origin_jti` |
| `psa_refresh_token` | `/api/auth` | id token `exp` + 30 minutes | the refresh token |
| `psa_refresh_proof` | `/api/auth` | id token `exp` + 30 minutes | the id token just issued — the proof of when this browser was last active |

Each token cookie gets its *own* expiry, never the response's `ExpiresIn`: that
field describes the access token, and the pool gives the id and access tokens
different validities (5 and 15 minutes once the planned settings are applied).

**The sign-in method (2026-10-04).** Each of the three sign-in paths in
`src/app/login/actions.ts` tells `createSession` how it authenticated: the
plain password step (and the invitation's set-password step) write
`password`, the authenticator-code step `password+totp`, the passkey assertion
`passkey`. The value is surfaced as `Session.signInMethod` and read by the one
action that insists on a second factor — turning off a customer's two-factor
authentication ([access-control.md](./access-control.md), "Step-up"). It was
chosen over the id token's `amr` claim, which the pool is not known to emit.
The cookie is signed in `src/lib/auth/sign-in-method.ts` (HMAC-SHA256 over
`sub`, `origin_jti` and the method;
an id token without `origin_jti` — a client with token revocation off — gets
no cookie and reads as `password`)
with a key derived from `ADMIN_COGNITO_CLIENT_SECRET`, so every deployed task
verifies what another signed; without a client secret (a local `.env`) the key
is random per process, and a restart makes the session read as `password`
until the next sign-in. The cookie fails closed: an unverifiable or missing
value — a session minted before it existed, a bearer-token caller — is
`password`. The refresh endpoint reads it against the proof token it was
signed for and re-signs it against the new id token, so a refresh never loses
or weakens it.

`psa_refresh_user` is no longer written. `GetTokensFromRefreshToken` needs no
username, so there is nothing for it to carry; the name is still in
`SESSION_COOKIES` so sign-out and the expiry paths keep deleting the copies
left in older cookie jars.

The `psa_` prefix differs from the consumer app's `ps_` on purpose: browsers do
not separate cookies by port, so on localhost both apps would otherwise
overwrite each other's session.

Every page render verifies the id token's signature, issuer, audience and
expiry against the pool's JWKS (`verifySession`). Nothing trusts the cookie's
presence alone.

## Session lifetime: 30 minutes idle, never while working

The policy is one sentence: **a browser is signed out after 30 minutes without
activity, and never while the operator is working.** Cognito cannot do this on
its own — it has no idle timeout, a refresh token has a fixed absolute validity
measured from sign-in, and rotation does not extend it — so the sliding window
is the app's, built out of three layers that share
`IDLE_TIMEOUT_SECONDS` in `src/lib/auth/cookies.ts`.

1. **The cookies slide.** The marker, the refresh token and the proof are
   rewritten on every refresh with a lifetime of "id token expiry + 30
   minutes". A browser left alone therefore throws its own refresh token away
   half an hour after the last one it was given.
2. **The server enforces it.** Before `refreshSession()` spends anything, it
   verifies `psa_refresh_proof` — the previous id token — against the pool's
   JWKS with `graceSeconds: 30 minutes`. A token can only ever have been issued
   to a browser that was there, so "its `exp` is less than 30 minutes old" is a
   Cognito-signed statement about the last activity, and nothing in the browser
   can forge it. Too old or not ours ⇒ the refresh token is revoked, every
   cookie is cleared, and the caller is told `session_idle`. The slack runs one
   way only: the window is 30 minutes plus at most one id token lifetime, never
   less than 30. A *missing* proof also ends the session, but it is no evidence
   of inactivity, so it is reported as an ordinary dead session (`refresh_failed`,
   a plain `/login`) rather than as a lunch break nobody took.
3. **The browser keeps an active session alive.** `SessionKeepalive`
   (`src/components/auth/session-keepalive.tsx`, mounted by the authenticated
   layout) records pointer, key, wheel, touch, scroll (in the capture phase —
   a table's scroll never reaches the window) and visibility events, and checks
   the clock every 15 seconds. It either renews the session — when the id token
   is within 120 seconds of expiring, which is the 60 s the id cookie is dropped
   early plus a tick plus margin — or signs out, when nothing has happened for
   30 minutes. Renewing ahead of time is what keeps a Server Action POST from
   ever bouncing to `/login` mid-form: the proxy can replay a GET through the
   refresh endpoint, but not a POST.

Three `localStorage` keys make the tabs of one browser act as one session:
`psa:last-activity` (the shared clock, so a tab left open never signs out
someone working next to it), `psa:id-expires-at` (the expiry any tab last saw,
so one tab's renewal spares the others theirs) and `psa:refresh-lock` (a 45 s
claim, so tabs coming due together do not all spend a Cognito call; the 60 s
rotation grace covers the rare overlap).

When `localStorage` cannot be written at all — a locked-down browser profile —
the keepalive goes **passive**: it never signs anybody out, because it cannot
know what the other tabs are doing, and simply stops renewing. The cookies then
lapse on their own within 30-35 minutes and the server refuses the next refresh,
so the policy still holds; only the redirect to the notice is lost.

The idle sign-out waits for `POST /api/auth/logout` (up to 5 seconds) before it
navigates. Only a 2xx — cookies confirmed gone — earns `/login?session=idle`; a
timeout, a network failure or a refusal goes to `/login?session=expired`, which
the proxy answers by deleting every session cookie and landing on a clean
`/login`. Navigating to the idle notice while the cookies were still valid would
only bounce back to `/` and restart the clock.

Sessions created before this was deployed have no proof cookie and get one
forced sign-in, on a plain `/login`. That is intended.

## Refresh

When the id token is gone:

- a **page** navigation is sent by the proxy to `GET /api/auth/refresh?next=…`,
  which spends the refresh cookie and redirects back;
- a **fetch** from a client component gets 401 `token_expired`; `apiFetch`
  calls `POST /api/auth/refresh` once and retries once;
- the **keepalive** calls the same endpoint before anything fails, through the
  de-duplicated `refreshSessionOnce()` in `src/lib/api/client.ts`, and takes
  the new `idTokenExpiresAt` from the answer.

The exchange itself is `GetTokensFromRefreshToken`
(`refreshTokens()` in `src/lib/auth/cognito.ts`), with the client secret and
**no username and no SECRET_HASH**. It replaced the `REFRESH_TOKEN_AUTH`
InitiateAuth flow because refresh-token rotation disables that flow, and it
works identically with rotation on and off: with rotation off the answer
carries no new refresh token and the one on file is re-set (which is what
slides its lifetime), with rotation on the new one replaces it. Presenting a
rotated-out token afterwards is `RefreshTokenReuseException` — logged as a
possible theft or a lost race, and treated as a dead session.

The outcomes:

| Outcome | HTTP (POST) | Navigation (GET) | Cookies |
| --- | --- | --- | --- |
| refreshed | 200 with `expiresIn`, `idTokenExpiresAt`, `userId`, `email` | 303 back to `next` | rewritten |
| idle (proof too old) | 401 `session_idle` | 303 to `/login?session=idle` | revoked at Cognito and cleared |
| idle (no proof cookie) | 401 `refresh_failed` | 303 to `/login` | revoked at Cognito and cleared |
| no refresh token / invalid | 401 `refresh_failed` | 303 to `/login` | cleared (GET also drops a stale marker) |
| Cognito unreachable | 503 `auth_unavailable` | 303 to `/login` | untouched |

A Cognito outage leaves every cookie in place; only a verdict — from Cognito
that the refresh token is dead, or from the proof cookie that the browser has
been idle — clears the session. `/login?session=idle` renders the notice
"You were signed out after 30 minutes of inactivity."

One exception to the "cleared" column: the `GET` is a top-level navigation, so
any page on the web can cause it and the `sameSite: "lax"` cookies ride along.
A **cross-site** GET may still refresh — a link from an email opened after the
id cookie lapsed is exactly that request, and it has to keep working — but an
idle verdict on one is only *reported*, never acted on: the redirect happens and
no cookie is touched, so no link on the web can force a sign-out. The next
same-site request reaches the same verdict and does the revoking. An expired
proof is logged at `info` (routine) and a forged or foreign one at `error`.

## Sign-out

The avatar menu submits a real form to `POST /api/auth/logout`, because the
refresh cookie only travels on a navigation to `/api/auth/*`. The route revokes
the refresh token at Cognito and clears every cookie. The keepalive's idle
sign-out `fetch`es the same route (which answers 204) and waits for the answer
before sending the browser to `/login?session=idle`, or to
`/login?session=expired` when the call did not succeed. Sign-out has its own
rate-limit budget (`authLogout`, 30 per 15 minutes) rather than a share of the
refresh one, so a browser that has burned through its refresh allowance can
still get its token revoked.

## Account & security

Everything an operator can change about their own sign-in lives in one drawer,
opened from the **Account & security** item in the avatar menu
(`src/components/account/account-security-drawer.tsx`). A drawer rather than a
page, deliberately: these are self-service settings, so a page would mean a
`page-registry.ts` entry and an Access Map rule, and every operator would have
to be *granted* the right to reach their own password.

Three sections, all of them live calls to the admin user pool made with the
operator's **access token** (`psa_access_token`, read by
`src/lib/auth/access-token.ts` — the id token cannot be used for these). Every
call acts on the caller's own account and on nothing else: Cognito derives the
subject from the token, so no request carries a user id and there is nobody
else to reach. Nothing is stored in either database; the pool is the record.

| Section | Cognito | Endpoint |
| --- | --- | --- |
| Password | `ChangePassword` | `POST /api/v1/admin/me/password` |
| Two-factor status | `GetUser` | `GET /api/v1/admin/me/mfa` |
| Start authenticator enrolment | `AssociateSoftwareToken` | `POST /api/v1/admin/me/mfa/totp` |
| Verify and turn on | `VerifySoftwareToken` + `SetUserMFAPreference` | `PUT /api/v1/admin/me/mfa/totp` |
| Turn off | `SetUserMFAPreference` | `DELETE /api/v1/admin/me/mfa/totp` |
| Generate new recovery codes | `InitiateAuth` (the password re-check) + `GetUser` | `POST /api/v1/admin/me/mfa/recovery-codes` |
| List passkeys | `ListWebAuthnCredentials` | `GET /api/v1/admin/me/passkeys` |
| Add a passkey | `StartWebAuthnRegistration` + `CompleteWebAuthnRegistration` | `POST` then `PUT /api/v1/admin/me/passkeys` |
| Remove a passkey | `DeleteWebAuthnCredential` | `DELETE /api/v1/admin/me/passkeys/[id]` |

All ten go through `adminHandler` and are registered in
`src/lib/admin-access/endpoint-registry.ts` and in
[`docs/sql/018_account_security_endpoints.sql`](./sql/018_account_security_endpoints.sql)
(the tenth in [`022`](./sql/022_admin_user_recovery_codes.sql))
with **no linked actions**, which the access map reads as "any enabled
operator" — the same way `admin.me` is registered. The password change and the
code verification also charge the `authReset` budget against the operator's id,
not only against the client IP, because the per-IP limit is switched off
whenever `TRUST_PROXY_HEADERS` is unset and neither may become an oracle.
"Generate new recovery codes" proves a password, so it charges
`authLoginAccount` per email and `accountMfa` per operator as well. The
`authLoginAccount` slot comes back once the password is proven, even if a
later rule then refuses (failed attempts only, owner 2026-10-06); a wrong
password or a Cognito outage keeps it spent. `accountMfa` and the `authReset`
budgets are per-operation and are never refunded.

**Changing a password does not sign other devices out.** Cognito leaves the
refresh tokens it has already issued alone; revoking them everywhere means
`AdminUserGlobalSignOut`, which needs AWS credentials rather than the user's
token. That is a deliberate follow-up, not something the form does quietly.

### Authenticator app

`AssociateSoftwareToken` mints a shared secret; the drawer shows it once, as
copyable text and as an `otpauth://totp/...` URI, and stores it nowhere. A
six-digit code then proves the app has it (`VerifySoftwareToken`), and only
after that does `SetUserMFAPreference` switch the factor on and make it
preferred. Abandoning the form simply abandons the secret: an unverified one
can never be used to sign in. The issuer shown in the authenticator app is
**"FairSums Admin"** since 2026-10-04 (owner decision; it was "Penny Squeeze
Admin"). Only new enrolments carry the new name — an entry already in
someone's app keeps the one it was created with.

Since phase B (2026-10-04) the URI is also drawn as a **QR code** with antd's
own `QRCode` component (no new dependency), rendered in the browser from the
URI the server returned, so the secret still travels exactly once; the secret
and the link stay as copyable text beneath it for a phone that cannot scan the
screen it is on.

### Recovery codes

Phase B of [`two-factor-plan.md`](./two-factor-plan.md), a port of the
consumer app's `docs/recovery-codes.md`. Cognito has no backup codes, so when
the authenticator app is turned on the console issues **ten single-use codes**
(`xxxxx-xxxxx`, ten symbols from a 31-symbol alphabet without `0`/`o`/`1`/`i`/`l`;
`src/lib/account/recovery-codes.ts`) and shows them **once**, in a dialog with
Copy and Download whose only exit is "I've saved my codes". SHA-256 hashes go
to `admin_user_recovery_codes`
([`docs/sql/022`](./sql/022_admin_user_recovery_codes.sql); `user_id` is
`admin_users.id`, no RLS, every query pinned to one operator); the clear code
is never stored or logged. Until that SQL has run the reads answer "no codes"
and one warning line names the file — the module uses raw, parameterised
queries so it ships before the schema pull, and switches to the typed model
after `npx prisma db pull --config prisma-admin.config.ts`.

- **One set at a time.** Enrolment (`PUT …/mfa/totp`) and **Generate new
  codes** (`POST …/mfa/recovery-codes`, behind the password — a bare
  `USER_PASSWORD_AUTH` whose second-factor challenge counts as proof;
  refused with 422 while the app is off) replace the set. Turning the app
  off deletes it. Enrolment never fails because of codes: a failed write is
  logged and the drawer offers "Generate them now".
- **The drawer** shows "Recovery codes — N of 10 left" under the
  authenticator row while the app is on, and a banner while it is **off and
  rows remain**: `used_at` set → "turned off with a recovery code on <date>",
  unused rows → "turned off by support" (a CLI `admin-set-user-mfa-preference`
  reset touches no row). The next enrolment clears both.
- **The shell nudge.** The `(app)` layout adds one admin-database read —
  `hasRedeemedRecoveryCode(admin_users.id)`, never a Cognito call on a render —
  and `AppShell` mounts `TwoFactorResetNotice`, an antd notification with an
  "Open Account & security" button on every full load until the rows are
  replaced. Not remembered in `localStorage`: it should keep coming back.
- **Redeeming** one is the sign-in form's business:
  [Use a recovery code instead](#use-a-recovery-code-instead).
- **IAM.** The redeem step signs two admin calls on the **admin** pool with
  the task role: `cognito-idp:AdminGetUser` and `AdminSetUserMFAPreference`,
  the `operator-recovery` policy in `infra/service-admin.yaml` (its own policy,
  because nothing else on that role names the admin pool). Locally, the AWS
  profile the console runs with needs the same two on the pool.

### Passkeys

Cognito is the WebAuthn relying party: it issues the challenge, and it verifies
the attestation, the origin and the challenge when the credential comes back.
This app converts encodings and nothing else —
`src/lib/account/webauthn.ts` uses the browser's own
`PublicKeyCredential.parseCreationOptionsFromJSON()` and `credential.toJSON()`
where they exist and hand-rolls the base64url pass where they do not — and
forwards the credential to Cognito untouched.

One thing it deliberately does not do:

- **Naming.** Cognito derives `FriendlyCredentialName` from the authenticator
  and neither WebAuthn call accepts a name, so the name typed in the form is
  used only in the confirmation message. A label of our own would need a table
  in the admin database; that is a follow-up.

*Using* one of these passkeys to sign in is the other half, and it is built:
see [Signing in with a passkey](#signing-in-with-a-passkey). The two ceremonies
share `src/lib/account/webauthn.ts` — `createPasskey()` for registration,
`getPasskeyAssertion()` for authentication — and nothing else.

### Passkey MFA (2026-10-04)

The rule, as Cognito applies it: a passkey is a **first** factor. An operator
with the authenticator app on is refused a passkey sign-in outright
(`NotAuthorizedException`, not a challenge) unless the pool's WebAuthn
configuration is `FactorConfiguration: MULTI_FACTOR_WITH_USER_VERIFICATION`
**and** the account has `WebAuthnMfaSettings` on; then a passkey with user
verification (Touch ID, Face ID, PIN) counts as both factors on its own, and
password sign-in still asks for the code. The per-user flag is only allowed
beside another factor, so the console sets it exactly when the account has
TOTP on and at least one passkey. This is phase A of
[`two-factor-plan.md`](./two-factor-plan.md), a port of the web app's phase 1.

- **Pool prerequisite**, applied by the owner on 2026-10-04:
  `UserVerification: required` and `MULTI_FACTOR_WITH_USER_VERIFICATION` on
  the admin pool (the command is step 2(b) below). The code works with either
  setting; on a pool without it the flag is refused and logged.
- **Three trigger points**, all through `ensurePasskeyMfa()` in
  `src/lib/account/passkey-mfa.ts` (best-effort, never throws): after
  `PUT /api/v1/admin/me/mfa/totp` turns the app on, after
  `PUT /api/v1/admin/me/passkeys` registers a passkey, and in `verifyMfaCode`
  (`src/app/login/actions.ts`) after a password sign-in's code is accepted and
  before the session is written — which heals operators who had both before
  this existed: one `GetUser` per TOTP sign-in, `ListWebAuthnCredentials` and
  `SetUserMFAPreference` only when the flag is off.
- **The same-request lesson.** `SetUserMFAPreference` with
  `WebAuthnMfaSettings { Enabled: true }` alone is refused with
  `InvalidParameterException: WebAuthn MFA requires enabling an additional MFA
  setting.` even when TOTP is already on (stage, 2026-10-03). Enabling therefore
  sends `SoftwareTokenMfaSettings { Enabled: true, PreferredMfa: true }` in the
  same request (`setPasskeyMfaPreference()` in `src/lib/account/service.ts`).
  Turning the app off sends both settings off in one call, which Cognito
  accepts and which empties the list; if it is ever refused, the TOTP-only call
  that ran before this change is sent instead.
- **The value.** Once set, `GetUser.UserMFASettingList` holds `WEB_AUTHN_MFA`
  beside `SOFTWARE_TOKEN_MFA`; `isPasskeyMfaListed()` in `service.ts` is the
  one place that reads it. `GET /api/v1/admin/me/mfa` answers
  `passkeyMfaEnabled` and `passkeySignInPaused` (TOTP on, a passkey, flag off;
  that one case adds a `ListWebAuthnCredentials` to the read) and never sets
  the flag.
- **The drawer** says "A passkey signs you in on its own and counts as two
  factors. The authenticator app protects password sign-in." and, while
  paused, warns "Passkey sign-in is paused while two-factor authentication is
  on. Until an upcoming update, sign in with your password and authenticator
  code." The warning is re-read when the Passkeys section adds or removes one
  (`PASSKEYS_CHANGED_EVENT` on `window`).

## What the user pool needs

**Done for the admin pool `us-west-2_0WO5mp4bn` ("Dolphin - Admin") as of
2026-09-12:** `MfaConfiguration` is `OPTIONAL` with software tokens on, the
WebAuthn relying party is `admin.fairsums.app`, `AllowedFirstAuthFactors` is
`[PASSWORD, WEB_AUTHN]`, and the app client has `ALLOW_USER_AUTH` alongside the
password and refresh flows. Two-factor enrolment, passkey registration and
passkey sign-in all work against it. **Since 2026-10-04** the WebAuthn
configuration is also `UserVerification: required` with
`FactorConfiguration: MULTI_FACTOR_WITH_USER_VERIFICATION`, which is what lets
a passkey count as both factors ([Passkey MFA](#passkey-mfa-2026-10-04)).

The steps below are kept as the runbook for **every other environment** — a
`testing.fairsums.app` pool, or a local one. A pool has exactly one relying
party id, so each host that is to use passkeys needs its own pool. Where a pool
is missing a piece, the app does not break: the Account & security endpoints
answer **503** (`mfa_not_enabled`, `passkeys_not_enabled`) with Cognito's own
sentence appended and the drawer shows it, and `/login`'s passkey button reports
"Passkey sign-in is not enabled for this console yet."

> `update-user-pool` **replaces** the pool's configuration: any parameter you
> leave out is reset to its default. Run `aws cognito-idp describe-user-pool`
> first and pass back everything that must survive, or make these changes in
> the console. `set-user-pool-mfa-config` behaves the same way — it sets the
> whole MFA configuration, so send the MFA *and* the WebAuthn parts together.

Set `POOL_ID` and `REGION` from `ADMIN_COGNITO_USER_POOL_ID` and
`ADMIN_COGNITO_REGION`, and `CLIENT_ID` from `ADMIN_COGNITO_CLIENT_ID`.

### 1. Two-factor authentication (authenticator app)

`MfaConfiguration` must be `OPTIONAL`, with software tokens enabled. **Not
`ON`:** that would force every operator through `MFA_SETUP` at sign-in, which
this app does not answer.

    aws cognito-idp set-user-pool-mfa-config \
      --region "$REGION" \
      --user-pool-id "$POOL_ID" \
      --mfa-configuration OPTIONAL \
      --software-token-mfa-configuration Enabled=true

That alone makes everything in this document's "Two-factor" rows work: the
drawer can enrol an app, and `/login` will start answering `SOFTWARE_TOKEN_MFA`
for anyone who has.

### 2. Passkeys

Passkeys are an **Essentials** tier feature and need a relying party id, which
must be the host name the console is served from — one per environment
(`localhost` for development, `admin.fairsums.app` and `testing.fairsums.app`
for the deployed ones). A pool has exactly one, so each environment needs its
own user pool if more than one is to use passkeys.

    # a. the feature tier (charged per monthly active user)
    aws cognito-idp update-user-pool \
      --region "$REGION" \
      --user-pool-id "$POOL_ID" \
      --user-pool-tier ESSENTIALS

    # b. the relying party, sent together with the MFA settings from step 1
    aws cognito-idp set-user-pool-mfa-config \
      --region "$REGION" \
      --user-pool-id "$POOL_ID" \
      --mfa-configuration OPTIONAL \
      --software-token-mfa-configuration Enabled=true \
      --web-authn-configuration RelyingPartyId=admin.fairsums.app,UserVerification=required,FactorConfiguration=MULTI_FACTOR_WITH_USER_VERIFICATION

    # c. WEB_AUTHN as an allowed first auth factor for the pool
    aws cognito-idp update-user-pool \
      --region "$REGION" \
      --user-pool-id "$POOL_ID" \
      --policies '{"SignInPolicy":{"AllowedFirstAuthFactors":["PASSWORD","WEB_AUTHN"]}}'

    # d. the USER_AUTH flow on the app client, keeping the flows already in use
    aws cognito-idp update-user-pool-client \
      --region "$REGION" \
      --user-pool-id "$POOL_ID" \
      --client-id "$CLIENT_ID" \
      --explicit-auth-flows ALLOW_USER_AUTH ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH

(c) and (d) are what [signing in with a passkey](#signing-in-with-a-passkey)
needs; registering and deleting passkeys from the drawer needs only (a) and (b).
Note that (c) passes `--policies`, which replaces the whole policy document:
include the pool's existing `PasswordPolicy` in the same JSON, or the password
rules go back to their defaults. `ALLOW_REFRESH_TOKEN_AUTH` is listed in (d)
only because the pool still has it; it can be left out (see
[Token lifetimes and rotation](#3-token-lifetimes-and-rotation)), and rotation
removes it anyway.

### 3. Token lifetimes and rotation

The session policy above is the app's, not the pool's, but the pool's numbers
decide how often it is exercised. The intended settings for the app client are
an id token of **5 minutes**, an access token of **15 minutes**, a refresh
token valid **1 day** (an absolute cap counted from sign-in), and refresh-token
rotation **enabled** with a 60-second retry grace:

    aws cognito-idp update-user-pool-client \
      --region "$REGION" \
      --user-pool-id "$POOL_ID" \
      --client-id "$CLIENT_ID" \
      --id-token-validity 5 --access-token-validity 15 \
      --token-validity-units IdToken=minutes,AccessToken=minutes,RefreshToken=days \
      --refresh-token-validity 1 \
      --refresh-token-rotation Feature=ENABLED,RetryGracePeriodSeconds=60

(`update-user-pool-client` replaces the client's configuration: pass back the
explicit auth flows and everything else that must survive.) Enabling rotation
disables `REFRESH_TOKEN_AUTH`, which is why `ALLOW_REFRESH_TOKEN_AUTH` can be
dropped from the explicit auth flows at the same time. The app works either
way, before and after.

### 4. Nothing else changes

`ALLOW_USER_PASSWORD_AUTH` and token revocation stay exactly as they are; the
invitation flow needs no pool change at all, because `AdminCreateUser` already
produces the `NEW_PASSWORD_REQUIRED` challenge the form now answers.

## Authentication is not authorization

A valid token proves who the caller is. Whether they may do anything is
decided afterwards by the allowlist and the access map, see
[access-control.md](./access-control.md). A signed-in person with no
`admin_users` row lands on `/no-access`.

## Client IP and `TRUST_PROXY_HEADERS`

Per-IP limits and the CSRF origin check need the client's address, which Next
only exposes through forwarded headers. Those are believed only when
`TRUST_PROXY_HEADERS=true`, which is correct behind exactly one trusted load
balancer. Unset (as in development) the IP is "unknown" and per-IP limits are
switched off; per-account and per-user limits still apply. Production must set
it.
