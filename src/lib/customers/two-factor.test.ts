/**
 * Unit tests for support's "Turn off two-factor authentication"
 * (`./two-factor`, phase C of `docs/two-factor-plan.md`): the order of the
 * guards against a stubbed gateway, and the two pool calls in `./cognito`
 * against a stubbed pool. The rate limiter is the real in-process one,
 * keyed by a fresh operator id per test. Nothing here talks to AWS or a
 * database.
 *
 *     npm test
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import type * as Errors from "@/lib/api/errors";
import type * as CustomerCognito from "./cognito";
import type { CustomerBase } from "./repository";
import type * as TwoFactor from "./two-factor";
import type { CustomerTwoFactor } from "./types";

const { describeTwoFactor, operatorCanResetTwoFactor, resetCustomerTwoFactor } = (await import(
  "./two-factor" + ".ts"
)) as typeof TwoFactor;
const { readTwoFactor, resetTwoFactor } = (await import("./cognito" + ".ts")) as typeof CustomerCognito;
const { ApiError, ServiceUnavailableError } = (await import("@/lib/api/errors" + ".ts")) as typeof Errors;

type Gateway = TwoFactor.TwoFactorResetGateway;
type PoolAccess = CustomerCognito.CustomerPoolAccess;

const CUSTOMER: CustomerBase = {
  id: "user-1",
  cognitoSub: "sub-1",
  email: "pat@example.com",
  isPrimary: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
  deletedAt: null,
  tenants: [],
  lastActiveAt: null,
  lastSeenAt: null,
  accountCount: 0,
  transactionCount: 0,
};

const ON: CustomerTwoFactor = { enabled: true, methods: ["authenticator", "passkey"], preferred: "authenticator" };
const OFF: CustomerTwoFactor = { enabled: false, methods: [], preferred: null };

/** A fresh operator per test: the rate limiter is per process and per key. */
function actor(signInMethod: TwoFactor.TwoFactorResetActor["signInMethod"] = "passkey"): TwoFactor.TwoFactorResetActor {
  return { userId: randomUUID(), signInMethod };
}

interface AuditRow {
  action: string;
  target_type: string;
  target_id: string | null | undefined;
  metadata: Record<string, unknown>;
}

/** A gateway that records the order of calls; every call can be overridden. */
function stubGateway(overrides: Partial<Gateway> = {}): { gateway: Gateway; calls: string[]; audits: AuditRow[] } {
  const calls: string[] = [];
  const audits: AuditRow[] = [];
  const record = <A extends unknown[], R>(name: string, fn: (...args: A) => R) => {
    return (...args: A): R => {
      calls.push(name);
      return fn(...args);
    };
  };
  let reads = 0;
  const base: Gateway = {
    findCustomerById: async () => ({ ...CUSTOMER }),
    availability: () => ({ canSend: true, reason: null }),
    // Before the reset the factor is on; after it, off.
    readTwoFactor: async () => (reads++ === 0 ? { ...ON } : { ...OFF }),
    resetTwoFactor: async () => undefined,
    writeAudit: async (data) => {
      audits.push({
        action: data.action,
        target_type: data.target_type,
        target_id: data.target_id,
        metadata: data.metadata as Record<string, unknown>,
      });
    },
  };
  const merged = { ...base, ...overrides };
  const gateway = Object.fromEntries(
    Object.entries(merged).map(([name, fn]) => [name, record(name, fn as (...args: unknown[]) => unknown)]),
  ) as unknown as Gateway;
  return { gateway, calls, audits };
}

interface PoolCall {
  command: string;
  input: Record<string, unknown>;
}

function stubPool(reply: unknown | Error): { pool: PoolAccess; calls: PoolCall[] } {
  const calls: PoolCall[] = [];
  const pool: PoolAccess = {
    userPoolId: "us-west-2_CUSTOMERS",
    send: async (command) => {
      calls.push({
        command: command.constructor.name.replace(/Command$/, ""),
        input: command.input as unknown as Record<string, unknown>,
      });
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { pool, calls };
}

/** An SDK-shaped error: the translation only reads `name`. */
function awsError(name: string): Error {
  const error = new Error(`${name}: something only an operator should read`);
  error.name = name;
  return error;
}

async function rejectsApi(promise: Promise<unknown>): Promise<Errors.ApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError, `not an ApiError: ${String(error)}`);
    return error;
  }
  assert.fail("expected a rejection");
}

/** Every console line written during a test, to prove the address is never logged. */
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

