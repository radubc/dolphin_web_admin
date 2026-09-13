import "server-only";

import { randomInt } from "node:crypto";
/**
 * The customer Cognito user pool, as the admin console reads and writes it.
 *
 * This is the **consumer app's** pool, never the admin pool: the config comes
 * from `./config.ts` (`CUSTOMER_COGNITO_USER_POOL_ID`) and nothing here can
 * fall back to `ADMIN_COGNITO_USER_POOL_ID`. Everything below is an `Admin…`
 * API, which means SigV4 and IAM: the deployment's AWS credentials (from the
 * SDK's default provider chain) must be allowed `cognito-idp:ListUsers`,
 * `AdminCreateUser`, `AdminGetUser` and `AdminDeleteUser` on the pool ARN. We
 * never read, hold or log a credential.
 *
 * Two decisions worth knowing:
 *
 * - **One listing per request, not one call per row.** Asking for a page of
 *   50 customers with `ListUsers Filter: 'sub = "…"'` is 50 signed calls.
 *   Instead the whole pool is paged through once (`Limit` 60) and indexed by
 *   the `sub` attribute. That is fine while the pool is small — a few
 *   thousand accounts — and has to be replaced by a per-sub filter, or by
 *   storing the pool state, when it is not.
 * - **A 60-second in-process cache**, keyed by pool id, so the customer list,
 *   the header counts and the invite list in the same page load share one
 *   listing. It is per process (like the rate limiter), so N instances mean N
 *   listings; that is a cost question, not a correctness one.
 *
 * Failures are translated into the API's own errors (`translateCognitoError`)
 * so a route can simply rethrow: a missing IAM permission becomes a 503
 * `cognito_unavailable` that says so, not a generic 500. The real error is
 * logged with a `[customers]` prefix.
 */
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type AttributeType,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  ApiError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  ValidationError,
} from "@/lib/api/errors";
import type { CustomerCognitoAccount } from "./types";
import {
  getCustomerCognitoConfig,
  tryCustomerCognitoConfig,
  type CustomerCognitoConfig,
} from "./config";

/* -------------------------------------------------------------------------- */
/*                                   Client                                   */
/* -------------------------------------------------------------------------- */

let cachedClient: { key: string; client: CognitoIdentityProviderClient } | null = null;

/**
 * One client per region, reused across requests. Credentials come from the
 * SDK's default provider chain; nothing is passed in here.
 */
function getClient(config: CustomerCognitoConfig): CognitoIdentityProviderClient {
  if (cachedClient?.key !== config.region) {
    cachedClient = {
      key: config.region,
      client: new CognitoIdentityProviderClient({ region: config.region }),
    };
  }
  return cachedClient.client;
}

/* -------------------------------------------------------------------------- */
/*                              Error translation                             */
/* -------------------------------------------------------------------------- */

/** The 503 code the API answers when the pool cannot be reached or used. */
export const COGNITO_UNAVAILABLE = "cognito_unavailable";

/**
 * The message `translateCognitoError` gives an `UnsupportedUserStateException`
 * or `PreconditionNotMetException` on a resend: the account has already been
 * confirmed (or is otherwise past the temporary-password state), so there is
 * no invitation left to re-issue. Exported so `resendInvite` in `invites.ts`
 * can recognise this specific refusal and reconcile the row instead of
 * recording the sentence as its `error`.
 */
