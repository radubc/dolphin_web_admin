/**
 * Unit tests for the order of a recovery-code sign-in (`./recovery-redeem`)
 * against a scripted gateway: nothing here talks to AWS or a database.
 *
 *     npm test
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type * as RecoveryRedeem from "./recovery-redeem";
import type { PasswordCheckResult, SignInResult } from "./cognito";
import type { AdminFindUserResult, AdminTurnOffSecondFactorResult } from "./cognito-admin";

const { decideRecoveryRedeem } = (await import("./recovery-redeem" + ".ts")) as typeof RecoveryRedeem;

type Gateway = RecoveryRedeem.RecoveryRedeemGateway;

const INPUT: RecoveryRedeem.RecoveryRedeemInput = {
  email: "ann@example.com",
  password: "hunter2-but-longer",
  code: "abcdefghjk",
};

const TOKENS: SignInResult = {
  ok: true,
  idToken: "id",
  accessToken: "access",
  refreshToken: "refresh",
  expiresIn: 900,
};

const CHALLENGE_PROOF: PasswordCheckResult = {
  ok: true,
  proof: "challenge",
  challengeName: "SOFTWARE_TOKEN_MFA",
};

const FOUND: AdminFindUserResult = {
  ok: true,
  user: { username: "pool-username", sub: "sub-1", email: "ann@example.com" },
};

/** A gateway that records the order of calls; every step can be overridden. */
function stubGateway(overrides: Partial<Gateway> = {}): { gateway: Gateway; calls: string[] } {
  const calls: string[] = [];
  const record = <A extends unknown[], R>(name: string, fn: (...args: A) => R) => {
    return (...args: A): R => {
      calls.push(name);
      return fn(...args);
    };
  };
  const base: Gateway = {
    verifyPassword: async () => CHALLENGE_PROOF,
    findPoolUser: async () => FOUND,
    findEnabledOperatorBySub: async () => ({ id: "op-1" }),
    hashCode: (code) => `hash(${code})`,
    claimCode: async () => true,
    unclaimCode: async () => undefined,
    deleteOtherCodes: async () => 9,
    turnOffSecondFactor: async (): Promise<AdminTurnOffSecondFactorResult> => ({ ok: true }),
    signIn: async () => TOKENS,
  };
  const merged = { ...base, ...overrides };
  const gateway = Object.fromEntries(
    Object.entries(merged).map(([name, fn]) => [name, record(name, fn as (...args: unknown[]) => unknown)]),
  ) as unknown as Gateway;
  return { gateway, calls };
}

/** Every console line written during a test, to prove nothing sensitive is logged. */
let logged: string[] = [];
const originals = { error: console.error, warn: console.warn, info: console.info };
beforeEach(() => {
  logged = [];
  for (const level of ["error", "warn", "info"] as const) {
    console[level] = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
  }
});
afterEach(() => {
  console.error = originals.error;
  console.warn = originals.warn;
  console.info = originals.info;
});

function assertNothingSensitiveLogged(): void {
  for (const line of logged) {
    assert.ok(!line.includes(INPUT.email), `address logged: ${line}`);
    assert.ok(!line.includes(INPUT.password), `password logged: ${line}`);
    assert.ok(!line.includes(INPUT.code), `code logged: ${line}`);
    assert.ok(!line.includes("hash(abcdefghjk)"), `hash logged: ${line}`);
  }
}

