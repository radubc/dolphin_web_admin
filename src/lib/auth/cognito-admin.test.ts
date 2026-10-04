/**
 * Unit tests for the admin-pool calls behind a recovery-code sign-in
 * (`./cognito-admin`), against a stubbed pool: nothing here talks to AWS.
 *
 *     npm test
 *
 * Same pattern as the consumer app's `src/lib/auth/cognito-admin.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type * as CognitoAdmin from "./cognito-admin";

const { adminFindUser, adminTurnOffSecondFactor } = (await import(
  "./cognito-admin" + ".ts"
)) as typeof CognitoAdmin;

type PoolAccess = CognitoAdmin.PoolAccess;

/** An SDK-shaped error: the wrapper only reads `name`. */
function awsError(name: string): Error {
  const error = new Error(`${name}: something only an operator should read`);
  error.name = name;
  return error;
}

interface Call {
  command: string;
  input: Record<string, unknown>;
}

function stubPool(script: Record<string, (unknown | Error)[]>): { pool: PoolAccess; calls: Call[] } {
  const calls: Call[] = [];
  const pool: PoolAccess = {
    userPoolId: "us-west-2_TEST",
    send: async (command) => {
      const name = command.constructor.name.replace(/Command$/, "");
      calls.push({ command: name, input: command.input as unknown as Record<string, unknown> });
      const queue = script[name] ?? [];
      const reply = queue.shift();
      if (reply === undefined) throw new Error(`unscripted ${name}`);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { pool, calls };
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

describe("adminFindUser", () => {
  it("answers the pool username and the sub, looked up by the address", async () => {
    const { pool, calls } = stubPool({
      AdminGetUser: [
        {
          Username: "uuid-username",
          UserAttributes: [
            { Name: "sub", Value: "sub-1" },
            { Name: "email", Value: "ann@example.com" },
          ],
        },
      ],
    });
    const result = await adminFindUser("ann@example.com", pool);
    assert.deepEqual(result, {
      ok: true,
      user: { username: "uuid-username", sub: "sub-1", email: "ann@example.com" },
    });
    assert.equal(calls[0].input.UserPoolId, "us-west-2_TEST");
    assert.equal(calls[0].input.Username, "ann@example.com");
    assert.deepEqual(logged, []);
  });

  it("matches the email attribute ignoring case and edges", async () => {
    const { pool } = stubPool({
      AdminGetUser: [
        {
          Username: "uuid-username",
          UserAttributes: [
            { Name: "sub", Value: "sub-1" },
            { Name: "email", Value: "ann@example.com" },
          ],
        },
      ],
    });
    const result = await adminFindUser(" Ann@Example.COM ", pool);
    assert.deepEqual(result, {
      ok: true,
      user: { username: "uuid-username", sub: "sub-1", email: "ann@example.com" },
    });
    assert.deepEqual(logged, []);
  });

  it("refuses a sign-in whose email attribute is not the address asked for", async () => {
    // The identity binding: the account acted on must be the one the password
    // was proven for, whatever the pool answers.
    const { pool } = stubPool({
      AdminGetUser: [
        {
          Username: "uuid-username",
          UserAttributes: [
            { Name: "sub", Value: "sub-1" },
            { Name: "email", Value: "victim@example.com" },
          ],
        },
      ],
    });
    const result = await adminFindUser("attacker@example.com", pool);
    assert.deepEqual(result, { ok: true, user: null });
    assert.equal(logged.length, 1);
    assert.ok(!logged[0].includes("victim@example.com"));
    assert.ok(!logged[0].includes("attacker@example.com"));
  });

  it("refuses an answer without an email attribute", async () => {
    const { pool } = stubPool({
      AdminGetUser: [{ Username: "uuid-username", UserAttributes: [{ Name: "sub", Value: "sub-1" }] }],
    });
    const result = await adminFindUser("ann@example.com", pool);
    assert.deepEqual(result, { ok: true, user: null });
    assert.equal(logged.length, 1);
    assert.ok(!logged[0].includes("ann@example.com"));
  });

  it("answers null for an unknown sign-in, without logging the address", async () => {
    const { pool } = stubPool({ AdminGetUser: [awsError("UserNotFoundException")] });
    const result = await adminFindUser("nobody@example.com", pool);
    assert.deepEqual(result, { ok: true, user: null });
    assert.deepEqual(logged, []);
  });

  it("reports a refusal with the permission and policy names, never the address", async () => {
    const { pool } = stubPool({ AdminGetUser: [awsError("AccessDeniedException")] });
    const result = await adminFindUser("ann@example.com", pool);
    assert.deepEqual(result, { ok: false });
    assert.equal(logged.length, 1);
    assert.match(logged[0], /cognito-idp:AdminGetUser/);
    assert.match(logged[0], /AccessDeniedException/);
    assert.match(logged[0], /operator-recovery/);
    assert.ok(!logged[0].includes("ann@example.com"));
    assert.ok(!logged[0].includes("only an operator should read"));
  });

  it("treats an answer without a sub as unavailable", async () => {
    const { pool } = stubPool({ AdminGetUser: [{ Username: "uuid-username", UserAttributes: [] }] });
    const result = await adminFindUser("ann@example.com", pool);
    assert.deepEqual(result, { ok: false });
    assert.equal(logged.length, 1);
  });
});

describe("adminTurnOffSecondFactor", () => {
  it("turns the authenticator and passkey MFA off in one call", async () => {
    const { pool, calls } = stubPool({ AdminSetUserMFAPreference: [{}] });
    const result = await adminTurnOffSecondFactor("uuid-username", pool);
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "AdminSetUserMFAPreference");
    assert.equal(calls[0].input.UserPoolId, "us-west-2_TEST");
    assert.equal(calls[0].input.Username, "uuid-username");
    assert.deepEqual(calls[0].input.SoftwareTokenMfaSettings, { Enabled: false, PreferredMfa: false });
    assert.deepEqual(calls[0].input.WebAuthnMfaSettings, { Enabled: false });
    assert.deepEqual(logged, []);
  });

  it("names the permission and the policy when AWS refuses", async () => {
    const { pool } = stubPool({ AdminSetUserMFAPreference: [awsError("AccessDeniedException")] });
    const result = await adminTurnOffSecondFactor("uuid-username", pool);
    assert.deepEqual(result, { ok: false });
    assert.equal(logged.length, 1);
    assert.match(logged[0], /cognito-idp:AdminSetUserMFAPreference/);
    assert.match(logged[0], /operator-recovery/);
    assert.ok(!logged[0].includes("only an operator should read"));
  });

  it("logs a throttle as a warning and still answers a refusal", async () => {
    const { pool } = stubPool({ AdminSetUserMFAPreference: [awsError("TooManyRequestsException")] });
    const result = await adminTurnOffSecondFactor("uuid-username", pool);
    assert.deepEqual(result, { ok: false });
    assert.equal(logged.length, 1);
    assert.match(logged[0], /throttled/);
  });
});
