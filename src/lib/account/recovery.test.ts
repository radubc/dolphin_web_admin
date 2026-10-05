/**
 * Unit tests for `./recovery` (phase B of `docs/two-factor-plan.md`): the
 * best-effort rules around the recovery-code rows, against a stubbed
 * gateway. Nothing here talks to AWS or a database.
 *
 *     npm test
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type * as PrismaAdminClient from "@/generated/prisma-admin/client";
import type { ApiError } from "@/lib/api/errors";
import type * as Config from "@/lib/auth/config";
import type * as Recovery from "./recovery";
import type { RecoveryCodesSummary } from "./recovery-codes";
import type { MfaStatus } from "./types";

const {
  clearRecoveryCodesAfterDisable,
  getMfaStatusView,
  issueRecoveryCodesAfterEnrolment,
  regenerateRecoveryCodes,
} = (await import("./recovery" + ".ts")) as typeof Recovery;
const { CognitoConfigError } = (await import("@/lib/auth/config" + ".ts")) as typeof Config;
const { Prisma } = (await import("@/generated/prisma-admin/client" + ".ts")) as typeof PrismaAdminClient;

type Gateway = Recovery.RecoveryGateway;

const TOKEN = "access-token";
const OPERATOR = { id: "op-1", email: "ann@example.com" };
const PASSWORD = "hunter2-but-longer";
const CODES = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"];
const SUMMARY: RecoveryCodesSummary = { remaining: 10, total: 10, usedAt: null };
const NO_CODES: RecoveryCodesSummary = { remaining: 0, total: 0, usedAt: null };

function status(overrides: Partial<MfaStatus> = {}): MfaStatus {
  return {
    totpEnabled: true,
    passkeyMfaEnabled: false,
    passkeySignInPaused: false,
    preferred: "SOFTWARE_TOKEN_MFA",
    methods: ["SOFTWARE_TOKEN_MFA"],
    ...overrides,
  };
}

/** A gateway that records the order of calls; every call can be overridden. */
function stubGateway(overrides: Partial<Gateway> = {}): { gateway: Gateway; calls: string[] } {
  const calls: string[] = [];
  const record = <A extends unknown[], R>(name: string, fn: (...args: A) => R) => {
    return (...args: A): R => {
      calls.push(name);
      return fn(...args);
    };
  };
  const base: Gateway = {
    verifyPassword: async () => ({ ok: true, proof: "challenge", challengeName: "SOFTWARE_TOKEN_MFA" }),
    getMfaStatus: async () => status(),
    replaceRecoveryCodes: async () => [...CODES],
    summariseRecoveryCodes: async () => ({ ...SUMMARY }),
    deleteRecoveryCodes: async () => 10,
  };
  const merged = { ...base, ...overrides };
  const gateway = Object.fromEntries(
    Object.entries(merged).map(([name, fn]) => [name, record(name, fn as (...args: unknown[]) => unknown)]),
  ) as unknown as Gateway;
  return { gateway, calls };
}

function dbDown(): Error {
  return new Error("connection refused");
}

/** A Prisma "table does not exist" error, the shape `isSchemaFaultError` recognises. */
function missingTable(kind: "P2021" | "P2010"): Error {
  return new Prisma.PrismaClientKnownRequestError("relation does not exist", {
    code: kind,
    clientVersion: "test",
    meta: kind === "P2010" ? { code: "42P01" } : undefined,
  });
}

/**
 * Postgres 42501 from a raw query: the table exists but belongs to another
 * role, so the app's role may not use it (the stage test of 2026-10-04).
 */
function permissionDenied(): Error {
  return new Prisma.PrismaClientKnownRequestError("permission denied for table admin_user_recovery_codes", {
    code: "P2010",
    clientVersion: "test",
    meta: { code: "42501" },
  });
}

async function rejectsApi(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  assert.fail("expected a rejection");
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
    assert.ok(!line.includes(PASSWORD), `password logged: ${line}`);
    for (const code of CODES) assert.ok(!line.includes(code), `code logged: ${line}`);
  }
}