export const INVITE_ALREADY_USED_MESSAGE =
  "This account has already been used; the invitation cannot be resent.";

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return String((error as { name?: string } | null)?.name ?? "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turns a Cognito/SDK failure into a client-facing `ApiError`.
 *
 * Anything that means "this deployment is not allowed to talk to the pool" is
 * a 503 with an explanation an operator can act on, because there is nothing
 * the caller did wrong and nothing they can change. The underlying error is
 * logged; the client never sees an IAM message it could mine.
 */
export function translateCognitoError(error: unknown, what: string): ApiError {
  if (error instanceof ApiError) return error;
  const name = errorName(error);
  switch (name) {
    case "UsernameExistsException":
      return new ConflictError("An account with this email already exists in the customer pool.");
    case "UserNotFoundException":
      return new NotFoundError("That account does not exist in the customer pool.");
    case "UnsupportedUserStateException":
    case "PreconditionNotMetException":
      return new ConflictError(INVITE_ALREADY_USED_MESSAGE);
    case "InvalidParameterException":
    case "InvalidPasswordException":
    case "InvalidEmailRoleAccessPolicyException":
      // Cognito's own message can name the pool, an ARN or an attribute
      // schema — none of that belongs in a client-facing response. The real
      // text is logged; the caller gets a fixed, neutral sentence.
      console.error(`[customers] ${what} rejected: ${name}: ${errorMessage(error)}`);
      return new ValidationError("Cognito rejected the request as invalid. Check the address and try again.");
    case "LimitExceededException":
    case "TooManyRequestsException":
      return new TooManyRequestsError(30, undefined, "Cognito is throttling this pool. Try again shortly.");
    case "NotAuthorizedException":
    case "AccessDeniedException":
    case "CredentialsProviderError":
    case "UnrecognizedClientException":
    case "ExpiredTokenException":
      console.error(`[customers] ${what} refused by AWS: ${name}: ${errorMessage(error)}`);
      return new ServiceUnavailableError(
        COGNITO_UNAVAILABLE,
        "This deployment's AWS credentials or IAM permissions do not allow it to manage the customer Cognito pool. Check the credentials and the cognito-idp permissions on the pool.",
      );
    case "ResourceNotFoundException":
      console.error(`[customers] ${what}: pool not found: ${errorMessage(error)}`);
      return new ServiceUnavailableError(
        COGNITO_UNAVAILABLE,
        "The customer Cognito pool named by CUSTOMER_COGNITO_USER_POOL_ID does not exist in that region.",
      );
    default:
      console.error(`[customers] ${what} failed: ${name || "Error"}: ${errorMessage(error)}`);
      return new ServiceUnavailableError(
        COGNITO_UNAVAILABLE,
        "The customer Cognito pool could not be reached. Try again shortly.",
      );
  }
}

/* -------------------------------------------------------------------------- */
/*                                Availability                                */
/* -------------------------------------------------------------------------- */

export interface CognitoAvailability {
  canSend: boolean;
  /** One line saying why not, or null when it can. */
  reason: string | null;
}

/**
 * Whether invitations can be sent from this deployment.
 *
 * A missing pool id is decisive: nothing can be done without it. Credentials
 * are not checked, because the only way to prove them is to make a signed
 * call — an operator pressing the button gets the 503 with the real reason,
 * which is better than a page that refuses to show the form because a
 * probe call happened to fail.
 */
export function availability(): CognitoAvailability {
  const { reason } = tryCustomerCognitoConfig();
  if (reason !== null) {
    return { canSend: false, reason };
  }
  return { canSend: true, reason: null };
}

/* -------------------------------------------------------------------------- */
/*                                  Directory                                 */
/* -------------------------------------------------------------------------- */

/** What one listing of the pool tells us. */
export interface PoolDirectory {
  /** Accounts by their `sub` attribute, which is what `users.cognito_sub` holds. */
  bySub: Map<string, CustomerCognitoAccount>;
  /** Accounts still on their temporary password. */
  invited: number;
  /** Accounts an operator (or Cognito) has disabled. */
  disabled: number;
  total: number;
  /** True when the listing was cut short by the page cap; counts are then partial. */
  truncated: boolean;
}

/** Cognito's own maximum for `ListUsers` is 60. */
const LIST_PAGE_LIMIT = 60;

/** 60 × 200 = 12 000 accounts. Past that the whole-pool listing has to go. */
const LIST_PAGE_CAP = 200;

const DIRECTORY_TTL_MS = 60_000;

let cachedDirectory: { poolId: string; loadedAt: number; directory: PoolDirectory } | null = null;
/** Coalesces concurrent loads inside one request (list + counts + invites). */
let inflight: { poolId: string; promise: Promise<PoolDirectory> } | null = null;
/**
 * Bumped by `invalidatePoolDirectory()`. A listing started before a bump
 * still finishes and is returned to whoever is waiting on it, but it must not
 * overwrite the cache with a snapshot that predates the write which triggered
 * the invalidation (a create, resend or delete racing a concurrent listing).
 */
let directoryGeneration = 0;

function attribute(attributes: AttributeType[] | undefined, name: string): string | undefined {
  return attributes?.find((entry) => entry.Name === name)?.Value ?? undefined;
}

/** Cognito's `UserStatus` as the UI models it. Unknown values stay `unknown`. */
export function normaliseUserStatus(status: string | undefined): CustomerCognitoAccount["status"] {
  switch (status) {
    case "CONFIRMED":
      return "confirmed";
    case "FORCE_CHANGE_PASSWORD":
      return "force_change_password";
    case "UNCONFIRMED":
      return "unconfirmed";
    case "RESET_REQUIRED":
      return "reset_required";
    default:
      return "unknown";
  }
}

function toAccount(user: UserType): CustomerCognitoAccount {
  return {
    status: normaliseUserStatus(user.UserStatus),
    enabled: user.Enabled ?? true,
    createdAt: user.UserCreateDate?.toISOString() ?? null,
    updatedAt: user.UserLastModifiedDate?.toISOString() ?? null,
  };
}

async function fetchDirectory(config: CustomerCognitoConfig): Promise<PoolDirectory> {
  const client = getClient(config);
  const bySub = new Map<string, CustomerCognitoAccount>();
  let invited = 0;
  let disabled = 0;
  let total = 0;
  let truncated = true;
  let paginationToken: string | undefined;

  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const response = await client.send(
      new ListUsersCommand({
        UserPoolId: config.userPoolId,
        Limit: LIST_PAGE_LIMIT,
        PaginationToken: paginationToken,
      }),
    );
    for (const user of response.Users ?? []) {
      const account = toAccount(user);
      total += 1;
      if (!account.enabled) disabled += 1;
      else if (account.status === "force_change_password") invited += 1;
      const sub = attribute(user.Attributes, "sub");
      if (sub !== undefined) bySub.set(sub, account);
    }
    paginationToken = response.PaginationToken;
    if (paginationToken === undefined) {
      truncated = false;
      break;
    }
  }

  if (truncated) {
    console.warn(
      `[customers] the customer pool has more than ${LIST_PAGE_LIMIT * LIST_PAGE_CAP} accounts; the listing was cut short and the pool counts are partial.`,
    );
  }
  return { bySub, invited, disabled, total, truncated };
}