function assertAddressNeverLogged(): void {
  for (const line of logged) {
    assert.ok(!line.includes(CUSTOMER.email), `address logged: ${line}`);
  }
}

describe("operatorCanResetTwoFactor", () => {
  it("needs a second factor on the operator's own session", () => {
    assert.equal(operatorCanResetTwoFactor("password"), false);
    assert.equal(operatorCanResetTwoFactor("password+totp"), true);
    assert.equal(operatorCanResetTwoFactor("passkey"), true);
  });
});

describe("resetCustomerTwoFactor — the step-up guard", () => {
  it("refuses a password-only session with 403 before any other work", async () => {
    const { gateway, calls } = stubGateway();
    const error = await rejectsApi(resetCustomerTwoFactor(CUSTOMER.id, actor("password"), gateway));
    assert.equal(error.status, 403);
    assert.equal(error.code, "forbidden");
    assert.equal(error.message, "Sign in with your authenticator app or a passkey to use this.");
    assert.deepEqual(calls, []);
  });

  it("does not spend the rate limit on a refused session: the sixth attempt is still 403, not 429", async () => {
    const { gateway, calls } = stubGateway();
    const who = actor("password");
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const error = await rejectsApi(resetCustomerTwoFactor(CUSTOMER.id, who, gateway));
      assert.equal(error.status, 403, `attempt ${attempt + 1}`);
    }
    assert.deepEqual(calls, []);
  });
});

describe("resetCustomerTwoFactor — the rate limit", () => {
  it("allows five an hour per operator and refuses the sixth before Cognito is asked", async () => {
    const { gateway, calls } = stubGateway({ readTwoFactor: async () => ({ ...ON }) });
    const who = actor("password+totp");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await resetCustomerTwoFactor(CUSTOMER.id, who, gateway);
    }
    const resetsBefore = calls.filter((name) => name === "resetTwoFactor").length;
    assert.equal(resetsBefore, 5);
    const error = await rejectsApi(resetCustomerTwoFactor(CUSTOMER.id, who, gateway));
    assert.equal(error.status, 429);
    assert.equal(error.code, "rate_limited");
    assert.equal(calls.filter((name) => name === "readTwoFactor").length, 10);
    assert.equal(calls.filter((name) => name === "resetTwoFactor").length, 5);
    assert.equal(calls.filter((name) => name === "findCustomerById").length, 5);
  });

  it("is charged per operator, not per customer: another operator is not affected", async () => {
    const { gateway } = stubGateway({ readTwoFactor: async () => ({ ...ON }) });
    const first = actor();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await resetCustomerTwoFactor(CUSTOMER.id, first, gateway);
    }
    await resetCustomerTwoFactor(CUSTOMER.id, actor(), gateway);
  });
});

describe("resetCustomerTwoFactor — before Cognito", () => {
  it("an unknown customer is 404 and the pool is never asked", async () => {
    const { gateway, calls } = stubGateway({ findCustomerById: async () => null });
    const error = await rejectsApi(resetCustomerTwoFactor("nobody", actor(), gateway));
    assert.equal(error.status, 404);
    assert.equal(error.code, "not_found");
    assert.deepEqual(calls, ["findCustomerById"]);
  });

  it("a pool that is not configured is 503 cognito_unavailable with the reason, and no call", async () => {
    const { gateway, calls } = stubGateway({
      availability: () => ({ canSend: false, reason: "CUSTOMER_COGNITO_USER_POOL_ID is not set." }),
    });
    const error = await rejectsApi(resetCustomerTwoFactor(CUSTOMER.id, actor(), gateway));
    assert.equal(error.status, 503);
    assert.equal(error.code, "cognito_unavailable");
    assert.equal(error.message, "CUSTOMER_COGNITO_USER_POOL_ID is not set.");
    assert.deepEqual(calls, ["findCustomerById", "availability"]);
  });

  it("a failed read of the factors on file is the answer: no reset, no audit row", async () => {
    const { gateway, calls, audits } = stubGateway({
      readTwoFactor: async () => {
        throw new ServiceUnavailableError("cognito_unavailable", "refused");
      },
    });
    const error = await rejectsApi(resetCustomerTwoFactor(CUSTOMER.id, actor(), gateway));
    assert.equal(error.code, "cognito_unavailable");
    assert.deepEqual(calls, ["findCustomerById", "availability", "readTwoFactor"]);
    assert.deepEqual(audits, []);
  });
});

