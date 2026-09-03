import Jenkins from "jenkins";
import type {
  ConnectionConfig,
  DeploymentEnvironment,
  EitriBuild,
  EitriBuildStage,
  EitriBuildsResult,
  EitriNamespace,
  EitriStageStatus,
  JenkinsBuildStatus,
  JenkinsDeployedTag,
  JenkinsQueueStatus,
  RepositoryDeploymentStatusResult,
  TriggerEitriDeploymentInput,
  TriggeredEitriDeployment,
  TriggerProductionDeploymentInput,
  TriggeredProductionDeployment,
  TriggerDeploymentInput,
  TriggeredDeployment,
} from "../../src/shared/types.js";
import { ProviderError } from "../errors.js";

export const EITRI_JOB_NAME = "DEV/Stag EITRI";
export const EITRI_DEFAULT_STAGING_ENV_UPDATE_JOB = "DEV/DEV Deployer";
export const QA_DEPLOYMENT_JOB_NAME = "QA/QA-DEPLOYMENT";
export const STAGING_DEPLOYMENT_JOB_NAME = "DEV/DEV Deployer";
export const PRODUCTION_DEPLOYMENT_JOB_NAME =
  "Prod Deployments/Prod-cluster-deployment";

const serviceToRepository = {
  accounts: "accounts",
  "asbru-web": "asbru",
  "bifrost-web": "bifrost",
  cdp: "cdp-api",
  "cds-api": "cds",
  "cds-web": "cds-web",
  "cerebro-api": "cerebro",
  "cerebro-go": "cerebro-go",
  citadel: "citadel",
  "clr-api": "clr",
  "clr-web": "clr",
  "cms-api": "cms-api",
  "cms-web": "cms-web",
  compass: "compass-clinics",
  consent: "consent-service",
  chronos: "chronos",
  citrus: "citrus",
  "cpms-web": "cpms",
  dokumentor: "dokumentor",
  runestone: "runestone",
  "super-crm": "super-crm",
  "vault-web": "vault-ui",
  web: "orange-health-app",
  "superlab-web": "amethyst",
  ets: "ets-lab",
  "feedback-api": "feedback-api",
  "feedback-web": "feedback",
  "geomark-api": "geomark",
  gringotts: "gringotts",
  "gringotts-web": "gringotts-web",
  groot: "groot",
  health: "health-api",
  "hedwig-api": "hedwig",
  "gateway-api": "gateway-api",
  "occ-api": "occ",
  "occ-web": "occ-web",
  odin: "odin-api",
  oms: "oms",
  "oms-web": "oms-web",
  partner: "partner-api",
  "partner-web": "partner-web",
  patients: "patients-service",
  payment: "payment-api",
  webhook: "webhook-service",
  "sorting-hat": "sorting-hat",
  "orange-fusion": "orange-fusion",
  "porte-api": "porte",
  "report-rebranding-api": "report-rebranding",
  "nimbus-api": "nimbus",
  "s3wrapper-api": "s3wrapper",
  sapphire: "sapphire-api",
  "sapphire-web": "sapphire-web",
  "scheduler-api": "scheduler-api",
  "scheduler-web": "scheduler",
  titan: "titan-api",
  "vault-api": "vault",
} as const;

const stagingTeams: Record<Exclude<DeploymentEnvironment, "qa">, string> = {
  s1: "Doctors",
  s2: "D2C CRM",
  s3: "Logistics",
  s4: "Lab",
  s5: "Partnerships",
};

/** QA uses dashboard service keys; DEV Deployer uses these SERVICE_NAME values. */
const stagingDeployServiceNames: Record<string, string> = {
  "asbru-web": "asbru",
  "bifrost-web": "bifrost",
  cdp: "cdp-api",
  "cds-api": "cds",
  "cerebro-api": "cerebro",
  consent: "consent-service",
  "cpms-web": "cpms",
  ets: "ets-lab",
  "feedback-web": "feedback",
  "geomark-api": "geomark",
  health: "health-api",
  "hedwig-api": "hedwig",
  "occ-api": "occ",
  odin: "odin-api",
  partner: "partner-api",
  patients: "patients-service",
  payment: "payment-api",
  "porte-api": "porte",
  "report-rebranding-api": "report-rebranding",
  "s3wrapper-api": "s3wrapper",
  sapphire: "sapphire-api",
  "scheduler-web": "scheduler",
  "superlab-web": "amethyst",
  webhook: "webhook-service",
};

export function stagingDeployServiceName(service: string) {
  return stagingDeployServiceNames[service] ?? service;
}

/** Prod-cluster-deployment SERVICE values when they differ from dashboard keys. */
const productionDeployServiceNames: Record<string, string> = {
  "scheduler-web": "scheduler-web",
};

export function productionDeployServiceName(service: string) {
  return productionDeployServiceNames[service] ?? service;
}

export function dashboardJenkinsServices() {
  return Object.keys(serviceToRepository);
}

const teamEnvironments = new Map(
  Object.entries(stagingTeams).map(([environment, team]) => [
    team.toLowerCase(),
    environment as DeploymentEnvironment,
  ]),
);
const DEPLOYMENT_CACHE_MS = 30_000;
const deploymentCache = new Map<
  string,
  { expiresAt: number; value: Promise<JenkinsDeployedTag[]> }
