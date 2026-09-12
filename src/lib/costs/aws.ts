import "server-only";
/**
 * The three AWS clients the cost job uses, and the rules about credentials,
 * region and failure that all three share.
 *
 * **Region is pinned to `us-east-1`, deliberately and unconditionally.** Cost
 * Explorer, Budgets and Free Tier are global services with a single endpoint
 * each, and that endpoint lives in `us-east-1` whatever the task's own
 * `AWS_REGION` is (this deployment runs in `us-west-2`). Passing the task's
 * region would simply make every call fail to resolve.
 *
 * **Credentials come from the SDK's default provider chain** — the ECS task
 * role on Fargate, a shared profile or the `AWS_*` variables locally —
 * exactly as `src/lib/customers/cognito.ts` does it for Cognito. Nothing here
 * reads, holds or logs a credential.
 *
 * **One client per process.** A client is a connection pool and a credential
 * cache; building one per run would re-resolve credentials every time for no
 * benefit. The job is the only caller, once a day, so there is no contention.
 *
 * Failures are sorted into three kinds, because the job treats them
 * differently:
 *
 * - *fatal* — the deployment cannot call AWS at all (no credentials, an
 *   expired token, a denied `ce:*` action). The run fails: every further
 *   call would waste a request to learn the same thing, and an operator has
 *   to fix IAM.
 * - *unavailable* — the account has not enabled Cost Explorer yet
 *   (`DataUnavailableException` on the very first call). Also fatal, but with
 *   its own sentence, because the fix is one click in the console rather than
 *   an IAM change.
 * - *skippable* — this particular question does not apply: no budget, no
 *   free-tier plan, not enough history to forecast. The run records it and
 *   carries on.
 */
import { BudgetsClient } from "@aws-sdk/client-budgets";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { FreeTierClient } from "@aws-sdk/client-freetier";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

/**
 * The one region every client here is built with. Cost Explorer, Budgets and
 * Free Tier have a single global endpoint and it is in `us-east-1`.
 */
export const COST_API_REGION = "us-east-1";

/* -------------------------------------------------------------------------- */
/*                                   Clients                                  */
/* -------------------------------------------------------------------------- */

let costExplorer: CostExplorerClient | null = null;
let budgets: BudgetsClient | null = null;
let freeTier: FreeTierClient | null = null;
let sts: STSClient | null = null;

export function costExplorerClient(): CostExplorerClient {
  costExplorer ??= new CostExplorerClient({ region: COST_API_REGION });
  return costExplorer;
}

export function budgetsClient(): BudgetsClient {
  budgets ??= new BudgetsClient({ region: COST_API_REGION });
  return budgets;
}

export function freeTierClient(): FreeTierClient {
  freeTier ??= new FreeTierClient({ region: COST_API_REGION });
  return freeTier;
}

/* -------------------------------------------------------------------------- */
/*                                 Account id                                 */
/* -------------------------------------------------------------------------- */

/**
 * The account id, which `budgets:DescribeBudgets` requires as a parameter.
 *
 * `sts:GetCallerIdentity` answers it and is the one AWS call every principal
 * may always make — it needs no IAM permission and cannot be denied by a
 * policy — so this adds no permission to the task role and no environment
 * variable to the deployment. It is also the only reliable source: the ECS
 * task role's ARN is not in the environment, and whether the credential
 * provider happens to carry an `accountId` depends on which link of the
 * default chain resolved it.
 *
 * Memoised for the life of the process. An account id does not change, and a
 * failed lookup is not cached, so a transient network failure is retried on
 * the next run.
 */
let cachedAccountId: string | null = null;

export async function awsAccountId(): Promise<string> {
  if (cachedAccountId !== null) return cachedAccountId;
  sts ??= new STSClient({ region: COST_API_REGION });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  const account = identity.Account?.trim();
  if (!account) {
    throw new Error("sts:GetCallerIdentity did not return an account id.");
  }
  cachedAccountId = account;
  return account;
}

/* -------------------------------------------------------------------------- */
/*                              Error classification                          */
/* -------------------------------------------------------------------------- */

/** The `name` of an AWS SDK error, or `""` for anything that is not one. */
function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return "";
}

/** The message an error carries, trimmed, or a generic sentence. */
export function awsMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message.trim();
  return "The AWS call failed without a message.";
}

/**
 * Names that mean "this deployment cannot call AWS": no usable credential, an
 * expired or unknown one, or a policy that denies the action. Every one of
 * them is a configuration fault an operator has to fix, and none of them gets
 * better by trying the next call.
 */
const FATAL_NAMES = new Set([
  "AccessDenied",
  "AccessDeniedException",
  "CredentialsProviderError",
  "ExpiredToken",
  "ExpiredTokenException",
  "InvalidClientTokenId",
  "InvalidSignatureException",
  "SignatureDoesNotMatch",
  "UnauthorizedException",
  "UnrecognizedClientException",
]);

/** True when the error means the credentials or the IAM policy are wrong. */
export function isCredentialsFailure(error: unknown): boolean {
  return FATAL_NAMES.has(errorName(error));
}

/**
 * True when Cost Explorer has never been enabled on this account.
 *
 * The API answers `DataUnavailableException` until somebody opens Cost
 * Explorer in the Billing console once, and then for up to 24 hours more
 * while it backfills. It is worth its own sentence because it looks exactly
 * like a permissions problem and is not one.
 */
export function isCostExplorerNotEnabled(error: unknown): boolean {
  return errorName(error) === "DataUnavailableException";
}

/** The sentence a run fails with when Cost Explorer is not enabled yet. */
export const COST_EXPLORER_NOT_ENABLED =
  "Cost Explorer has never been used on this AWS account, so it has no data to " +
  "return. Open Cost Explorer once in the AWS Billing console (Billing and Cost " +
  "Management -> Cost Explorer); it then takes up to 24 hours to backfill, after " +
  "which this run will work. No IAM change is needed.";

/**
 * True when the answer is "this question does not apply here" rather than a
 * failure: no such budget or monitor, no free-tier plan, or a range Cost
 * Explorer will not forecast.
 */
export function isNotApplicable(error: unknown): boolean {
  const name = errorName(error);
  return (
    name === "ResourceNotFoundException" ||
    name === "NotFoundException" ||
    name === "UnknownMonitorException" ||
    name === "DataUnavailableException"
  );
}

/**
 * True when the request itself was refused as invalid.
 *
 * `ValidationException` means the *window or the parameters this job built*
 * were wrong — AWS answered nothing, the request was still spent, and no
 * amount of waiting fixes it. `InvalidNextTokenException` is the same class
 * of thing for a page token. So neither is "not applicable" and neither is a
 * skip: the job counts them as **failed** calls and puts the message in the
 * run's error text, without throwing, so the calls that did answer are still
 * written. The forecast's window being a validation error is exactly the bug
 * this classification was needed to surface.
 */
export function isInvalidRequest(error: unknown): boolean {
  const name = errorName(error);
  return name === "ValidationException" || name === "InvalidNextTokenException";
}