describe("getMfaStatusView", () => {
  it("answers the Cognito status with the codes summary", async () => {
    const { gateway, calls } = stubGateway();
    const result = await getMfaStatusView(TOKEN, OPERATOR.id, gateway);
    assert.deepEqual(result, { ...status(), recoveryCodes: SUMMARY });
    assert.deepEqual(calls, ["getMfaStatus", "summariseRecoveryCodes"]);
    assert.deepEqual(logged, []);
  });

  it("never fails the drawer over the summary: 42501 on the table answers the empty summary, logged once", async () => {
    const { gateway } = stubGateway({
      summariseRecoveryCodes: async () => {
        throw permissionDenied();
      },
    });
    const result = await getMfaStatusView(TOKEN, OPERATOR.id, gateway);
    assert.deepEqual(result, { ...status(), recoveryCodes: NO_CODES });
    assert.equal(logged.filter((line) => /summary unavailable/.test(line)).length, 1);
  });

  it("answers the empty summary on any other database fault too", async () => {
    const { gateway } = stubGateway({
      summariseRecoveryCodes: async () => {
        throw dbDown();
      },
    });
    const result = await getMfaStatusView(TOKEN, OPERATOR.id, gateway);
    assert.deepEqual(result, { ...status(), recoveryCodes: NO_CODES });
    assert.equal(logged.filter((line) => /summary unavailable/.test(line)).length, 1);
  });

  it("still fails when Cognito itself refuses the status read", async () => {
    const { gateway, calls } = stubGateway({
      getMfaStatus: async () => {
        throw new TypeError("cognito down");
      },
    });
    await assert.rejects(getMfaStatusView(TOKEN, OPERATOR.id, gateway), TypeError);
    assert.deepEqual(calls, ["getMfaStatus"]);
  });
});

describe("issueRecoveryCodesAfterEnrolment", () => {
  it("issues the codes once and answers the summary with the status", async () => {
    const { gateway, calls } = stubGateway();
    const result = await issueRecoveryCodesAfterEnrolment(status(), OPERATOR.id, gateway);
    assert.deepEqual(result, { ...status(), recoveryCodes: SUMMARY, issuedRecoveryCodes: CODES });
    assert.deepEqual(calls, ["replaceRecoveryCodes", "summariseRecoveryCodes"]);
    assert.deepEqual(logged, []);
  });

  it("never fails the enrolment because the codes could not be written: null codes, summary still read", async () => {
    const { gateway, calls } = stubGateway({
      replaceRecoveryCodes: async () => {
        throw dbDown();
      },
      summariseRecoveryCodes: async () => ({ ...NO_CODES }),
    });
    const result = await issueRecoveryCodesAfterEnrolment(status(), OPERATOR.id, gateway);
    assert.deepEqual(result, { ...status(), recoveryCodes: NO_CODES, issuedRecoveryCodes: null });
    assert.deepEqual(calls, ["replaceRecoveryCodes", "summariseRecoveryCodes"]);
    assert.equal(logged.filter((line) => /could not be created/.test(line)).length, 1);
  });

  it("answers the empty summary, never throws, when the summary read fails", async () => {
    const { gateway } = stubGateway({
      summariseRecoveryCodes: async () => {
        throw dbDown();
      },
    });
    const result = await issueRecoveryCodesAfterEnrolment(status(), OPERATOR.id, gateway);
    assert.deepEqual(result, { ...status(), recoveryCodes: NO_CODES, issuedRecoveryCodes: CODES });
    assert.equal(logged.filter((line) => /summary unavailable/.test(line)).length, 1);
    assertNothingSensitiveLogged();
  });

  it("still answers when both the write and the summary fail", async () => {
    const { gateway } = stubGateway({
      replaceRecoveryCodes: async () => {
        throw dbDown();
      },
      summariseRecoveryCodes: async () => {
        throw dbDown();
      },
    });
    const result = await issueRecoveryCodesAfterEnrolment(status(), OPERATOR.id, gateway);
    assert.deepEqual(result, { ...status(), recoveryCodes: NO_CODES, issuedRecoveryCodes: null });
  });
});

