/**
 * Unit tests for `ensurePasskeyMfa` (`./passkey-mfa`, phase A of
 * `docs/two-factor-plan.md`) against a stubbed gateway, and for
 * `isPasskeyMfaListed` in `./service`. Nothing here talks to AWS.
 *
 *     npm test
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type * as PasskeyMfa from "./passkey-mfa";
import type * as Service from "./service";
import type { MfaStatus, Passkey } from "./types";

const { ensurePasskeyMfa } = (await import("./passkey-mfa" + ".ts")) as typeof PasskeyMfa;
const { isPasskeyMfaListed } = (await import("./service" + ".ts")) as typeof Service;

type Gateway = PasskeyMfa.PasskeyMfaGateway;

const TOKEN = "access-token";

const PASSKEY: Passkey = {
  id: "cred-1",
  name: "MacBook",
  relyingPartyId: "admin.fairsums.app",
  attachment: "platform",
  transports: ["internal"],
  createdAt: "2026-10-04T00:00:00.000Z",
};

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
    getMfaStatus: async () => status({ passkeySignInPaused: true }),
    listPasskeys: async () => [PASSKEY],
    setPasskeyMfaPreference: async () => undefined,
  };
  const merged = { ...base, ...overrides };
  const gateway = Object.fromEntries(
    Object.entries(merged).map(([name, fn]) => [name, record(name, fn as (...args: unknown[]) => unknown)]),
  ) as unknown as Gateway;
  return { gateway, calls };
}

/** Every console line written during a test. */
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

describe("ensurePasskeyMfa — when the flag is set", () => {
  it("sets it for TOTP on, a passkey, flag off (every fact supplied: nothing is read)", async () => {
    const { gateway, calls } = stubGateway();
    const result = await ensurePasskeyMfa(TOKEN, { status: status(), hasPasskeys: true }, gateway);
    assert.deepEqual(result, { passkeyMfaEnabled: true, passkeySignInPaused: false });
    assert.deepEqual(calls, ["setPasskeyMfaPreference"]);
    assert.deepEqual(logged, []);
  });

  it("passes the access token through to the set call", async () => {
    let seen: [string, boolean] | undefined;
    const { gateway } = stubGateway({
      setPasskeyMfaPreference: async (accessToken, enabled) => {
        seen = [accessToken, enabled];
      },
    });
    await ensurePasskeyMfa(TOKEN, { status: status(), hasPasskeys: true }, gateway);
    assert.deepEqual(seen, [TOKEN, true]);
  });

  it("lists the passkeys only when the caller did not say whether any exist", async () => {
    const { gateway, calls } = stubGateway();
    const result = await ensurePasskeyMfa(TOKEN, { status: status() }, gateway);
    assert.deepEqual(result, { passkeyMfaEnabled: true, passkeySignInPaused: false });
    assert.deepEqual(calls, ["listPasskeys", "setPasskeyMfaPreference"]);
  });

  it("reads the status only when the caller did not supply it, and reuses its passkey answer", async () => {
    // `getMfaStatus` already listed the passkeys for exactly this case and
    // reported them as `passkeySignInPaused`; the list is not asked for again.
    const { gateway, calls } = stubGateway();
    const result = await ensurePasskeyMfa(TOKEN, {}, gateway);
    assert.deepEqual(result, { passkeyMfaEnabled: true, passkeySignInPaused: false });
    assert.deepEqual(calls, ["getMfaStatus", "setPasskeyMfaPreference"]);
  });

  it("defaults the facts to an empty object", async () => {
    const { gateway, calls } = stubGateway();
    await ensurePasskeyMfa(TOKEN, undefined, gateway);
    assert.deepEqual(calls, ["getMfaStatus", "setPasskeyMfaPreference"]);
  });
});

