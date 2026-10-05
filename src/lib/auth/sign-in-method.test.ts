/**
 * Unit tests for the signed sign-in-method cookie (`./sign-in-method`, phase C
 * of `docs/two-factor-plan.md`): a forged, re-targeted or unbound value must
 * always read as `password`. No Next, no Cognito.
 *
 *     npm test
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import type * as SignInMethodModule from "./sign-in-method";

const { SIGN_IN_METHODS, isSecondFactorSignIn, isSignInMethod, signInMethodCookieValue, signInMethodFrom } =
  (await import("./sign-in-method" + ".ts")) as typeof SignInMethodModule;

type SignInMethod = SignInMethodModule.SignInMethod;

/** An unsigned JWT with the given payload: only `sub`/`origin_jti` are read. */
function token(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", kid: "test" })}.${part(payload)}.signature`;
}

const SUB = "11111111-1111-1111-1111-111111111111";
const JTI = "22222222-2222-2222-2222-222222222222";

/** Every console line written during a test, to prove the cookie's content is never logged. */
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

describe("the method names", () => {
  it("are the three sign-in paths, and only a password alone is not a second factor", () => {
    assert.deepEqual([...SIGN_IN_METHODS], ["password", "password+totp", "passkey"]);
    assert.equal(isSecondFactorSignIn("password"), false);
    assert.equal(isSecondFactorSignIn("password+totp"), true);
    assert.equal(isSecondFactorSignIn("passkey"), true);
    assert.equal(isSignInMethod("passkey"), true);
    assert.equal(isSignInMethod("admin"), false);
    assert.equal(isSignInMethod(""), false);
  });
});

describe("the round trip", () => {
  for (const method of SIGN_IN_METHODS) {
    it(`signs and reads back "${method}"`, () => {
      const value = signInMethodCookieValue(method, token({ sub: SUB, origin_jti: JTI }));
      assert.ok(value !== null);
      assert.ok(value.startsWith(`${method}.`));
      assert.equal(signInMethodFrom(value, { sub: SUB, origin_jti: JTI }), method);
      assert.deepEqual(logged, []);
    });
  }

  it("signs differently for each method, so one cannot be renamed into another", () => {
    const values = SIGN_IN_METHODS.map((method) => signInMethodCookieValue(method, token({ sub: SUB, origin_jti: JTI })));
    const signatures = values.map((value) => value?.split(".")[1]);
    assert.equal(new Set(signatures).size, SIGN_IN_METHODS.length);
  });
});

describe("what reads as password", () => {
  const payload = { sub: SUB, origin_jti: JTI };

  it("no cookie, or an empty one", () => {
    assert.equal(signInMethodFrom(undefined, payload), "password");
    assert.equal(signInMethodFrom("", payload), "password");
    assert.deepEqual(logged, []);
  });

  it("a forged value with no signature at all", () => {
    assert.equal(signInMethodFrom("passkey", payload), "password");
    assert.equal(signInMethodFrom("password+totp", payload), "password");
  });

  it("a forged value with a made-up signature, logged without the cookie's content", () => {
    assert.equal(signInMethodFrom("passkey.not-a-real-signature-xxxxxxxxxxxxxxxxxxxxxxxx", payload), "password");
    assert.equal(logged.length, 1);
    assert.match(logged[0], /did not verify/);
    assert.ok(!logged[0].includes("not-a-real-signature"));
  });

  it("a value whose method is not one of the three, even with a plausible signature", () => {
    const real = signInMethodCookieValue("passkey", token(payload));
    const signature = real?.split(".")[1];
    assert.equal(signInMethodFrom(`admin.${signature}`, payload), "password");
    assert.equal(signInMethodFrom(`superuser.${signature}`, payload), "password");
  });

  it("a signature of the wrong length — the constant-time compare does not throw", () => {
    assert.equal(signInMethodFrom("passkey.abc", payload), "password");
    assert.equal(signInMethodFrom("passkey.", payload), "password");
    assert.equal(signInMethodFrom(`passkey.${"a".repeat(200)}`, payload), "password");
  });

  it("a value signed for another subject", () => {
    const value = signInMethodCookieValue("passkey", token({ sub: "someone-else", origin_jti: JTI }));
    assert.ok(value !== null);
    assert.equal(signInMethodFrom(value, payload), "password");
  });

  it("a value signed for another sign-in of the same subject (a different origin_jti)", () => {
    const value = signInMethodCookieValue("passkey", token({ sub: SUB, origin_jti: "another-sign-in" }));
    assert.ok(value !== null);
    assert.equal(signInMethodFrom(value, payload), "password");
  });

  it("a verified payload without origin_jti, whatever the cookie says", () => {
    const value = signInMethodCookieValue("passkey", token(payload));
    assert.ok(value !== null);
    assert.equal(signInMethodFrom(value, { sub: SUB }), "password");
    assert.equal(signInMethodFrom(value, { sub: SUB, origin_jti: "" }), "password");
    assert.equal(signInMethodFrom(value, { sub: SUB, origin_jti: 42 }), "password");
    // Refused before any signature check: nothing to log.
    assert.deepEqual(logged, []);
  });
});