describe("clearRecoveryCodesAfterDisable", () => {
  it("deletes the rows and answers the summary with the status", async () => {
    const off = status({ totpEnabled: false, preferred: null, methods: [] });
    const { gateway, calls } = stubGateway({ summariseRecoveryCodes: async () => ({ ...NO_CODES }) });
    const result = await clearRecoveryCodesAfterDisable(off, OPERATOR.id, gateway);
    assert.deepEqual(result, { ...off, recoveryCodes: NO_CODES });
    assert.deepEqual(calls, ["deleteRecoveryCodes", "summariseRecoveryCodes"]);
    assert.deepEqual(logged, []);
  });

  it("never fails because the rows could not be deleted", async () => {
    const off = status({ totpEnabled: false, preferred: null, methods: [] });
    const { gateway, calls } = stubGateway({
      deleteRecoveryCodes: async () => {
        throw dbDown();
      },
    });
    const result = await clearRecoveryCodesAfterDisable(off, OPERATOR.id, gateway);
    assert.deepEqual(result, { ...off, recoveryCodes: SUMMARY });
    assert.deepEqual(calls, ["deleteRecoveryCodes", "summariseRecoveryCodes"]);
    assert.equal(logged.filter((line) => /could not be deleted/.test(line)).length, 1);
  });

  it("answers the empty summary, never throws, when the summary read fails", async () => {
    const off = status({ totpEnabled: false, preferred: null, methods: [] });
    const { gateway } = stubGateway({
      summariseRecoveryCodes: async () => {
        throw dbDown();
      },
    });
    const result = await clearRecoveryCodesAfterDisable(off, OPERATOR.id, gateway);
    assert.deepEqual(result, { ...off, recoveryCodes: NO_CODES });
    assert.equal(logged.filter((line) => /summary unavailable/.test(line)).length, 1);
  });
});

describe("regenerateRecoveryCodes — the happy path", () => {
  it("proves the password, checks the authenticator is on, then replaces the set", async () => {
    const { gateway, calls } = stubGateway();
    const codes = await regenerateRecoveryCodes(TOKEN, OPERATOR, PASSWORD, gateway);
    assert.deepEqual(codes, CODES);
    assert.deepEqual(calls, ["verifyPassword", "getMfaStatus", "replaceRecoveryCodes"]);
    assertNothingSensitiveLogged();
  });

  it("proves the password for the allowlist row's address and replaces the row's own set", async () => {
    let proven: [string, string] | undefined;
    let replacedFor: string | undefined;
    const { gateway } = stubGateway({
      verifyPassword: async (email, password) => {
        proven = [email, password];
        return { ok: true, proof: "challenge", challengeName: "SOFTWARE_TOKEN_MFA" };
      },
      replaceRecoveryCodes: async (userId) => {
        replacedFor = userId;
        return [...CODES];
      },
    });
    await regenerateRecoveryCodes(TOKEN, OPERATOR, PASSWORD, gateway);
    assert.deepEqual(proven, [OPERATOR.email, PASSWORD]);
    assert.equal(replacedFor, OPERATOR.id);
  });

  it("accepts tokens as proof too (the status read decides whether the app is on)", async () => {
    const { gateway, calls } = stubGateway({
      verifyPassword: async () => ({
        ok: true,
        proof: "tokens",
        tokens: { idToken: "id", accessToken: "access", expiresIn: 900 },
      }),
    });
    assert.deepEqual(await regenerateRecoveryCodes(TOKEN, OPERATOR, PASSWORD, gateway), CODES);
    assert.deepEqual(calls, ["verifyPassword", "getMfaStatus", "replaceRecoveryCodes"]);
  });
});