describe("resetCustomerTwoFactor — the reset", () => {
  it("reads before, resets, re-reads after, audits — in that order — and answers the re-read", async () => {
    const { gateway, calls, audits } = stubGateway();
    const result = await resetCustomerTwoFactor(CUSTOMER.id, actor(), gateway);
    assert.deepEqual(result, { twoFactor: OFF });
    assert.deepEqual(calls, [
      "findCustomerById",
      "availability",
      "readTwoFactor",
      "resetTwoFactor",
      "availability",
      "readTwoFactor",
      "writeAudit",
    ]);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, "customer_two_factor_reset");
    assert.equal(audits[0].target_type, "customer_two_factor_reset");
    assert.equal(audits[0].target_id, CUSTOMER.id);
    assert.equal(audits[0].metadata.target_label, CUSTOMER.email);
    assert.equal(audits[0].metadata.email, CUSTOMER.email);
    assert.equal(audits[0].metadata.cognitoSub, CUSTOMER.cognitoSub);
    assert.deepEqual(audits[0].metadata.methodsBefore, ["authenticator", "passkey"]);
    assert.deepEqual(audits[0].metadata.methodsAfter, []);
    assert.equal(logged.filter((line) => /turned off for sub sub-1/.test(line)).length, 1);
    assertAddressNeverLogged();
  });

  it("resets and reads the account by the customer's sub", async () => {
    const reads: string[] = [];
    let resetFor: string | undefined;
    const { gateway } = stubGateway({
      readTwoFactor: async (sub) => {
        reads.push(sub);
        return reads.length === 1 ? { ...ON } : { ...OFF };
      },
      resetTwoFactor: async (sub) => {
        resetFor = sub;
      },
    });
    await resetCustomerTwoFactor(CUSTOMER.id, actor(), gateway);
    assert.deepEqual(reads, [CUSTOMER.cognitoSub, CUSTOMER.cognitoSub]);
    assert.equal(resetFor, CUSTOMER.cognitoSub);
  });

  it("records the actor's admin_users.id on the audit row", async () => {
    let actorId: string | null | undefined;
    const { gateway } = stubGateway({
      writeAudit: async (data) => {
        actorId = data.actor_user_id;
      },
    });
    const who = actor();
    await resetCustomerTwoFactor(CUSTOMER.id, who, gateway);
    assert.equal(actorId, who.userId);
  });

  it("the audit row is best effort: a throwing write does not fail the reset", async () => {
    const { gateway, calls } = stubGateway({
      writeAudit: async () => {
        throw new Error('relation "admin_permission_audit_events" violates check constraint');
      },
    });
    const result = await resetCustomerTwoFactor(CUSTOMER.id, actor(), gateway);
    assert.deepEqual(result, { twoFactor: OFF });
    assert.ok(calls.includes("writeAudit"));
    assert.equal(logged.filter((line) => /audit skipped/.test(line)).length, 1);
  });

  it("a failed re-read answers null and still audits the reset", async () => {
    let reads = 0;
    const { gateway, audits } = stubGateway({
      readTwoFactor: async () => {
        if (reads++ === 0) return { ...ON };
        throw new ServiceUnavailableError("cognito_unavailable", "refused");
      },
    });
    const result = await resetCustomerTwoFactor(CUSTOMER.id, actor(), gateway);
    assert.deepEqual(result, { twoFactor: null });
    assert.equal(audits[0].action, "customer_two_factor_reset");
    assert.equal(audits[0].metadata.methodsAfter, null);
  });
});

describe("resetCustomerTwoFactor — when Cognito refuses", () => {
  it("rethrows the translated error and audits the failure with its code", async () => {
    const { gateway, calls, audits } = stubGateway({
      resetTwoFactor: async () => {
        throw new ServiceUnavailableError("cognito_unavailable", "no permission");
      },
    });
    const error = await rejectsApi(resetCustomerTwoFactor(CUSTOMER.id, actor(), gateway));
    assert.equal(error.status, 503);
    assert.equal(error.code, "cognito_unavailable");
    assert.equal(error.message, "no permission");
    assert.deepEqual(calls, ["findCustomerById", "availability", "readTwoFactor", "resetTwoFactor", "writeAudit"]);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, "customer_two_factor_reset_failed");
    assert.deepEqual(audits[0].metadata.methodsBefore, ["authenticator", "passkey"]);
    assert.equal(audits[0].metadata.reason, "cognito_unavailable");
  });

  it("turns anything that is not an ApiError into 503 cognito_unavailable", async () => {
    const { gateway, audits } = stubGateway({
      resetTwoFactor: async () => {
        throw new Error("ECONNRESET");
      },
    });
    const error = await rejectsApi(resetCustomerTwoFactor(CUSTOMER.id, actor(), gateway));
    assert.equal(error.status, 503);
    assert.equal(error.code, "cognito_unavailable");
    assert.equal(audits[0].metadata.reason, "cognito_unavailable");
  });

  it("a throwing audit write does not hide the refusal", async () => {
    const { gateway } = stubGateway({
      resetTwoFactor: async () => {
        throw new ServiceUnavailableError("cognito_unavailable", "no permission");
      },
      writeAudit: async () => {
        throw new Error("connection refused");
      },
    });
    const error = await rejectsApi(resetCustomerTwoFactor(CUSTOMER.id, actor(), gateway));
    assert.equal(error.code, "cognito_unavailable");
    assert.equal(logged.filter((line) => /audit skipped/.test(line)).length, 1);
  });
});