describe("decideRecoveryRedeem — the happy path", () => {
  it("proves, finds, claims, turns off, deletes the others, signs in — in that order", async () => {
    const { gateway, calls } = stubGateway();
    const outcome = await decideRecoveryRedeem(INPUT, gateway);
    assert.deepEqual(outcome, { kind: "recovered", operatorId: "op-1", signIn: TOKENS });
    assert.deepEqual(calls, [
      "verifyPassword",
      "findPoolUser",
      "findEnabledOperatorBySub",
      "hashCode",
      "claimCode",
      "turnOffSecondFactor",
      "deleteOtherCodes",
      "signIn",
    ]);
    assertNothingSensitiveLogged();
  });

  it("looks the pool account up by the address the password was proven for", async () => {
    let lookedUp: string | undefined;
    const { gateway } = stubGateway({
      findPoolUser: async (email) => {
        lookedUp = email;
        return FOUND;
      },
    });
    await decideRecoveryRedeem(INPUT, gateway);
    assert.equal(lookedUp, INPUT.email);
  });

  it("turns the factor off for the pool username and claims the hash for the operator id", async () => {
    let turnedOffFor: string | undefined;
    let claimedFor: [string, string] | undefined;
    const { gateway } = stubGateway({
      turnOffSecondFactor: async (username) => {
        turnedOffFor = username;
        return { ok: true };
      },
      claimCode: async (operatorId, codeHash) => {
        claimedFor = [operatorId, codeHash];
        return true;
      },
    });
    await decideRecoveryRedeem(INPUT, gateway);
    assert.equal(turnedOffFor, "pool-username");
    assert.deepEqual(claimedFor, ["op-1", "hash(abcdefghjk)"]);
  });

  it("still reports recovered when the sign-in afterwards did not produce tokens", async () => {
    const challenge: SignInResult = {
      ok: false,
      mfa: { name: "SOFTWARE_TOKEN_MFA", session: "s", username: "u" },
    };
    const { gateway } = stubGateway({ signIn: async () => challenge });
    const outcome = await decideRecoveryRedeem(INPUT, gateway);
    assert.deepEqual(outcome, { kind: "recovered", operatorId: "op-1", signIn: challenge });
    assert.equal(logged.filter((line) => /did not produce tokens/.test(line)).length, 1);
    assertNothingSensitiveLogged();
  });
});

describe("decideRecoveryRedeem — before the claim", () => {
  it("a wrong password is neutral and nothing else is called", async () => {
    const { gateway, calls } = stubGateway({
      verifyPassword: async () => ({ ok: false, failure: "incorrect" }),
    });
    assert.deepEqual(await decideRecoveryRedeem(INPUT, gateway), { kind: "neutral" });
    assert.deepEqual(calls, ["verifyPassword"]);
  });

  it("an outage judging the password is unavailable, not neutral", async () => {
    const { gateway, calls } = stubGateway({
      verifyPassword: async () => ({ ok: false, failure: "unavailable" }),
    });
    assert.deepEqual(await decideRecoveryRedeem(INPUT, gateway), { kind: "unavailable" });
    assert.deepEqual(calls, ["verifyPassword"]);
  });

  it("a temporary password restarts", async () => {
    const { gateway, calls } = stubGateway({
      verifyPassword: async () => ({ ok: false, failure: "challenge" }),
    });
    assert.deepEqual(await decideRecoveryRedeem(INPUT, gateway), { kind: "restart" });
    assert.deepEqual(calls, ["verifyPassword"]);
  });

  it("tokens without a second factor restart: the factor is already off", async () => {
    const { gateway, calls } = stubGateway({
      verifyPassword: async () => ({ ok: true, proof: "tokens", tokens: TOKENS }),
    });
    assert.deepEqual(await decideRecoveryRedeem(INPUT, gateway), { kind: "restart" });
    assert.deepEqual(calls, ["verifyPassword"]);
  });

  it("an AWS refusal on the lookup is unavailable", async () => {
    const { gateway, calls } = stubGateway({ findPoolUser: async () => ({ ok: false }) });
    assert.deepEqual(await decideRecoveryRedeem(INPUT, gateway), { kind: "unavailable" });
    assert.deepEqual(calls, ["verifyPassword", "findPoolUser"]);
  });

  it("an unknown sign-in (or a mismatched address) is neutral", async () => {
    const { gateway, calls } = stubGateway({ findPoolUser: async () => ({ ok: true, user: null }) });
    assert.deepEqual(await decideRecoveryRedeem(INPUT, gateway), { kind: "neutral" });
    assert.deepEqual(calls, ["verifyPassword", "findPoolUser"]);
  });

  it("no enabled allowlist row is neutral", async () => {
    const { gateway, calls } = stubGateway({ findEnabledOperatorBySub: async () => null });
    assert.deepEqual(await decideRecoveryRedeem(INPUT, gateway), { kind: "neutral" });
    assert.deepEqual(calls, ["verifyPassword", "findPoolUser", "findEnabledOperatorBySub"]);
  });

  it("a database fault reading the row is unavailable", async () => {
    const { gateway } = stubGateway({
      findEnabledOperatorBySub: async () => {
        throw new Error("connection refused");
      },
    });
    assert.deepEqual(await decideRecoveryRedeem(INPUT, gateway), { kind: "unavailable" });
    assertNothingSensitiveLogged();
  });

  it("a code that matches no unused row is neutral, and Cognito is never asked to turn anything off", async () => {
    const { gateway, calls } = stubGateway({ claimCode: async () => false });
    assert.deepEqual(await decideRecoveryRedeem(INPUT, gateway), { kind: "neutral" });
    assert.ok(!calls.includes("turnOffSecondFactor"));
    assert.ok(!calls.includes("signIn"));
  });

  it("a database fault claiming the code is unavailable", async () => {
    const { gateway, calls } = stubGateway({
      claimCode: async () => {
        throw new Error("connection refused");
      },
    });
    assert.deepEqual(await decideRecoveryRedeem(INPUT, gateway), { kind: "unavailable" });
    assert.ok(!calls.includes("turnOffSecondFactor"));
    assertNothingSensitiveLogged();
  });
});