describe("what gets no cookie at all", () => {
  it("a token without origin_jti (token revocation off on the app client)", () => {
    assert.equal(signInMethodCookieValue("passkey", token({ sub: SUB })), null);
    assert.equal(signInMethodCookieValue("passkey", token({ sub: SUB, origin_jti: "" })), null);
    assert.deepEqual(logged, []);
  });

  it("a token without a subject", () => {
    assert.equal(signInMethodCookieValue("passkey", token({ origin_jti: JTI })), null);
    assert.equal(signInMethodCookieValue("passkey", token({ sub: "", origin_jti: JTI })), null);
  });

  it("something that is not a JWT, logged as an error and never thrown", () => {
    assert.equal(signInMethodCookieValue("passkey", "not-a-token"), null);
    assert.equal(signInMethodCookieValue("passkey", ""), null);
    assert.equal(logged.length, 2);
    assert.match(logged[0], /Could not read a token's subject/);
  });
});

describe("the key", () => {
  const names = [
    "ADMIN_COGNITO_REGION",
    "ADMIN_COGNITO_USER_POOL_ID",
    "ADMIN_COGNITO_CLIENT_ID",
    "ADMIN_COGNITO_CLIENT_SECRET",
    "COGNITO_CLIENT_SECRET",
  ] as const;
  const saved: Partial<Record<(typeof names)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const name of names) saved[name] = process.env[name];
    // Made-up values: the test never reads `.env`.
    process.env.ADMIN_COGNITO_REGION = "us-west-2";
    process.env.ADMIN_COGNITO_USER_POOL_ID = "us-west-2_TEST";
    process.env.ADMIN_COGNITO_CLIENT_ID = "client-id";
    process.env.ADMIN_COGNITO_CLIENT_SECRET = "test-client-secret";
  });
  afterEach(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("is derived from the client secret, so every task signs and verifies the same value", () => {
    // The derivation `docs/auth.md` describes: HMAC-SHA256(secret, cookie name)
    // keys an HMAC-SHA256 over `sub \n origin_jti \n method`, base64url.
    const key = createHmac("sha256", "test-client-secret").update("psa_sign_in_method").digest();
    const expected = createHmac("sha256", key).update(`${SUB}\n${JTI}\npasskey`).digest("base64url");
    const value = signInMethodCookieValue("passkey", token({ sub: SUB, origin_jti: JTI }));
    assert.equal(value, `passkey.${expected}`);
    assert.equal(signInMethodFrom(value ?? undefined, { sub: SUB, origin_jti: JTI }), "passkey");
  });

  it("changes with the secret: a value signed under another secret reads as password", () => {
    const value = signInMethodCookieValue("passkey", token({ sub: SUB, origin_jti: JTI }));
    process.env.ADMIN_COGNITO_CLIENT_SECRET = "rotated-client-secret";
    assert.equal(signInMethodFrom(value ?? undefined, { sub: SUB, origin_jti: JTI }), "password");
  });

  it("falls back to a per-process random key without a secret, which still round-trips", () => {
    delete process.env.ADMIN_COGNITO_CLIENT_SECRET;
    delete process.env.COGNITO_CLIENT_SECRET;
    const method: SignInMethod = "password+totp";
    const value = signInMethodCookieValue(method, token({ sub: SUB, origin_jti: JTI }));
    assert.ok(value !== null);
    assert.equal(signInMethodFrom(value, { sub: SUB, origin_jti: JTI }), method);
  });
});