/**
 * The pool, indexed. `null` when it is not configured or the listing failed:
 * the caller falls back to the database alone rather than failing the page,
 * which is why this one swallows its error (after logging it) instead of
 * translating it into a response.
 */
export async function getPoolDirectory(): Promise<PoolDirectory | null> {
  const { config } = tryCustomerCognitoConfig();
  if (config === null) return null;

  const now = Date.now();
  if (cachedDirectory?.poolId === config.userPoolId && now - cachedDirectory.loadedAt < DIRECTORY_TTL_MS) {
    return cachedDirectory.directory;
  }
  if (inflight?.poolId === config.userPoolId) {
    try {
      return await inflight.promise;
    } catch {
      return null;
    }
  }

  // Captured before the listing starts: if a write invalidates the directory
  // while this call is still in flight, the generation moves and the result
  // below is stale by the time it lands, even though the call itself started
  // first.
  const generation = directoryGeneration;
  const promise = fetchDirectory(config);
  inflight = { poolId: config.userPoolId, promise };
  try {
    const directory = await promise;
    if (generation === directoryGeneration) {
      cachedDirectory = { poolId: config.userPoolId, loadedAt: Date.now(), directory };
    }
    return directory;
  } catch (error) {
    // Logged, not thrown: `cognito: null` on every row and `cognitoAvailable:
    // false` is a usable page; a 500 is not.
    translateCognitoError(error, "listing the customer pool");
    return null;
  } finally {
    if (inflight?.promise === promise) inflight = null;
  }
}

/** Drops the cached listing, so the next read sees a create or a delete. */
export function invalidatePoolDirectory(): void {
  cachedDirectory = null;
  directoryGeneration += 1;
}

/**
 * The pool's view of the given `sub`s. Missing keys mean "no such account in
 * this pool"; an empty map with `available: false` means the pool was never
 * consulted, which the caller must render as `unknown` rather than
 * `no_account`.
 */
export async function describeAccounts(
  subs: readonly string[],
): Promise<{ available: boolean; accounts: Map<string, CustomerCognitoAccount> }> {
  const directory = await getPoolDirectory();
  if (directory === null) return { available: false, accounts: new Map() };
  const accounts = new Map<string, CustomerCognitoAccount>();
  for (const sub of subs) {
    const account = directory.bySub.get(sub);
    if (account !== undefined) accounts.set(sub, account);
  }
  return { available: true, accounts };
}

