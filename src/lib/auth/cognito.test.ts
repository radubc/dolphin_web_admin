/**
 * Unit tests for `verifyPasswordForSensitiveAction` (`./cognito`, phase B of
 * `docs/two-factor-plan.md`) against a stubbed client: nothing here talks to
 * AWS. The pool variables are set to made-up values below — the test never
 * reads `.env` — because the function builds its request from them.
 *
 *     npm test
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type {
  ChallengeNameType,
  InitiateAuthCommand,
  InitiateAuthCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import type * as Cognito from "./cognito";

// Before the module is loaded, so nothing in it can have read the real
// environment first (it reads lazily anyway). Restored when the file ends,
// so the values cannot leak into another file sharing the process.
const ENV_NAMES = [
  "ADMIN_COGNITO_REGION",
  "ADMIN_COGNITO_USER_POOL_ID",
  "ADMIN_COGNITO_CLIENT_ID",
  "ADMIN_COGNITO_CLIENT_SECRET",
  "COGNITO_CLIENT_SECRET",
] as const;
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
after(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});
process.env.ADMIN_COGNITO_REGION = "us-west-2";
process.env.ADMIN_COGNITO_USER_POOL_ID = "us-west-2_TEST";
process.env.ADMIN_COGNITO_CLIENT_ID = "test-client-id";
process.env.ADMIN_COGNITO_CLIENT_SECRET = "test-client-secret";
process.env.COGNITO_CLIENT_SECRET = "";

const { verifyPasswordForSensitiveAction } = (await import("./cognito" + ".ts")) as typeof Cognito;

const EMAIL = "ann@example.com";
const PASSWORD = "hunter2-but-longer";

/** An SDK-shaped error: the function only reads `name`. */
function awsError(name: string): Error {
  const error = new Error(`${name}: something only an operator should read`);
  error.name = name;
  return error;
}

function stubClient(
  reply: Partial<InitiateAuthCommandOutput> | Error,
): { client: Cognito.PasswordCheckClient; inputs: InitiateAuthCommand["input"][] } {
  const inputs: InitiateAuthCommand["input"][] = [];
  const client: Cognito.PasswordCheckClient = {
    send: async (command) => {
      inputs.push(command.input);
      if (reply instanceof Error) throw reply;
      return { $metadata: {}, ...reply };
    },
  };
  return { client, inputs };
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

function assertPasswordNeverLogged(): void {
  for (const line of logged) {
    assert.ok(!line.includes(PASSWORD), `password logged: ${line}`);
  }
}

describe("verifyPasswordForSensitiveAction — the request", () => {
  it("is one USER_PASSWORD_AUTH InitiateAuth with the SECRET_HASH over the address", async () => {
    const { client, inputs } = stubClient({ ChallengeName: "SOFTWARE_TOKEN_MFA" });
    await verifyPasswordForSensitiveAction(EMAIL, PASSWORD, client);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].AuthFlow, "USER_PASSWORD_AUTH");
    assert.equal(inputs[0].ClientId, "test-client-id");
    const expectedHash = createHmac("sha256", "test-client-secret")
      .update(`${EMAIL}test-client-id`)
      .digest("base64");
    assert.deepEqual(inputs[0].AuthParameters, {
      USERNAME: EMAIL,
      PASSWORD,
      SECRET_HASH: expectedHash,
    });
  });

  it("sends no SECRET_HASH when the app client has no secret", async () => {
    const saved = process.env.ADMIN_COGNITO_CLIENT_SECRET;
    process.env.ADMIN_COGNITO_CLIENT_SECRET = "";
    try {
      const { client, inputs } = stubClient({ ChallengeName: "SOFTWARE_TOKEN_MFA" });
      await verifyPasswordForSensitiveAction(EMAIL, PASSWORD, client);
      assert.deepEqual(inputs[0].AuthParameters, { USERNAME: EMAIL, PASSWORD });
    } finally {
      process.env.ADMIN_COGNITO_CLIENT_SECRET = saved;
    }
  });
});

