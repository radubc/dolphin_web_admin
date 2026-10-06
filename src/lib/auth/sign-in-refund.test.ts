/**
 * Unit tests for the refund decision behind the sign-in budgets
 * (`./sign-in-refund`): which Cognito verdicts give the slot back. Nothing
 * here talks to AWS.
 *
 *     npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PasswordCheckResult, SignInResult } from "./cognito";
import type * as SignInRefund from "./sign-in-refund";

const { passwordAccepted, passwordProofAccepted } = (await import(
  "./sign-in-refund" + ".ts"
)) as typeof SignInRefund;

const TOKENS: SignInResult = {
  ok: true,
  idToken: "id",
  accessToken: "access",
  refreshToken: "refresh",
  expiresIn: 900,
};

describe("passwordAccepted", () => {
  it("refunds on tokens", () => {
    assert.equal(passwordAccepted(TOKENS), true);
  });

  it("refunds on the invitation challenge (NEW_PASSWORD_REQUIRED)", () => {
    assert.equal(
      passwordAccepted({
        ok: false,
        challenge: { name: "NEW_PASSWORD_REQUIRED", session: "s", username: "u", requiredAttributes: [] },
      }),
      true,
    );
  });

  it("refunds on the authenticator challenge (SOFTWARE_TOKEN_MFA)", () => {
    assert.equal(
      passwordAccepted({
        ok: false,
        mfa: { name: "SOFTWARE_TOKEN_MFA", session: "s", username: "u" },
      }),
      true,
    );
  });

  it("keeps the slot spent on a refusal, whatever the message says", () => {
    assert.equal(passwordAccepted({ ok: false, message: "Incorrect email or password." }), false);
    assert.equal(passwordAccepted({ ok: false, message: "Something went wrong." }), false);
  });
});

describe("passwordProofAccepted", () => {
  it("refunds on tokens and on a proving challenge", () => {
    const tokens: PasswordCheckResult = { ok: true, proof: "tokens" };
    const challenge: PasswordCheckResult = { ok: true, proof: "challenge", challengeName: "SOFTWARE_TOKEN_MFA" };
    assert.equal(passwordProofAccepted(tokens), true);
    assert.equal(passwordProofAccepted(challenge), true);
  });

  it("refunds on NEW_PASSWORD_REQUIRED: a temporary password Cognito accepted", () => {
    assert.equal(passwordProofAccepted({ ok: false, failure: "challenge" }), true);
  });

  it("keeps the slot spent on a wrong password and on an outage", () => {
    assert.equal(passwordProofAccepted({ ok: false, failure: "incorrect" }), false);
    assert.equal(passwordProofAccepted({ ok: false, failure: "unavailable" }), false);
  });
});