>();
const deploymentBuildCache = new Map<
  string,
  {
    expiresAt: number;
    value: Promise<{ qa: JenkinsBuild[]; staging: JenkinsBuild[] }>;
  }
>();
const productionDeploymentBuildCache = new Map<
  string,
  { expiresAt: number; value: Promise<JenkinsBuild[]> }
>();
const eitriBuildCache = new Map<
  string,
  { expiresAt: number; value: Promise<JenkinsBuild[]> }
>();

type JenkinsBuild = {
  number: number;
  url?: string;
  result?: string | null;
  building?: boolean;
  timestamp?: number;
  actions?: Array<{
    parameters?: Array<{ name: string; value: unknown }>;
  }>;
};

type DeploymentSpec = {
  jobName: string;
  parameters: Record<string, string | boolean>;
};

function jenkinsClient(config: ConnectionConfig) {
  const url = new URL(config.jenkinsUrl);
  url.username = config.jenkinsUsername;
  url.password = config.jenkinsToken;
  return new Jenkins({
    baseUrl: url.toString().replace(/\/$/, ""),
    crumbIssuer: true,
  });
}

function jenkinsJobPath(jobName: string) {
  return jobName
    .split("/")
    .filter(Boolean)
    .map((segment) => `job/${encodeURIComponent(segment)}`)
    .join("/");
}