describe("verifyPasswordForSensitiveAction — proof", () => {
  it("tokens are proof `tokens`, mapped onto SignInTokens", async () => {
    const { client } = stubClient({
      AuthenticationResult: {
        IdToken: "id",
        AccessToken: "access",
        RefreshToken: "refresh",
        ExpiresIn: 900,
      },
    });
    const result = await verifyPasswordForSensitiveAction(EMAIL, PASSWORD, client);
    assert.deepEqual(result, {
      ok: true,
      proof: "tokens",
      tokens: { idToken: "id", accessToken: "access", refreshToken: "refresh", expiresIn: 900 },
    });
    assert.deepEqual(logged, []);
  });

  it("falls back to an hour when the result carries no ExpiresIn", async () => {
    const { client } = stubClient({ AuthenticationResult: { IdToken: "id", AccessToken: "access" } });
    const result = await verifyPasswordForSensitiveAction(EMAIL, PASSWORD, client);
    assert.ok(result.ok);
    assert.equal(result.tokens?.expiresIn, 3600);
    assert.equal(result.tokens?.refreshToken, undefined);
  });

  it("a SOFTWARE_TOKEN_MFA challenge is proof `challenge`, left unanswered", async () => {
    const { client, inputs } = stubClient({ ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "opaque" });
    const result = await verifyPasswordForSensitiveAction(EMAIL, PASSWORD, client);
    assert.deepEqual(result, { ok: true, proof: "challenge", challengeName: "SOFTWARE_TOKEN_MFA" });
    // One call only: the challenge is never answered.
    assert.equal(inputs.length, 1);
    assert.equal(logged.filter((line) => /not answered here/.test(line)).length, 1);
    assertPasswordNeverLogged();
  });

  it("the other second-factor challenges are proof too", async () => {
    for (const name of ["SMS_MFA", "EMAIL_OTP", "SELECT_MFA_TYPE", "MFA_SETUP", "WEB_AUTHN"] as ChallengeNameType[]) {
      const { client } = stubClient({ ChallengeName: name });
      const result = await verifyPasswordForSensitiveAction(EMAIL, PASSWORD, client);
      assert.deepEqual(result, { ok: true, proof: "challenge", challengeName: name }, name);
    }
  });
});

describe("verifyPasswordForSensitiveAction — refusals", () => {
  it("NEW_PASSWORD_REQUIRED is failure `challenge`: a temporary password proves nothing", async () => {
    const { client } = stubClient({ ChallengeName: "NEW_PASSWORD_REQUIRED" });
    const result = await verifyPasswordForSensitiveAction(EMAIL, PASSWORD, client);
    assert.deepEqual(result, { ok: false, failure: "challenge" });
    assert.equal(logged.filter((line) => /not proof of the password/.test(line)).length, 1);
  });

  it("an unrecognised challenge is failure `challenge` as well", async () => {
    // Not a name the SDK knows today; the function must refuse it all the same.
    const { client } = stubClient({ ChallengeName: "SOMETHING_NEW" as ChallengeNameType });
    assert.deepEqual(await verifyPasswordForSensitiveAction(EMAIL, PASSWORD, client), {
      ok: false,
      failure: "challenge",
    });
  });

  for (const name of [
    "NotAuthorizedException",
    "UserNotFoundException",
    "InvalidPasswordException",
    "UserNotConfirmedException",
    "PasswordResetRequiredException",
  ]) {
    it(`${name} is failure \`incorrect\`, logged by name only`, async () => {
      const { client } = stubClient(awsError(name));
      assert.deepEqual(await verifyPasswordForSensitiveAction(EMAIL, PASSWORD, client), {
        ok: false,
        failure: "incorrect",
      });
      assert.equal(logged.length, 1);
      assert.match(logged[0], new RegExp(name));
      assert.ok(!logged[0].includes("only an operator should read"));
      assert.ok(!logged[0].includes(EMAIL));
      assertPasswordNeverLogged();
    });
  }

  it("a throttle is failure `unavailable`, never 'wrong password'", async () => {
    const { client } = stubClient(awsError("TooManyRequestsException"));
    assert.deepEqual(await verifyPasswordForSensitiveAction(EMAIL, PASSWORD, client), {
      ok: false,
      failure: "unavailable",
    });
    assert.equal(logged.filter((line) => /could not be completed/.test(line)).length, 1);
    assertPasswordNeverLogged();
  });

  it("a network fault is failure `unavailable`", async () => {
    const { client } = stubClient(new Error("ECONNRESET"));
    assert.deepEqual(await verifyPasswordForSensitiveAction(EMAIL, PASSWORD, client), {
      ok: false,
      failure: "unavailable",
    });
  });

  it("an answer with neither tokens nor a challenge is failure `unavailable`", async () => {
    const { client } = stubClient({});
    assert.deepEqual(await verifyPasswordForSensitiveAction(EMAIL, PASSWORD, client), {
      ok: false,
      failure: "unavailable",
    });
    const { client: halfClient } = stubClient({ AuthenticationResult: { IdToken: "id" } });
    assert.deepEqual(await verifyPasswordForSensitiveAction(EMAIL, PASSWORD, halfClient), {
      ok: false,
      failure: "unavailable",
    });
  });
});