/* -------------------------------------------------------------------------- */
/*                                   Writes                                   */
/* -------------------------------------------------------------------------- */

export interface CreatedPoolUser {
  /** The Cognito username the account was created with (the email address). */
  username: string;
  /** The immutable `sub`, which is what a `users` row will carry. */
  sub: string | null;
}

/**
 * A one-time temporary password for AdminCreateUser that satisfies the pool's
 * policy (at least 8 characters with upper case, lower case, a digit and a
 * symbol): 16 characters, one guaranteed from each class, the rest drawn from
 * all four, shuffled with the same CSPRNG. The person replaces it at first
 * sign-in (NEW_PASSWORD_REQUIRED), so it only has to be strong and unique.
 */
function temporaryPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^&*-_=+?";
  const all = upper + lower + digits + symbols;
  const pick = (set: string): string => set[randomInt(set.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (chars.length < 16) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/**
 * Creates the account and lets Cognito email the temporary password.
 *
 * The email is marked verified because the invitation itself proves the
 * address: the person can only continue if the message arrived. We never see
 * the temporary password, and it is never stored or logged.
 *
 * The pool requires `name` and `locale`; whichever of `attributes.name` /
 * `attributes.locale` is provided is sent along, and whatever is left out is
 * asked for by the pool at first sign-in.
 *
 * @throws {ApiError} translated from Cognito (409 for an existing account).
 */
export async function createInvitedUser(
  email: string,
  attributes: { name?: string | null; locale?: string | null } = {},
): Promise<CreatedPoolUser> {
  const config = getCustomerCognitoConfig();
  const userAttributes: AttributeType[] = [
    { Name: "email", Value: email },
    { Name: "email_verified", Value: "true" },
  ];
  if (attributes.name != null) userAttributes.push({ Name: "name", Value: attributes.name });
  if (attributes.locale != null) userAttributes.push({ Name: "locale", Value: attributes.locale });
  try {
    const response = await getClient(config).send(
      new AdminCreateUserCommand({
        UserPoolId: config.userPoolId,
        Username: email,
        UserAttributes: userAttributes,
        // Generated here rather than left to Cognito: since the pool allows a
        // passkey as a first sign-in factor (2026-09-12), AdminCreateUser
        // without a TemporaryPassword means "make a passwordless account",
        // which a pool without email/SMS one-time codes refuses with
        // "User is required to have a password." Cognito still puts this
        // value in the invitation email ({####}); it is never logged or
        // stored here.
        TemporaryPassword: temporaryPassword(),
        DesiredDeliveryMediums: ["EMAIL"],
      }),
    );
    invalidatePoolDirectory();
    return {
      username: response.User?.Username ?? email,
      sub: attribute(response.User?.Attributes, "sub") ?? null,
    };
  } catch (error) {
    throw translateCognitoError(error, "creating a customer account");
  }
}

/**
 * Sends the invitation again. `MessageAction: "RESEND"` re-issues the
 * temporary password for an account that has not been used yet; Cognito
 * refuses it once the person has set their own password
 * (`UnsupportedUserStateException` or `PreconditionNotMetException`), and
 * that refusal arrives here as a 409 (`INVITE_ALREADY_USED_MESSAGE`).
 */
export async function resendInvitation(username: string): Promise<void> {
  const config = getCustomerCognitoConfig();
  try {
    await getClient(config).send(
      new AdminCreateUserCommand({
        UserPoolId: config.userPoolId,
        Username: username,
        MessageAction: "RESEND",
        DesiredDeliveryMediums: ["EMAIL"],
      }),
    );
    invalidatePoolDirectory();
  } catch (error) {
    throw translateCognitoError(error, "resending a customer invitation");
  }
}

/**
 * Deletes an account that has never been used.
 *
 * The `AdminGetUser` first is the whole point: revoking an invitation must
 * never be able to delete a person who has already signed in and has data in
 * the consumer app. Anything other than `FORCE_CHANGE_PASSWORD` is a 409 that
 * says so.
 *
 * @throws {NotFoundError} the account is not in the pool.
 * @throws {ConflictError} the account is confirmed, or in some other state.
 */
export async function deleteUnconfirmedUser(username: string): Promise<void> {
  const config = getCustomerCognitoConfig();
  const client = getClient(config);
  let status: string | undefined;
  try {
    const found = await client.send(
      new AdminGetUserCommand({ UserPoolId: config.userPoolId, Username: username }),
    );
    status = found.UserStatus;
  } catch (error) {
    throw translateCognitoError(error, "reading a customer account");
  }
  if (status !== "FORCE_CHANGE_PASSWORD") {
    throw new ConflictError(
      "That account has already been used to sign in, so the invitation can no longer be withdrawn. Deleting a confirmed account is not something this page does.",
    );
  }
  try {
    await client.send(
      new AdminDeleteUserCommand({ UserPoolId: config.userPoolId, Username: username }),
    );
    invalidatePoolDirectory();
  } catch (error) {
    throw translateCognitoError(error, "deleting a customer account");
  }
}

/* -------------------------------------------------------------------------- */
/*                          The nightly directory read                        */
/* -------------------------------------------------------------------------- */

/** One pool account as the nightly snapshot records it. */
export interface PoolAccountSnapshot {
  /** The `sub` attribute. An account without one is skipped: it is unusable. */
  sub: string;
  /**
   * Cognito's `UserStatus`, **lower-cased and otherwise untouched** — not
   * narrowed to the five states the list column models.
   *
   * The snapshot is a history table: a status this console has nothing to say
   * about (`EXTERNAL_PROVIDER`, `ARCHIVED`, or whatever AWS adds next) has to
   * be *recorded* rather than flattened to `unknown`, or the history would
   * lose the difference between "we do not know" and "Cognito said something
   * new". The census groups by whatever it finds and the page labels the
   * statuses it knows, so a new value appears with no code change; the diff
   * only ever compares the two spellings it names
   * (`force_change_password` -> `confirmed`), which are unaffected.
   */
  status: string;
  enabled: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
  /** The `email` attribute, when the pool exposes it. */
  email: string | null;
}

/** What one full listing of the pool produced. */
export interface PoolListing {
  accounts: PoolAccountSnapshot[];
  /** Accounts the listing saw that carried no `sub` attribute. */
  withoutSub: number;
  /** How many `ListUsers` pages were spent. */
  pages: number;
  /**
   * True when the page cap stopped the listing early. The snapshot is then
   * **partial**, and the caller must not diff it — every account it did not
   * reach would look deleted.
   */
  truncated: boolean;
}

/**
 * Pages the whole customer pool for the nightly snapshot.
 *
 * Deliberately **not** `getPoolDirectory()`: that one is a 60-second cache
 * shaped for a page load — it keeps only what the status column needs, throws
 * away the email, and swallows its own errors so a list can still render.
 * The snapshot needs the opposite of all three: the raw rows, a fresh read,
 * and a failure it can report, because a snapshot written from a half-read
 * pool would make the next diff invent deletions.
 *
 * @throws {ApiError} translated from Cognito, so the run's error says what
 * AWS refused and why.
 */
export async function listPoolAccounts(): Promise<PoolListing> {
  const config = getCustomerCognitoConfig();
  const client = getClient(config);
  const accounts: PoolAccountSnapshot[] = [];
  let withoutSub = 0;
  let pages = 0;
  let truncated = true;
  let paginationToken: string | undefined;

  try {
    for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
      const response = await client.send(
        new ListUsersCommand({
          UserPoolId: config.userPoolId,
          Limit: LIST_PAGE_LIMIT,
          PaginationToken: paginationToken,
        }),
      );
      pages += 1;
      for (const user of response.Users ?? []) {
        const sub = attribute(user.Attributes, "sub");
        if (sub === undefined) {
          withoutSub += 1;
          continue;
        }
        accounts.push({
          sub,
          // The raw status, lower-cased: see `PoolAccountSnapshot.status`.
          status: user.UserStatus?.toLowerCase() ?? "unknown",
          enabled: user.Enabled ?? true,
          createdAt: user.UserCreateDate ?? null,
          updatedAt: user.UserLastModifiedDate ?? null,
          email: attribute(user.Attributes, "email") ?? null,
        });
      }
      paginationToken = response.PaginationToken;
      if (paginationToken === undefined) {
        truncated = false;
        break;
      }
    }
  } catch (error) {
    throw translateCognitoError(error, "listing the customer pool for the nightly snapshot");
  }

  return { accounts, withoutSub, pages, truncated };
}
