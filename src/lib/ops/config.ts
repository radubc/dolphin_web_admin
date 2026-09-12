import "server-only";
/**
 * Which AWS resources the Overview's Operations and Deployments cards ask
 * about, read from the environment.
 *
 * Every name here is **optional**, and that is the whole point of this file.
 * The metrics a card draws are identified by CloudWatch *dimensions* — a
 * database instance identifier, a cluster and service name, a load balancer's
 * ARN suffix, a web ACL name — and none of those can be derived from anything
 * the app already knows. A deployment that has not been told them still has to
 * render: the card shows "not configured" for the rows it cannot ask about and
 * the rest of the page is unaffected. Nothing here ever throws.
 *
 * The defaults the CloudFormation stacks produce, for whoever fills the
 * variables in (`Environment` is `stage` or `production`):
 *
 * | Variable | Value in this deployment |
 * | --- | --- |
 * | `OPS_RDS_INSTANCE_ID` | `fairsums-<env>` (`infra/environment.yaml`, `DBInstanceIdentifier`) |
 * | `OPS_ECS_CLUSTER` | `fairsums` (the foundation stack's `ClusterName`) |
 * | `OPS_ECS_SERVICES` | `fairsums-web-<env>,fairsums-admin-<env>` |
 * | `OPS_ALB_ARN_SUFFIX` | `app/<name>/<id>` — the tail of the load balancer's ARN. ECS Express creates the balancer, so its name is not predictable; take it from the `LoadBalancerArn` output of either service stack |
 * | `OPS_WAF_WEBACL_NAME` | `fairsums-admin-<env>` (the only web ACL; it fronts the shared balancer) |
 *
 * Region: CloudWatch metrics live in the region that produced them, so this
 * reads `OPS_AWS_REGION` and falls back to the task's own `AWS_REGION`. It is
 * deliberately *not* `us-east-1` — that pin belongs to Cost Explorer and
 * Budgets alone (`src/lib/costs/aws.ts`). Without a region nothing can be
 * asked, and every row says so rather than quietly reading an empty series
 * from the wrong region.
 *
 * Credentials are never read here: both clients resolve them through the SDK's
 * default provider chain (the ECS task role on Fargate, a profile locally),
 * exactly as the Cognito and Cost Explorer clients do.
 */

/** The environment variable names this module reads, for the docs and the UI. */
export const OPS_ENV_NAMES = {
  region: "OPS_AWS_REGION",
  rdsInstanceId: "OPS_RDS_INSTANCE_ID",
  ecsCluster: "OPS_ECS_CLUSTER",
  ecsServices: "OPS_ECS_SERVICES",
  albArnSuffix: "OPS_ALB_ARN_SUFFIX",
  wafWebAclName: "OPS_WAF_WEBACL_NAME",
} as const;

/** How many ECS services one page load will ask about. `DescribeServices` takes 10. */
export const OPS_MAX_SERVICES = 10;

export interface OpsConfig {
  /** The region the metrics are published in, or null when neither name is set. */
  region: string | null;
  rdsInstanceId: string | null;
  ecsCluster: string | null;
  /** Service names, in the order given; empty when the variable is unset. */
  ecsServices: string[];
  /** `app/<name>/<id>`, the `LoadBalancer` dimension's value. */
  albArnSuffix: string | null;
  wafWebAclName: string | null;
}

/** `""` and whitespace are "unset", not a value. */
function value(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The load balancer dimension AWS/ApplicationELB uses is the ARN's tail:
 * `app/<name>/<id>`. Operators paste whole ARNs, so accept one and cut it.
 * Anything that still does not look like the tail is treated as unset — a
 * wrong dimension returns an empty series, which reads as "no traffic" and is
 * the worst possible answer.
 */
function albSuffix(raw: string | null): string | null {
  if (raw === null) return null;
  const index = raw.indexOf("app/");
  const suffix = index === -1 ? raw : raw.slice(index);
  return /^app\/[^/]+\/[0-9a-f]+$/i.test(suffix) ? suffix : null;
}

/**
 * The configuration as it stands right now.
 *
 * Read per call rather than at module load: `next build` evaluates modules
 * without the runtime environment, and a value captured then would be wrong
 * for the life of the container.
 */
export function getOpsConfig(): OpsConfig {
  const services = (value(OPS_ENV_NAMES.ecsServices) ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");

  return {
    region: value(OPS_ENV_NAMES.region) ?? value("AWS_REGION"),
    rdsInstanceId: value(OPS_ENV_NAMES.rdsInstanceId),
    ecsCluster: value(OPS_ENV_NAMES.ecsCluster),
    ecsServices: [...new Set(services)].slice(0, OPS_MAX_SERVICES),
    albArnSuffix: albSuffix(value(OPS_ENV_NAMES.albArnSuffix)),
    wafWebAclName: value(OPS_ENV_NAMES.wafWebAclName),
  };
}

/** The sentence a row carries when the variable it needs is not set. */
export function notConfigured(...names: readonly string[]): string {
  return `Not configured: set ${names.join(" and ")}.`;
}