describe("ensurePasskeyMfa — when the flag is left alone", () => {
  it("does nothing while TOTP is off", async () => {
    const { gateway, calls } = stubGateway();
    const result = await ensurePasskeyMfa(TOKEN, { status: status({ totpEnabled: false }), hasPasskeys: true }, gateway);
    assert.deepEqual(result, { passkeyMfaEnabled: false, passkeySignInPaused: false });
    assert.deepEqual(calls, []);
  });

  it("does nothing when passkey MFA is already on", async () => {
    const { gateway, calls } = stubGateway();
    const result = await ensurePasskeyMfa(
      TOKEN,
      { status: status({ passkeyMfaEnabled: true, methods: ["SOFTWARE_TOKEN_MFA", "WEB_AUTHN_MFA"] }) },
      gateway,
    );
    assert.deepEqual(result, { passkeyMfaEnabled: true, passkeySignInPaused: false });
    assert.deepEqual(calls, []);
  });

  it("does nothing when the caller says there are no passkeys", async () => {
    const { gateway, calls } = stubGateway();
    const result = await ensurePasskeyMfa(TOKEN, { status: status(), hasPasskeys: false }, gateway);
    assert.deepEqual(result, { passkeyMfaEnabled: false, passkeySignInPaused: false });
    assert.deepEqual(calls, []);
  });

  it("does nothing when the list comes back empty", async () => {
    const { gateway, calls } = stubGateway({ listPasskeys: async () => [] });
    const result = await ensurePasskeyMfa(TOKEN, { status: status() }, gateway);
    assert.deepEqual(result, { passkeyMfaEnabled: false, passkeySignInPaused: false });
    assert.deepEqual(calls, ["listPasskeys"]);
  });

  it("does nothing when the status read says TOTP on, flag off and not paused (no passkeys)", async () => {
    const { gateway, calls } = stubGateway({ getMfaStatus: async () => status({ passkeySignInPaused: false }) });
    const result = await ensurePasskeyMfa(TOKEN, {}, gateway);
    assert.deepEqual(result, { passkeyMfaEnabled: false, passkeySignInPaused: false });
    assert.deepEqual(calls, ["getMfaStatus"]);
  });

  it("does nothing when the status read says the flag is already on", async () => {
    const { gateway, calls } = stubGateway({ getMfaStatus: async () => status({ passkeyMfaEnabled: true }) });
    const result = await ensurePasskeyMfa(TOKEN, {}, gateway);
    assert.deepEqual(result, { passkeyMfaEnabled: true, passkeySignInPaused: false });
    assert.deepEqual(calls, ["getMfaStatus"]);
  });
});

describe("ensurePasskeyMfa — never throws", () => {
  it("reports passkey sign-in as paused when Cognito refuses the flag", async () => {
    const { gateway } = stubGateway({
      setPasskeyMfaPreference: async () => {
        throw new Error("InvalidParameterException: WebAuthn MFA requires enabling an additional MFA setting.");
      },
    });
    const result = await ensurePasskeyMfa(TOKEN, { status: status(), hasPasskeys: true }, gateway);
    assert.deepEqual(result, { passkeyMfaEnabled: false, passkeySignInPaused: true });
    // The service has already logged the refusal; this module adds nothing.
    assert.deepEqual(logged, []);
  });

  it("skips the check, unchanged, when the status read fails", async () => {
    const { gateway, calls } = stubGateway({
      getMfaStatus: async () => {
        throw new Error("NotAuthorizedException");
      },
    });
    const result = await ensurePasskeyMfa(TOKEN, {}, gateway);
    assert.deepEqual(result, { passkeyMfaEnabled: false, passkeySignInPaused: false });
    assert.deepEqual(calls, ["getMfaStatus"]);
    assert.equal(logged.filter((line) => /passkey MFA check skipped/.test(line)).length, 1);
  });

  it("skips the check, unchanged, when the passkey list fails", async () => {
    const { gateway, calls } = stubGateway({
      listPasskeys: async () => {
        throw new Error("InternalErrorException");
      },
    });
    const result = await ensurePasskeyMfa(TOKEN, { status: status() }, gateway);
    assert.deepEqual(result, { passkeyMfaEnabled: false, passkeySignInPaused: false });
    assert.deepEqual(calls, ["listPasskeys"]);
    assert.equal(logged.filter((line) => /passkey MFA check skipped/.test(line)).length, 1);
  });

  it("skips the check when the gateway throws something that is not an Error", async () => {
    const { gateway } = stubGateway({
      getMfaStatus: async () => {
        throw "no config";
      },
    });
    const result = await ensurePasskeyMfa(TOKEN, {}, gateway);
    assert.deepEqual(result, { passkeyMfaEnabled: false, passkeySignInPaused: false });
  });
});

describe("isPasskeyMfaListed", () => {
  it("matches WEB_AUTHN_MFA and not the authenticator app", () => {
    assert.equal(isPasskeyMfaListed(["WEB_AUTHN_MFA"]), true);
    assert.equal(isPasskeyMfaListed(["SOFTWARE_TOKEN_MFA", "WEB_AUTHN_MFA"]), true);
    assert.equal(isPasskeyMfaListed(["SOFTWARE_TOKEN_MFA"]), false);
    assert.equal(isPasskeyMfaListed(["SMS_MFA"]), false);
    assert.equal(isPasskeyMfaListed([]), false);
  });

  it("is case-insensitive about the spelling", () => {
    assert.equal(isPasskeyMfaListed(["web_authn_mfa"]), true);
  });
});