describe("decideRecoveryRedeem — after the claim", () => {
  it("puts the code back when Cognito refuses, and does not sign in", async () => {
    const { gateway, calls } = stubGateway({ turnOffSecondFactor: async () => ({ ok: false }) });
    assert.deepEqual(await decideRecoveryRedeem(INPUT, gateway), { kind: "turn_off_refused" });
    assert.deepEqual(calls, [
      "verifyPassword",
      "findPoolUser",
      "findEnabledOperatorBySub",
      "hashCode",
      "claimCode",
      "turnOffSecondFactor",
      "unclaimCode",
    ]);
  });

  it("puts the code back when Cognito throws", async () => {
    const { gateway, calls } = stubGateway({
      turnOffSecondFactor: async () => {
        throw new Error("network");
      },
    });
    assert.deepEqual(await decideRecoveryRedeem(INPUT, gateway), { kind: "turn_off_refused" });
    assert.ok(calls.includes("unclaimCode"));
    assertNothingSensitiveLogged();
  });

  it("logs loudly when the claim cannot be undone, and still answers the refusal", async () => {
    const { gateway } = stubGateway({
      turnOffSecondFactor: async () => ({ ok: false }),
      unclaimCode: async () => {
        throw new Error("connection refused");
      },
    });
    assert.deepEqual(await decideRecoveryRedeem(INPUT, gateway), { kind: "turn_off_refused" });
    assert.equal(logged.filter((line) => /could NOT be undone/.test(line)).length, 1);
    assertNothingSensitiveLogged();
  });

  it("a failed delete of the other codes is logged and the recovery still stands", async () => {
    const { gateway, calls } = stubGateway({
      deleteOtherCodes: async () => {
        throw new Error("connection refused");
      },
    });
    const outcome = await decideRecoveryRedeem(INPUT, gateway);
    assert.equal(outcome.kind, "recovered");
    assert.ok(calls.includes("signIn"));
    assert.equal(logged.filter((line) => /could not be deleted/.test(line)).length, 1);
    assertNothingSensitiveLogged();
  });
});