describe("regenerateRecoveryCodes — refusals", () => {
  it("a wrong password is 401 password_incorrect and nothing else is called", async () => {
    const { gateway, calls } = stubGateway({
      verifyPassword: async () => ({ ok: false, failure: "incorrect" }),
    });
    const error = await rejectsApi(regenerateRecoveryCodes(TOKEN, OPERATOR, PASSWORD, gateway));
    assert.equal(error.status, 401);
    assert.equal(error.code, "password_incorrect");
    assert.deepEqual(calls, ["verifyPassword"]);
  });

  it("an outage judging the password is 503 auth_unavailable, never 'wrong password'", async () => {
    const { gateway, calls } = stubGateway({
      verifyPassword: async () => ({ ok: false, failure: "unavailable" }),
    });
    const error = await rejectsApi(regenerateRecoveryCodes(TOKEN, OPERATOR, PASSWORD, gateway));
    assert.equal(error.status, 503);
    assert.equal(error.code, "auth_unavailable");
    assert.deepEqual(calls, ["verifyPassword"]);
  });

  it("a temporary password (NEW_PASSWORD_REQUIRED) is 401 password_incorrect with the set-password message", async () => {
    const { gateway } = stubGateway({
      verifyPassword: async () => ({ ok: false, failure: "challenge" }),
    });
    const error = await rejectsApi(regenerateRecoveryCodes(TOKEN, OPERATOR, PASSWORD, gateway));
    assert.equal(error.status, 401);
    assert.equal(error.code, "password_incorrect");
    assert.match(error.message, /setting its password/);
  });

  it("Cognito not configured is 503 auth_unavailable", async () => {
    const { gateway } = stubGateway({
      verifyPassword: async () => {
        throw new CognitoConfigError("Missing required environment variable ADMIN_COGNITO_REGION.");
      },
    });
    const error = await rejectsApi(regenerateRecoveryCodes(TOKEN, OPERATOR, PASSWORD, gateway));
    assert.equal(error.status, 503);
    assert.equal(error.code, "auth_unavailable");
    assert.equal(logged.filter((line) => /not configured/.test(line)).length, 1);
  });

  it("anything else the password check throws propagates as is", async () => {
    const { gateway } = stubGateway({
      verifyPassword: async () => {
        throw new TypeError("boom");
      },
    });
    await assert.rejects(regenerateRecoveryCodes(TOKEN, OPERATOR, PASSWORD, gateway), TypeError);
  });

  it("refuses with 422 while the authenticator app is off, and touches no row", async () => {
    const { gateway, calls } = stubGateway({
      getMfaStatus: async () => status({ totpEnabled: false, preferred: null, methods: [] }),
    });
    const error = await rejectsApi(regenerateRecoveryCodes(TOKEN, OPERATOR, PASSWORD, gateway));
    assert.equal(error.status, 422);
    assert.equal(error.code, "validation_failed");
    assert.equal(error.message, "Turn on the authenticator app first.");
    assert.deepEqual(calls, ["verifyPassword", "getMfaStatus"]);
  });

  it("maps a missing table (P2021) to 503 admin_schema_missing naming the SQL file", async () => {
    const { gateway } = stubGateway({
      replaceRecoveryCodes: async () => {
        throw missingTable("P2021");
      },
    });
    const error = await rejectsApi(regenerateRecoveryCodes(TOKEN, OPERATOR, PASSWORD, gateway));
    assert.equal(error.status, 503);
    assert.equal(error.code, "admin_schema_missing");
    assert.match(error.message, /022_admin_user_recovery_codes\.sql/);
    assert.equal(logged.filter((line) => /does not exist yet/.test(line)).length, 1);
  });

  it("maps a raw-query missing table (P2010 / 42P01) the same way", async () => {
    const { gateway } = stubGateway({
      replaceRecoveryCodes: async () => {
        throw missingTable("P2010");
      },
    });
    const error = await rejectsApi(regenerateRecoveryCodes(TOKEN, OPERATOR, PASSWORD, gateway));
    assert.equal(error.code, "admin_schema_missing");
  });

  it("maps permission denied on the table (P2010 / 42501, wrong owner) to 503 admin_schema_missing naming the owner rule", async () => {
    const { gateway } = stubGateway({
      replaceRecoveryCodes: async () => {
        throw permissionDenied();
      },
    });
    const error = await rejectsApi(regenerateRecoveryCodes(TOKEN, OPERATOR, PASSWORD, gateway));
    assert.equal(error.status, 503);
    assert.equal(error.code, "admin_schema_missing");
    assert.match(error.message, /022_admin_user_recovery_codes\.sql/);
    assert.match(error.message, /owned by the same role as admin_users/);
    assert.equal(logged.filter((line) => /owner must match admin_users/.test(line)).length, 1);
  });

  it("lets any other database fault propagate", async () => {
    const { gateway } = stubGateway({
      replaceRecoveryCodes: async () => {
        throw dbDown();
      },
    });
    await assert.rejects(regenerateRecoveryCodes(TOKEN, OPERATOR, PASSWORD, gateway), /connection refused/);
  });
});
