import "server-only";
/**
 * The Overview's Deployments card: what ECS is actually running, from one
 * `ecs:DescribeServices` call, cached for a minute.
 *
 * Per configured service: how many tasks are running against how many are
 * wanted, the task definition revision, the primary deployment's rollout
 * state and reason, and the newest service event — which is where a rollout
 * that is failing explains itself ("unable to place a task", "health checks
 * failed"), and is the one line worth having on a dashboard.
 *
 * **No image tag.** The tag is inside the task definition's container
 * definitions, which needs `ecs:DescribeTaskDefinition`; the task role is
 * granted `ecs:DescribeServices` and nothing else, so the revision is as far
 * as this card can honestly go. `IMAGE_TAG_NOTE` in `./types.ts` is the
 * sentence the card prints about it, and it should stay there until either
 * the permission is added or `BUILD_ID` is surfaced another way.
 *
 * Conventions shared with `./metrics.ts`: the region comes from `./config.ts`
 * (an ECS service is a regional resource, so the wrong region means "no such
 * service" rather than an error), credentials come from the SDK's default
 * provider chain, one client per process, and **nothing throws** — a failed
 * call comes back as `{ error }` and every row says so.
 */
import { DescribeServicesCommand, ECSClient } from "@aws-sdk/client-ecs";
import { memoiseFor, OPS_CACHE_TTL_MS, OPS_CLIENT_TIMEOUTS } from "./cache";
import { getOpsConfig, notConfigured, OPS_ENV_NAMES } from "./config";
import type { DeployHealth, DeployService } from "./types";

let client: ECSClient | null = null;
let clientRegion: string | null = null;

/**
 * One client per region per process, built with {@link OPS_CLIENT_TIMEOUTS}:
 * the call is made while a server render waits on it, so a hung socket has to
 * fail fast instead of holding the Overview open.
 */
function ecs(region: string): ECSClient {
  if (client === null || clientRegion !== region) {
    client = new ECSClient({ region, ...OPS_CLIENT_TIMEOUTS });
    clientRegion = region;
  }
  return client;
}

/** An error's own sentence, or a generic one. Never a stack, never a credential. */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message.trim();
  return "The ECS call failed without a message.";
}

/** `arn:…:task-definition/fairsums-web-stage:41` → `fairsums-web-stage:41`. */
function taskDefinitionLabel(arn: string | undefined): string | null {
  if (arn === undefined || arn.trim() === "") return null;
  const tail = arn.split("/").pop();
  return tail === undefined || tail === "" ? arn : tail;
}

/** A row for a service that could not be asked about, or that ECS did not return. */
function blankService(name: string, error: string): DeployService {
  return {
    name,
    status: null,
    desired: null,
    running: null,
    pending: null,
    taskDefinition: null,
    rolloutState: null,
    rolloutStateReason: null,
    updatedAt: null,
    lastEvent: null,
    error,
  };
}

/** The uncached read. `getDeployHealth` is the one callers should use. */
async function fetchDeployHealth(now: Date = new Date()): Promise<DeployHealth> {
  const config = getOpsConfig();
  const fetchedAt = now.toISOString();

  if (config.region === null) {
    return {
      cluster: config.ecsCluster,
      services: [],
      fetchedAt,
      error: notConfigured(`${OPS_ENV_NAMES.region} or AWS_REGION`),
    };
  }
  if (config.ecsCluster === null || config.ecsServices.length === 0) {
    return {
      cluster: config.ecsCluster,
      services: [],
      fetchedAt,
      error: notConfigured(OPS_ENV_NAMES.ecsCluster, OPS_ENV_NAMES.ecsServices),
    };
  }

  let described;
  try {
    described = await ecs(config.region).send(
      new DescribeServicesCommand({
        cluster: config.ecsCluster,
        // At most ten, which `./config.ts` caps at exactly the API's limit.
        services: config.ecsServices,
      }),
    );
  } catch (error) {
    const message = errorText(error);
    console.error("[ops] DescribeServices failed:", message);
    return { cluster: config.ecsCluster, services: [], fetchedAt, error: message };
  }

  // ECS answers unknown or misspelt names in `failures` rather than throwing,
  // so a typo in the variable shows up as one broken row instead of an empty
  // card.
  const failureFor = new Map<string, string>();
  for (const failure of described.failures ?? []) {
    const name = failure.arn?.split("/").pop();
    if (name === undefined) continue;
    failureFor.set(name, failure.reason ?? "ECS did not return this service.");
  }

  const answered = new Map(
    (described.services ?? [])
      .filter((service) => service.serviceName !== undefined)
      .map((service) => [service.serviceName as string, service]),
  );

  const services = config.ecsServices.map((name): DeployService => {
    const service = answered.get(name);
    if (service === undefined) {
      return blankService(
        name,
        failureFor.get(name) ??
          "ECS did not return this service. Check the name and the cluster it lives in.",
      );
    }

    // The primary deployment is the one whose tasks are being run; the rest
    // are draining. ECS Express services report their rollout the same way an
    // ordinary service does.
    const primary =
      (service.deployments ?? []).find((deployment) => deployment.status === "PRIMARY") ??
      (service.deployments ?? [])[0];
    const event = (service.events ?? [])[0];

    return {
      name,
      status: service.status ?? null,
      desired: service.desiredCount ?? null,
      running: service.runningCount ?? null,
      pending: service.pendingCount ?? null,
      taskDefinition: taskDefinitionLabel(primary?.taskDefinition ?? service.taskDefinition),
      rolloutState: primary?.rolloutState ?? null,
      rolloutStateReason: primary?.rolloutStateReason ?? null,
      updatedAt: (primary?.updatedAt ?? service.createdAt)?.toISOString() ?? null,
      lastEvent:
        event?.message === undefined
          ? null
          : { at: event.createdAt?.toISOString() ?? null, message: event.message },
      error: null,
    };
  });

  return { cluster: config.ecsCluster, services, fetchedAt, error: null };
}

/**
 * The Deployments card's data: one `DescribeServices` call per minute at most.
 *
 * Resolves whatever happens — see the module note.
 */
export const getDeployHealth = memoiseFor(OPS_CACHE_TTL_MS, () => fetchDeployHealth());