async function jenkinsApiGet<T>(
  config: ConnectionConfig,
  path: string,
): Promise<T> {
  const base = config.jenkinsUrl.replace(/\/+$/, "");
  const auth = Buffer.from(
    `${config.jenkinsUsername}:${config.jenkinsToken}`,
  ).toString("base64");
  const response = await fetch(`${base}/${path.replace(/^\//, "")}`, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Jenkins API ${response.status} for ${path}`);
  }
  return (await response.json()) as T;
}

export function servicesForRepository(repository: string) {
  const name = repository.split("/").at(-1)?.toLowerCase();
  if (!name) return [];
  return Object.entries(serviceToRepository)
    .filter(([, repositoryName]) => repositoryName === name)
    .map(([service]) => service);
}

function buildParameters(build: JenkinsBuild) {
  return Object.fromEntries(
    (build.actions ?? [])
      .flatMap((action) => action.parameters ?? [])
      .map((parameter) => [parameter.name, String(parameter.value)]),
  );
}

function resolveDashboardService(
  jenkinsServiceName: string | undefined,
  services: string[],
): string | undefined {
  if (!jenkinsServiceName) return undefined;
  const lower = jenkinsServiceName.toLowerCase();
  const direct = services.find((service) => service.toLowerCase() === lower);
  if (direct) return direct;
  return services.find(
    (service) =>
      stagingDeployServiceName(service).toLowerCase() === lower ||
      productionDeployServiceName(service).toLowerCase() === lower,
  );
}

export function deploymentJobName(
  environment: JenkinsDeployedTag["environment"],
) {
  if (environment === "qa") return QA_DEPLOYMENT_JOB_NAME;
  if (environment === "production") return PRODUCTION_DEPLOYMENT_JOB_NAME;
  return STAGING_DEPLOYMENT_JOB_NAME;
}

export function deployedTagsFromBuilds(
  qaBuilds: JenkinsBuild[],
  stagingBuilds: JenkinsBuild[],
  services: string[],
): JenkinsDeployedTag[] {
  const deployments = new Map<string, JenkinsDeployedTag>();
  const latestKeys = new Set<string>();
  const liveKeys = new Set<string>();

  function collect(builds: JenkinsBuild[], qa: boolean) {
    for (const build of [...builds].sort((a, b) => b.number - a.number)) {
      const parameters = buildParameters(build);
      const service = resolveDashboardService(
        parameters.SERVICE ?? parameters.SERVICE_NAME,
        services,
      );
      const tag = parameters.IMAGE_TAG;
      const environment = qa
        ? "qa"
        : teamEnvironments.get((parameters.TEAM ?? "").toLowerCase());
      if (!service || !tag || !environment) continue;
      const status = buildStatusFromResult(build.result, build.building);
      const key = `${service}:${environment}`;
      const deployment: JenkinsDeployedTag = {
        service,
        tag,
        environment,
        status,
        buildNumber: build.number,
        buildUrl: build.url ?? "",
        deployedAt: new Date(build.timestamp ?? 0).toISOString(),
        jobName: deploymentJobName(environment),
      };
      if (!latestKeys.has(key)) {
        deployments.set(`${key}:latest`, deployment);
        latestKeys.add(key);
        if (status === "succeeded") liveKeys.add(key);
      }
      if (status === "succeeded" && !liveKeys.has(key)) {
        deployments.set(`${key}:live`, {
          ...deployment,
          status: "succeeded",
        });
        liveKeys.add(key);
      }
    }
  }

  collect(qaBuilds, true);
  collect(stagingBuilds, false);
  return [...deployments.values()];
}

export function productionDeployedTagsFromBuilds(
  builds: JenkinsBuild[],
  services: string[],
): JenkinsDeployedTag[] {
  const deployments = new Map<string, JenkinsDeployedTag>();
  const latestServices = new Set<string>();
  const liveServices = new Set<string>();
  for (const build of [...builds].sort(
    (left, right) => right.number - left.number,
  )) {
    const parameters = buildParameters(build);
    const service = resolveDashboardService(
      parameters.SERVICE ?? parameters.SERVICE_NAME,
      services,
    );
    const tag = parameters.IMAGE_TAG;
    if (!service || !tag) continue;
    const status = buildStatusFromResult(build.result, build.building);
    const deployment: JenkinsDeployedTag = {
      service,
      tag,
      environment: "production",
      status,
      buildNumber: build.number,
      buildUrl: build.url ?? "",
      deployedAt: new Date(build.timestamp ?? 0).toISOString(),
      jobName: PRODUCTION_DEPLOYMENT_JOB_NAME,
    };
    if (!latestServices.has(service)) {
      deployments.set(`${service}:latest`, deployment);
      latestServices.add(service);
      if (status === "succeeded") liveServices.add(service);
    }
    if (status === "succeeded" && !liveServices.has(service)) {
      deployments.set(`${service}:live`, deployment);
      liveServices.add(service);
    }
  }
  return [...deployments.values()];
}

async function recentJobBuilds(
  client: Jenkins,
  jobName: string,
): Promise<JenkinsBuild[]> {
  const getJob = client.job.get as unknown as (
    name: string,
    options: { tree: string },
  ) => Promise<{ builds?: JenkinsBuild[] }>;
  const job = await getJob.call(client.job, jobName, {
    tree: "builds[number,url,result,building,timestamp,actions[parameters[name,value]]]{0,200}",
  });
  return job.builds ?? [];
}

function invalidateJenkinsBuildCaches() {
  deploymentBuildCache.clear();
  productionDeploymentBuildCache.clear();
  eitriBuildCache.clear();
  deploymentCache.clear();
}

async function recentDeploymentBuilds(
  config: ConnectionConfig,
  forceRefresh = false,
) {
  const cacheKey = config.jenkinsUrl.toLowerCase();
  const cached = deploymentBuildCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now())
    return cached.value;
  const value = (async () => {
    const client = jenkinsClient(config);
    const [qa, staging] = await Promise.all([
      recentJobBuilds(client, QA_DEPLOYMENT_JOB_NAME),
      recentJobBuilds(client, STAGING_DEPLOYMENT_JOB_NAME),
    ]);
    return { qa, staging };
  })();
  deploymentBuildCache.set(cacheKey, {
    expiresAt: Date.now() + DEPLOYMENT_CACHE_MS,
    value,
  });
  value.catch(() => deploymentBuildCache.delete(cacheKey));
  return value;
}

async function recentProductionDeploymentBuilds(
  config: ConnectionConfig,
  forceRefresh = false,
) {
  const prodConfig = productionConfig(config);
  const cacheKey = prodConfig.jenkinsUrl.toLowerCase();
  const cached = productionDeploymentBuildCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const value = recentJobBuilds(
    jenkinsClient(prodConfig),
    PRODUCTION_DEPLOYMENT_JOB_NAME,
  );
  productionDeploymentBuildCache.set(cacheKey, {
    expiresAt: Date.now() + DEPLOYMENT_CACHE_MS,
    value,
  });
  value.catch(() => productionDeploymentBuildCache.delete(cacheKey));
  return value;
}

export async function getCurrentDeployments(
  config: ConnectionConfig,
  repository: string,
  forceRefresh = false,
): Promise<JenkinsDeployedTag[]> {
  const services = servicesForRepository(repository);
  if (services.length === 0) return [];
  const cacheKey = repository.toLowerCase();
  const cached = deploymentCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return enrichDeploymentsWithStages(config, await cached.value);
  }

  const value = (async () => {
    try {
      const builds = await recentDeploymentBuilds(config, forceRefresh);
      return deployedTagsFromBuilds(builds.qa, builds.staging, services);
    } catch (error) {
      throw new ProviderError(
        error instanceof Error
          ? `Could not read current Jenkins deployments: ${error.message}`
          : "Could not read current Jenkins deployments.",
        "JENKINS_DEPLOYMENT_LOOKUP_FAILED",
        "jenkins",
        502,
        true,
      );
    }
  })();
  deploymentCache.set(cacheKey, {
    expiresAt: Date.now() + DEPLOYMENT_CACHE_MS,
    value,
  });
  value.catch(() => deploymentCache.delete(cacheKey));
  return enrichDeploymentsWithStages(config, await value);
}

export async function getCurrentProductionDeployments(
  config: ConnectionConfig,
  repository: string,
  forceRefresh = false,
): Promise<JenkinsDeployedTag[]> {
  if (!config.productionJenkins) return [];
  const services = servicesForRepository(repository);
  if (services.length === 0) return [];
  const prodConfig = productionConfig(config);
  const cacheKey =
    `production:${prodConfig.jenkinsUrl}:${repository}`.toLowerCase();
  const cached = deploymentCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return enrichDeploymentsWithStages(config, await cached.value);
  }

  const value = (async () => {
    try {
      const builds = await recentProductionDeploymentBuilds(
        config,
        forceRefresh,
      );
      return productionDeployedTagsFromBuilds(builds, services);
    } catch (error) {
      throw new ProviderError(
        error instanceof Error
          ? `Could not read current production deployments: ${error.message}`
          : "Could not read current production deployments.",
        "JENKINS_PRODUCTION_DEPLOYMENT_LOOKUP_FAILED",
        "jenkins",
        502,
        true,
      );
    }
  })();
  deploymentCache.set(cacheKey, {
    expiresAt: Date.now() + DEPLOYMENT_CACHE_MS,
    value,
  });
  value.catch(() => deploymentCache.delete(cacheKey));
  return enrichDeploymentsWithStages(config, await value);
}

export async function getCurrentDeploymentsBatch(
  config: ConnectionConfig,
  requestedRepositories: string[],
  forceRefresh = false,
): Promise<RepositoryDeploymentStatusResult[]> {
  const repositories = [...new Set(requestedRepositories)];
  const hasMappedServices = repositories.some(
    (repository) => servicesForRepository(repository).length > 0,
  );
  if (!hasMappedServices) {
    return repositories.map((repository) => ({
      repository,
      deployedTags: [],
      deploymentLookupFailed: false,
    }));
  }

  const [stagingResult, productionResult] = await Promise.allSettled([
    recentDeploymentBuilds(config, forceRefresh),
    config.productionJenkins
      ? recentProductionDeploymentBuilds(config, forceRefresh)
      : Promise.resolve([]),
  ]);

  const results = repositories.map((repository) => {
    const services = servicesForRepository(repository);
    if (services.length === 0) {
      return {
        repository,
        deployedTags: [],
        deploymentLookupFailed: false,
      };
    }
    const stagingTags =
      stagingResult.status === "fulfilled"
        ? deployedTagsFromBuilds(
            stagingResult.value.qa,
            stagingResult.value.staging,
            services,
          )
        : [];
    const productionTags =
      productionResult.status === "fulfilled"
        ? productionDeployedTagsFromBuilds(productionResult.value, services)
        : [];
    const deployedTags = [...stagingTags, ...productionTags];
    const stagingKey = repository.toLowerCase();
    deploymentCache.set(stagingKey, {
      expiresAt: Date.now() + DEPLOYMENT_CACHE_MS,
      value: Promise.resolve(stagingTags),
    });
    if (config.productionJenkins) {
      const prodKey =
        `production:${config.productionJenkins.jenkinsUrl}:${repository}`.toLowerCase();
      deploymentCache.set(prodKey, {
        expiresAt: Date.now() + DEPLOYMENT_CACHE_MS,
        value: Promise.resolve(productionTags),
      });
    }
    return {
      repository,
      deployedTags,
      deploymentLookupFailed:
        stagingResult.status === "rejected" ||
        (Boolean(config.productionJenkins) &&
          productionResult.status === "rejected"),
    };
  });

  return Promise.all(
    results.map(async (result) => ({
      ...result,
      deployedTags: await enrichDeploymentsWithStages(
        config,
        result.deployedTags,
      ),
    })),
  );
}

const eitriNamespaces = new Set<EitriNamespace>([
  "s1",
  "s2",
  "s3",
  "s4",
  "s5",
]);

export function buildStatusFromResult(
  result?: string | null,
  building?: boolean,
): EitriBuild["status"] {
  if (building === true) return "running";
  if (result === "SUCCESS") return "succeeded";
  if (result === "ABORTED") return "canceled";
  if (result) return "failed";
  // Null result with building=false/unknown is still treated as in-flight;
  // wfapi enrichment reconciles true terminals when Jenkins lags on result.
  return "running";
}

export function buildStatusFromPipelineRunStatus(
  status?: string | null,
): EitriBuild["status"] | undefined {
  switch ((status ?? "").toUpperCase()) {
    case "SUCCESS":
      return "succeeded";
    case "FAILED":
    case "FAILURE":
    case "UNSTABLE":
      return "failed";
    case "ABORTED":
    case "CANCELLED":
    case "CANCELED":
      return "canceled";
    case "IN_PROGRESS":
    case "RUNNING":
    case "PAUSED_PENDING_INPUT":
      return "running";
    default:
      return undefined;
  }
}

export function statusFromPipelineStages(
  stages: EitriBuildStage[],
): EitriBuild["status"] | undefined {
  if (stages.length === 0) return undefined;
  if (stages.some((stage) => stage.status === "running")) return undefined;
  if (stages.some((stage) => stage.status === "failed")) return "failed";
  if (stages.some((stage) => stage.status === "canceled")) return "canceled";
  if (stages.some((stage) => stage.status === "pending")) return undefined;
  if (stages.every((stage) => stage.status === "succeeded")) return "succeeded";
  return undefined;
}

function reconcileRunningStatus(
  status: EitriBuild["status"] | undefined,
  stages: EitriBuildStage[],
  pipelineRunStatus?: string | null,
): EitriBuild["status"] | undefined {
  if (status !== "running") return status;
  return (
    buildStatusFromPipelineRunStatus(pipelineRunStatus) ??
    statusFromPipelineStages(stages) ??
    status
  );
}

export function eitriDeploymentSpec(
  input: TriggerEitriDeploymentInput,
): DeploymentSpec {
  const validServices = servicesForRepository(input.repository);
  if (!validServices.includes(input.service)) {
    throw new ProviderError(
      `Jenkins service "${input.service}" is not mapped to ${input.repository}.`,
      "JENKINS_SERVICE_NOT_MAPPED",
      "jenkins",
      400,
    );
  }
  if (!eitriNamespaces.has(input.namespace)) {
    throw new ProviderError(
      `EITRI namespace "${input.namespace}" is not supported.`,
      "EITRI_NAMESPACE_UNSUPPORTED",
      "jenkins",
      400,
    );
  }

  const parameters: Record<string, string | boolean> = {
    SERVICE_NAME: stagingDeployServiceName(input.service),
    NAMESPACE: input.namespace,
    STAGING_ENV_UPDATE_JOB:
      input.stagingEnvUpdateJob?.trim() ||
      EITRI_DEFAULT_STAGING_ENV_UPDATE_JOB,
  };
  const branch = input.branch?.trim();
  if (branch) parameters.BRANCH = branch;
  const commitSha = input.commitSha?.trim();
  if (commitSha) parameters.COMMIT_SHA = commitSha;

  return {
    jobName: EITRI_JOB_NAME,
    parameters,
  };
}

export function eitriBuildsFromJobBuilds(
  builds: JenkinsBuild[],
  services: string[],
): EitriBuild[] {
  const serviceNames = new Map<string, string>();
  for (const service of services) {
    serviceNames.set(service.toLowerCase(), service);
    serviceNames.set(stagingDeployServiceName(service).toLowerCase(), service);
  }

  return [...builds]
    .sort((left, right) => right.number - left.number)
    .flatMap((build) => {
      const parameters = buildParameters(build);
      const serviceName = parameters.SERVICE_NAME?.toLowerCase();
      const service = serviceName ? serviceNames.get(serviceName) : undefined;
      const namespace = parameters.NAMESPACE?.toLowerCase() as
        | EitriNamespace
        | undefined;
      if (!service || !namespace || !eitriNamespaces.has(namespace)) {
        return [];
      }
      return [
        {
          buildNumber: build.number,
          buildUrl: build.url ?? "",
          service,
          namespace,
          branch: parameters.BRANCH || undefined,
          commitSha: parameters.COMMIT_SHA || undefined,
          stagingEnvUpdateJob: parameters.STAGING_ENV_UPDATE_JOB || undefined,
          status: buildStatusFromResult(build.result, build.building),
          createdAt: new Date(build.timestamp ?? 0).toISOString(),
        } satisfies EitriBuild,
      ];
    });
}

export function pipelineStageStatus(status?: string | null): EitriStageStatus {
  switch ((status ?? "").toUpperCase()) {
    case "SUCCESS":
      return "succeeded";
    case "FAILED":
    case "FAILURE":
    case "UNSTABLE":
      return "failed";
    case "ABORTED":
    case "CANCELLED":
    case "CANCELED":
      return "canceled";
    case "IN_PROGRESS":
    case "RUNNING":
    case "PAUSED_PENDING_INPUT":
      return "running";
    default:
      return "pending";
  }
}

/** @deprecated Prefer pipelineStageStatus */
export const eitriStageStatus = pipelineStageStatus;

export function pipelineStagesFromDescribe(describe: {
  stages?: Array<{
    id?: string | number;
    name?: string;
    status?: string | null;
    durationMillis?: number;
  }>;
}): EitriBuildStage[] {
  return (describe.stages ?? [])
    .filter((stage) => stage.name)
    .map((stage) => ({
      id: String(stage.id ?? stage.name),
      name: String(stage.name),
      status: pipelineStageStatus(stage.status),
      durationMillis:
        typeof stage.durationMillis === "number"
          ? stage.durationMillis
          : undefined,
    }));
}

/** @deprecated Prefer pipelineStagesFromDescribe */
export const eitriStagesFromDescribe = pipelineStagesFromDescribe;

export function currentPipelineStageName(stages: EitriBuildStage[]) {
  return (
    [...stages].reverse().find((stage) => stage.status === "running")?.name ??
    stages.find((stage) => stage.status === "pending")?.name ??
    stages.at(-1)?.name
  );
}

/** @deprecated Prefer currentPipelineStageName */
export const currentEitriStageName = currentPipelineStageName;

async function getPipelineDescribe(
  config: ConnectionConfig,
  jobName: string,
  buildNumber: number,
): Promise<{ stages: EitriBuildStage[]; status?: string | null }> {
  const describe = await jenkinsApiGet<{
    status?: string | null;
    stages?: Array<{
      id?: string | number;
      name?: string;
      status?: string | null;
      durationMillis?: number;
    }>;
  }>(config, `${jenkinsJobPath(jobName)}/${buildNumber}/wfapi/describe`);
  return {
    stages: pipelineStagesFromDescribe(describe),
    status: describe.status,
  };
}

async function enrichDeploymentsWithStages(
  config: ConnectionConfig,
  deployments: JenkinsDeployedTag[],
): Promise<JenkinsDeployedTag[]> {
  const running = deployments.filter(
    (deployment) => deployment.status === "running",
  );
  if (running.length === 0) return deployments;

  const results = await Promise.allSettled(
    running.map(async (deployment) => {
      const jobName =
        deployment.jobName ?? deploymentJobName(deployment.environment);
      const jenkinsConfig =
        deployment.environment === "production"
          ? productionConfig(config)
          : config;
      const describe = await getPipelineDescribe(
        jenkinsConfig,
        jobName,
        deployment.buildNumber,
      );
      return {
        buildNumber: deployment.buildNumber,
        environment: deployment.environment,
        service: deployment.service,
        stages: describe.stages,
        pipelineRunStatus: describe.status,
      };
    }),
  );
  const stagesByKey = new Map<
    string,
    { stages: EitriBuildStage[]; pipelineRunStatus?: string | null }
  >();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    stagesByKey.set(
      `${result.value.environment}:${result.value.service}:${result.value.buildNumber}`,
      {
        stages: result.value.stages,
        pipelineRunStatus: result.value.pipelineRunStatus,
      },
    );
  }

  return deployments.map((deployment) => {
    const enriched = stagesByKey.get(
      `${deployment.environment}:${deployment.service}:${deployment.buildNumber}`,
    );
    if (!enriched) return deployment;
    const status = reconcileRunningStatus(
      deployment.status,
      enriched.stages,
      enriched.pipelineRunStatus,
    );
    if (enriched.stages.length === 0) {
      return status === deployment.status
        ? deployment
        : { ...deployment, status };
    }
    return {
      ...deployment,
      status,
      stages: enriched.stages,
      currentStage:
        status === "running"
          ? currentPipelineStageName(enriched.stages)
          : undefined,
    };
  });
}

async function enrichEitriBuildStages(
  config: ConnectionConfig,
  builds: EitriBuild[],
): Promise<EitriBuild[]> {
  const running = builds.filter((build) => build.status === "running");
  if (running.length === 0) return builds;

  const results = await Promise.allSettled(
    running.map(async (build) => {
      const describe = await getPipelineDescribe(
        config,
        EITRI_JOB_NAME,
        build.buildNumber,
      );
      return {
        buildNumber: build.buildNumber,
        stages: describe.stages,
        pipelineRunStatus: describe.status,
      };
    }),
  );
  const stagesByBuild = new Map<
    number,
    { stages: EitriBuildStage[]; pipelineRunStatus?: string | null }
  >();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    stagesByBuild.set(result.value.buildNumber, {
      stages: result.value.stages,
      pipelineRunStatus: result.value.pipelineRunStatus,
    });
  }

  return builds.map((build) => {
    const enriched = stagesByBuild.get(build.buildNumber);
    if (!enriched) return build;
    const status =
      reconcileRunningStatus(
        build.status,
        enriched.stages,
        enriched.pipelineRunStatus,
      ) ?? build.status;
    if (enriched.stages.length === 0) {
      return status === build.status ? build : { ...build, status };
    }
    return {
      ...build,
      status,
      stages: enriched.stages,
      currentStage:
        status === "running"
          ? currentPipelineStageName(enriched.stages)
          : undefined,
    };
  });
}

async function recentEitriBuilds(
  config: ConnectionConfig,
  forceRefresh = false,
) {
  const cacheKey = config.jenkinsUrl.toLowerCase();
  const cached = eitriBuildCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const value = recentJobBuilds(jenkinsClient(config), EITRI_JOB_NAME);
  eitriBuildCache.set(cacheKey, {
    expiresAt: Date.now() + DEPLOYMENT_CACHE_MS,
    value,
  });
  value.catch(() => eitriBuildCache.delete(cacheKey));
  return value;
}

export async function getEitriBuilds(
  config: ConnectionConfig,
  repository: string,
  forceRefresh = false,
): Promise<EitriBuildsResult> {
  const jenkinsServices = servicesForRepository(repository);
  const fetchedAt = new Date().toISOString();
  if (jenkinsServices.length === 0) {
    return {
      repository,
      jenkinsServices,
      builds: [],
      lookupFailed: false,
      fetchedAt,
    };
  }
  try {
    const builds = await recentEitriBuilds(config, forceRefresh);
    const mapped = eitriBuildsFromJobBuilds(builds, jenkinsServices).slice(
      0,
      25,
    );
    return {
      repository,
      jenkinsServices,
      builds: await enrichEitriBuildStages(config, mapped),
      lookupFailed: false,
      fetchedAt,
    };
  } catch {
    return {
      repository,
      jenkinsServices,
      builds: [],
      lookupFailed: true,
      fetchedAt,
    };
  }
}

export async function triggerEitriDeployment(
  config: ConnectionConfig,
  input: TriggerEitriDeploymentInput,
): Promise<TriggeredEitriDeployment> {
  const spec = eitriDeploymentSpec(input);
  try {
    const client = jenkinsClient(config);
    const queueId = Number(
      await client.job.build({
        name: spec.jobName,
        parameters: spec.parameters,
      }),
    );
    if (!Number.isInteger(queueId) || queueId <= 0) {
      throw new Error("Jenkins did not return a valid queue item.");
    }
    let buildUrl: string | undefined;
    let buildNumber: number | undefined;
    try {
      const queueItem = (await client.queue.item(queueId)) as {
        executable?: { number?: number; url?: string };
      };
      buildUrl = queueItem.executable?.url;
      buildNumber = queueItem.executable?.number;
    } catch {
      // It is normal for the queue item to take a moment to become available.
    }
    invalidateJenkinsBuildCaches();
    return {
      queueId,
      queueUrl: `${config.jenkinsUrl.replace(/\/+$/, "")}/queue/item/${queueId}/`,
      buildUrl,
      buildNumber,
      jobName: spec.jobName,
      service: input.service,
      namespace: input.namespace,
      branch: input.branch?.trim() || undefined,
      commitSha: input.commitSha?.trim() || undefined,
      stagingEnvUpdateJob: String(spec.parameters.STAGING_ENV_UPDATE_JOB),
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      jenkinsTriggerFailureMessage(error, spec),
      "JENKINS_EITRI_TRIGGER_FAILED",
      "jenkins",
      502,
    );
  }
}

export function deploymentSpec(input: TriggerDeploymentInput): DeploymentSpec {
  const validServices = servicesForRepository(input.repository);
  if (!validServices.includes(input.service)) {
    throw new ProviderError(
      `Jenkins service "${input.service}" is not mapped to ${input.repository}.`,
      "JENKINS_SERVICE_NOT_MAPPED",
      "jenkins",
      400,
    );
  }

  if (input.environment === "qa") {
    return {
      jobName: "QA/QA-DEPLOYMENT",
      parameters: {
        TEAM: "QA",
        SERVICE: input.service,
        IMAGE_TAG: input.tag,
        IS_PROD_TAG: false,
        TRIGGER_PNS_SUITE: false,
        TRIGGER_AUTOMATION_SUITE: false,
      },
    };
  }

  return {
    jobName: "DEV/DEV Deployer",
    parameters: {
      TEAM: stagingTeams[input.environment],
      SERVICE_NAME: stagingDeployServiceName(input.service),
      IMAGE_TAG: input.tag,
      IS_PROD_TAG: false,
      SKIP_MIGRATION: false,
    },
  };
}

export function productionDeploymentSpec(
  input: TriggerProductionDeploymentInput,
): DeploymentSpec {
  const validServices = servicesForRepository(input.repository);
  if (!validServices.includes(input.service)) {
    throw new ProviderError(
      `Jenkins service "${input.service}" is not mapped to ${input.repository}.`,
      "JENKINS_SERVICE_NOT_MAPPED",
      "jenkins",
      400,
    );
  }
  if (input.qaApprovalRequired && !input.qaName?.trim()) {
    throw new ProviderError(
      "QA name is required when QA approval is enabled.",
      "QA_NAME_REQUIRED",
      "jenkins",
      400,
    );
  }
  return {
    jobName: "Prod Deployments/Prod-cluster-deployment",
    parameters: {
      SERVICE: productionDeployServiceName(input.service),
      IMAGE_TAG: input.imageTag,
      QA_APPROVAL_REQUIRED: input.qaApprovalRequired,
      QA_NAME: input.qaName?.trim() ?? "",
      SKIP_PROD_MIGRATION: input.skipProdMigration,
      PROD_MIGRATION_JOB: input.prodMigrationJob,
    },
  };
}

function productionConfig(config: ConnectionConfig): ConnectionConfig {
  if (!config.productionJenkins) {
    throw new ProviderError(
      "Production Jenkins credentials are not configured.",
      "PRODUCTION_JENKINS_NOT_CONFIGURED",
      "jenkins",
      409,
    );
  }
  return {
    ...config,
    jenkinsUrl: config.productionJenkins.jenkinsUrl,
    jenkinsUsername: config.productionJenkins.jenkinsUsername,
    jenkinsToken: config.productionJenkins.jenkinsToken,
  };
}

export async function testJenkinsConnection(
  config: ConnectionConfig,
  environment: "staging" | "production" = "staging",
) {
  try {
    const info = (await jenkinsClient(config).info()) as {
      nodeName?: string;
      mode?: string;
    };
    return { name: info.nodeName || info.mode || "Jenkins" };
  } catch (error) {
    const requestError = error as Error & {
      res?: {
        statusCode?: number;
        headers?: { location?: string };
      };
    };
    const status = requestError.res?.statusCode;
    const location = requestError.res?.headers?.location;
    let message = `Jenkins ${environment} connection failed.`;
    if (status === 301 || status === 302 || status === 303) {
      message =
        `Jenkins ${environment} redirected the API request` +
        `${location ? ` to ${location}` : ""}. Verify the Jenkins URL, username, and API token; the request may be reaching the SSO login page.`;
    } else if (status === 401 || status === 403) {
      message = `Jenkins ${environment} rejected the username or API token.`;
    } else if (error instanceof Error) {
      message = `Jenkins ${environment} connection failed: ${error.message}`;
    }
    throw new ProviderError(
      message,
      "JENKINS_CONNECTION_FAILED",
      "jenkins",
      502,
    );
  }
}

export async function triggerDeployment(
  config: ConnectionConfig,
  input: TriggerDeploymentInput,
): Promise<TriggeredDeployment> {
  const spec = deploymentSpec(input);
  try {
    const client = jenkinsClient(config);
    const queueId = Number(
      await client.job.build({
        name: spec.jobName,
        parameters: spec.parameters,
      }),
    );
    if (!Number.isInteger(queueId) || queueId <= 0) {
      throw new Error("Jenkins did not return a valid queue item.");
    }
    let buildUrl: string | undefined;
    try {
      const queueItem = (await client.queue.item(queueId)) as {
        executable?: { url?: string };
      };
      buildUrl = queueItem.executable?.url;
    } catch {
      // It is normal for the queue item to take a moment to become available.
    }
    invalidateJenkinsBuildCaches();
    return {
      queueId,
      queueUrl: `${config.jenkinsUrl.replace(/\/+$/, "")}/queue/item/${queueId}/`,
      buildUrl,
      jobName: spec.jobName,
      service: input.service,
      tag: input.tag,
      environment: input.environment,
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      jenkinsTriggerFailureMessage(error, spec),
      "JENKINS_TRIGGER_FAILED",
      "jenkins",
      502,
    );
  }
}

function jenkinsResponseBody(error: unknown) {
  const requestError = error as { res?: { body?: unknown } };
  const body = requestError.res?.body;
  if (typeof body === "string") return body;
  if (body == null) return "";
  return JSON.stringify(body);
}

function jenkinsTriggerFailureMessage(error: unknown, spec: DeploymentSpec) {
  const requestError = error as Error & {
    message?: string;
    res?: { statusCode?: number; body?: unknown };
  };
  const body = jenkinsResponseBody(error);
  const description = body.match(
    /id=["']?error-description["']?[^>]*>\s*([^<]+)/i,
  )?.[1]?.replace(/\s+/g, " ").trim();
  const detailMatch = body.match(
    /(?:IllegalArgumentException|Invalid parameter|is not a valid|Error while serving)[^<]{0,240}/i,
  );
  const detail = (description || detailMatch?.[0] || "")
    .replace(/\s+/g, " ")
    .trim();
  const service = String(
    spec.parameters.SERVICE ?? spec.parameters.SERVICE_NAME ?? "",
  );
  const base = requestError.message
    ? `Jenkins deployment trigger failed: ${requestError.message}`
    : "Jenkins deployment trigger failed.";
  if (detail) return `${base} ${detail}`;
  if (requestError.res?.statusCode === 500) {
    return `${base} Job ${spec.jobName} rejected service "${service}". Confirm it is listed under TEAM "${String(spec.parameters.TEAM ?? "")}" in Jenkins.`;
  }
  return base;
}

export async function triggerProductionDeployment(
  config: ConnectionConfig,
  input: TriggerProductionDeploymentInput,
): Promise<TriggeredProductionDeployment> {
  const prodConfig = productionConfig(config);
  const spec = productionDeploymentSpec(input);
  try {
    const client = jenkinsClient(prodConfig);
    const queueId = Number(
      await client.job.build({
        name: spec.jobName,
        parameters: spec.parameters,
      }),
    );
    if (!Number.isInteger(queueId) || queueId <= 0) {
      throw new Error("Jenkins did not return a valid queue item.");
    }
    let buildUrl: string | undefined;
    let buildNumber: number | undefined;
    try {
      const queueItem = (await client.queue.item(queueId)) as {
        executable?: { number?: number; url?: string };
      };
      buildUrl = queueItem.executable?.url;
      buildNumber = queueItem.executable?.number;
    } catch {
      // It is normal for the queue item to take a moment to become available.
    }
    invalidateJenkinsBuildCaches();
    return {
      queueId,
      queueUrl: `${prodConfig.jenkinsUrl.replace(/\/+$/, "")}/queue/item/${queueId}/`,
      buildUrl,
      buildNumber,
      jobName: spec.jobName,
      service: input.service,
      imageTag: input.imageTag,
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      error instanceof Error
        ? `Production deployment trigger failed: ${error.message}`
        : "Production deployment trigger failed.",
      "PRODUCTION_JENKINS_TRIGGER_FAILED",
      "jenkins",
      502,
    );
  }
}

export async function getDeploymentQueueStatus(
  config: ConnectionConfig,
  queueId: number,
): Promise<JenkinsQueueStatus> {
  try {
    const item = (await jenkinsClient(config).queue.item(queueId)) as {
      cancelled?: boolean;
      why?: string;
      executable?: { number?: number; url?: string };
    };
    if (item.cancelled) {
      return {
        queueId,
        status: "canceled",
        message: "The Jenkins queue item was canceled.",
      };
    }
    if (item.executable?.url) {
      return {
        queueId,
        status: "started",
        buildUrl: item.executable.url,
        buildNumber: item.executable.number,
      };
    }
    return {
      queueId,
      status: "queued",
      message: item.why || "Waiting for a Jenkins executor.",
    };
  } catch (error) {
    throw new ProviderError(
      error instanceof Error
        ? `Could not resolve Jenkins queue item: ${error.message}`
        : "Could not resolve Jenkins queue item.",
      "JENKINS_QUEUE_LOOKUP_FAILED",
      "jenkins",
      502,
      true,
    );
  }
}

export function getProductionDeploymentQueueStatus(
  config: ConnectionConfig,
  queueId: number,
) {
  return getDeploymentQueueStatus(productionConfig(config), queueId);
}

export async function getProductionDeploymentBuildStatus(
  config: ConnectionConfig,
  buildNumber: number,
): Promise<JenkinsBuildStatus> {
  try {
    const build = (await jenkinsClient(productionConfig(config)).build.get(
      "Prod Deployments/Prod-cluster-deployment",
      buildNumber,
    )) as {
      building?: boolean;
      result?: string | null;
      url?: string;
    };
    return {
      buildNumber,
      status: buildStatusFromResult(build.result, build.building),
      buildUrl: build.url,
    };
  } catch (error) {
    throw new ProviderError(
      error instanceof Error
        ? `Could not resolve production Jenkins build: ${error.message}`
        : "Could not resolve production Jenkins build.",
      "JENKINS_PRODUCTION_BUILD_LOOKUP_FAILED",
      "jenkins",
      502,
      true,
    );
  }
}