describe("describeTwoFactor", () => {
  it("is null without a call when the pool is not configured", async () => {
    const { gateway, calls } = stubGateway({ availability: () => ({ canSend: false, reason: "unset" }) });
    assert.equal(await describeTwoFactor("sub-1", gateway), null);
    assert.deepEqual(calls, ["availability"]);
  });

  it("is null when the read fails, logging only what the read did not already log", async () => {
    const { gateway } = stubGateway({
      readTwoFactor: async () => {
        throw new ServiceUnavailableError("cognito_unavailable", "refused");
      },
    });
    assert.equal(await describeTwoFactor("sub-1", gateway), null);
    assert.deepEqual(logged, []);
    const { gateway: faulty } = stubGateway({
      readTwoFactor: async () => {
        throw new Error("ECONNRESET");
      },
    });
    assert.equal(await describeTwoFactor("sub-1", faulty), null);
    assert.equal(logged.filter((line) => /two-factor read failed for sub sub-1/.test(line)).length, 1);
  });
});

describe("resetTwoFactor (the pool call)", () => {
  it("sends both settings off in one AdminSetUserMFAPreference addressed by the sub", async () => {
    const { pool, calls } = stubPool({});
    await resetTwoFactor("sub-1", pool);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "AdminSetUserMFAPreference");
    assert.equal(calls[0].input.UserPoolId, "us-west-2_CUSTOMERS");
    assert.equal(calls[0].input.Username, "sub-1");
    assert.deepEqual(calls[0].input.SoftwareTokenMfaSettings, { Enabled: false, PreferredMfa: false });
    assert.deepEqual(calls[0].input.WebAuthnMfaSettings, { Enabled: false });
    assert.deepEqual(logged, []);
  });

  it("a missing IAM permission is 503 cognito_unavailable, with the real reason in the log only", async () => {
    const { pool } = stubPool(awsError("AccessDeniedException"));
    const error = await rejectsApi(resetTwoFactor("sub-1", pool));
    assert.equal(error.status, 503);
    assert.equal(error.code, "cognito_unavailable");
    assert.ok(!error.message.includes("only an operator should read"));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /AccessDeniedException/);
  });

  it("an account that is not in the pool is 404", async () => {
    const { pool } = stubPool(awsError("UserNotFoundException"));
    const error = await rejectsApi(resetTwoFactor("sub-1", pool));
    assert.equal(error.status, 404);
  });
});

describe("readTwoFactor (the pool call)", () => {
  it("maps the pool's list onto the drawer's names", async () => {
    const { pool, calls } = stubPool({
      UserMFASettingList: ["SOFTWARE_TOKEN_MFA", "WEB_AUTHN_MFA"],
      PreferredMfaSetting: "SOFTWARE_TOKEN_MFA",
    });
    assert.deepEqual(await readTwoFactor("sub-1", pool), ON);
    assert.equal(calls[0].command, "AdminGetUser");
    assert.equal(calls[0].input.UserPoolId, "us-west-2_CUSTOMERS");
    assert.equal(calls[0].input.Username, "sub-1");
  });

  it("an empty or absent list is Off", async () => {
    assert.deepEqual(await readTwoFactor("sub-1", stubPool({}).pool), OFF);
    assert.deepEqual(await readTwoFactor("sub-1", stubPool({ UserMFASettingList: [] }).pool), OFF);
  });

  it("leaves out an entry it does not know rather than guessing", async () => {
    const { pool } = stubPool({ UserMFASettingList: ["SMS_MFA", "SOFTWARE_TOKEN_MFA"], PreferredMfaSetting: "SMS_MFA" });
    assert.deepEqual(await readTwoFactor("sub-1", pool), { enabled: true, methods: ["authenticator"], preferred: null });
  });
});
