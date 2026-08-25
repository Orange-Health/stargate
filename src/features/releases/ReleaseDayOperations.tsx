import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../shared/api";
import {
  promotionBranches,
  promotionRouteLabel,
  promotionRoutes,
  readUseReleaseBranch,
} from "../../shared/branchModel";
import type {
  BuildStatus,
  CreatedProductionRelease,
  JenkinsDeployedTag,
  JiraIssue,
  PromotionPullRequest,
  PromotionRoute,
  ReleaseControlRoomState,
  ReleaseControlSyncProgress,
  ReleaseDashboard,
  TrackedProductionRelease,
  TriggeredProductionDeployment,
} from "../../shared/types";
import { DialogBackdrop } from "./DialogBackdrop";
import { ProductionDeployDialog } from "./ProductionDeployDialog";
import { ReleaseDevelopersDialog } from "./ReleaseDevelopersDialog";
import type { ReleaseDeveloper } from "./releaseDevelopers";
import {
  defaultBranchNeedsNewProductionTag,
  developersForReleaseService,
  productionTagDeltaPending,
} from "./releaseDayHelpers";
import {
  copyReleaseNotesContent,
  latestProductionReleaseOnDate,
  releaseCreatedOnDate,
  releaseNotesForDashboard,
  type ReleaseNotesFormat,
} from "./releaseNotes";
import { computeControlRoomProgress } from "./releaseProgress";
import { ReleaseProgressBar } from "./ReleaseProgressBar";
import {
  displaySyncPercent,
  EXPECTED_SYNC_MS_PER_SERVICE,
  readSyncMsPerServicePrior,
  updateSyncMsPerServicePrior,
} from "./syncProgressEstimate";

type Props = {
  dashboard: ReleaseDashboard;
  productionEnabled: boolean;
  onClose: () => void;
};

type OperationLog = {
  id: string;
  at: string;
  repository?: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
};

type RepositoryProgress = {
  productionRelease?: CreatedProductionRelease;
  productionReleaseError?: string;
  productionDeployment?: TriggeredProductionDeployment & {
    status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  };
  error?: string;
};

type BatchSession = {
  versionId: string;
  operationId: string;
  releaseDate: string;
  startedAt: string;
  selectedRepositories: string[];
  repositories: Record<string, RepositoryProgress>;
  logs: OperationLog[];
};

type DeployTarget = {
  repository: string;
  release: CreatedProductionRelease;
  services: string[];
};

type CellOperation = {
  repository: string;
  route: PromotionRoute;
  label: string;
};

type RepositorySyncStatus = "queued" | "syncing" | "synced" | "failed";

type DeveloperModalState = {
  repository: string;
  developers: ReleaseDeveloper[];
  loading: boolean;
};

const POLL_INTERVAL = 15_000;
const BUILD_POLL_TIMEOUT_MS = 30_000;
const MAX_CONCURRENCY = 3;
const REPOSITORY_SYNC_CONCURRENCY = 2;
const REPOSITORY_STATE_CACHE_MS = 60_000;
const SYNC_PROGRESS_POLL_MS = 2_000;
const SYNC_TIMEOUT_MS = 90_000;
const LEGACY_SYNC_TIMEOUT_MS = 20_000;
const JIRA_RELEASE_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error("Timed out"));
    }, ms);
    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (reason) => {
        window.clearTimeout(timeoutId);
        reject(reason);
      },
    );
  });
}

function productionDeploymentLabel(deployment: JenkinsDeployedTag) {
  switch (deployment.status) {
    case "running":
      return deployment.currentStage
        ? `Running: ${deployment.tag} · ${deployment.currentStage}`
        : `Running: ${deployment.tag}`;
    case "failed":
      return `Failed: ${deployment.tag}`;
    case "canceled":
      return `Canceled: ${deployment.tag}`;
    default:
      return `Live: ${deployment.tag}`;
  }
}

type CachedRepositoryStates = {
  cachedAt: number;
  states: Record<string, ReleaseControlRoomState>;
};

type LegacyCachedRepositoryStates = Record<
  string,
  { syncedAt: number; state: ReleaseControlRoomState }
>;

type CachedReleaseDevelopers = Record<
  string,
  { cachedAt: number; developers: ReleaseDeveloper[] }
>;

function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function sessionKey(versionId: string) {
  return `release-day-operations:${versionId}`;
}

function repositoryStateCacheKey(versionId: string) {
  return `release-day-repository-states:${versionId}`;
}

function releaseDevelopersCacheKey(versionId: string) {
  return `release-day-developers:${versionId}`;
}

function restoreRepositoryStates(dashboard: ReleaseDashboard) {
  const states: Record<string, ReleaseControlRoomState | undefined> = {};
  let cachedAt = 0;
  try {
    const raw = window.localStorage.getItem(
      repositoryStateCacheKey(dashboard.version.id),
    );
    if (!raw) return { states, cachedAt };
    const parsed = JSON.parse(raw) as
      | CachedRepositoryStates
      | LegacyCachedRepositoryStates;
    const currentCache = parsed as CachedRepositoryStates;
    const cached: CachedRepositoryStates =
      typeof currentCache.cachedAt === "number" &&
      typeof currentCache.states === "object"
        ? currentCache
        : {
            cachedAt: Math.max(
              0,
              ...Object.values(parsed as LegacyCachedRepositoryStates).map(
                (entry) => entry.syncedAt,
              ),
            ),
            states: Object.fromEntries(
              Object.entries(parsed as LegacyCachedRepositoryStates).map(
                ([repository, entry]) => [repository, entry.state],
              ),
            ),
          };
    cachedAt = cached.cachedAt;
    if (Date.now() - cachedAt >= REPOSITORY_STATE_CACHE_MS) {
      return { states, cachedAt: 0 };
    }
    const available = new Set(
      dashboard.services.map((service) => service.repository),
    );
    for (const [repository, state] of Object.entries(cached.states)) {
      if (available.has(repository) && state?.repository === repository) {
        states[repository] = state;
      }
    }
  } catch {
    // Ignore invalid or expired local cache data.
  }
  return { states, cachedAt };
}

function newSession(dashboard: ReleaseDashboard): BatchSession {
  return {
    versionId: dashboard.version.id,
    operationId: crypto.randomUUID(),
    releaseDate: dashboard.version.releaseDate ?? localDate(),
    startedAt: new Date().toISOString(),
    selectedRepositories: dashboard.services.map(
      (service) => service.repository,
    ),
    repositories: Object.fromEntries(
      dashboard.services.map((service) => [service.repository, {}]),
    ),
    logs: [],
  };
}

function restoreSession(dashboard: ReleaseDashboard): BatchSession {
  try {
    const raw = window.localStorage.getItem(sessionKey(dashboard.version.id));
    if (!raw) return newSession(dashboard);
    const saved = JSON.parse(raw) as BatchSession;
    if (
      saved.versionId !== dashboard.version.id ||
      !saved.operationId ||
      !Array.isArray(saved.selectedRepositories) ||
      !Array.isArray(saved.logs)
    ) {
      return newSession(dashboard);
    }
    const available = new Set(
      dashboard.services.map((service) => service.repository),
    );
    return {
      ...saved,
      selectedRepositories: saved.selectedRepositories.filter((repository) =>
        available.has(repository),
      ),
      repositories: Object.fromEntries(
        dashboard.services.map((service) => [
          service.repository,
          saved.repositories?.[service.repository] ?? {},
        ]),
      ),
    };
  } catch {
    return newSession(dashboard);
  }
}

async function mapConcurrent<T>(
  values: T[],
  task: (value: T) => Promise<void>,
  concurrency = MAX_CONCURRENCY,
) {
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const value = values[cursor++];
      await task(value);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () =>
      worker(),
    ),
  );
}

function routeStep(
  state: ReleaseControlRoomState | undefined,
  route: PromotionRoute,
) {
  return state?.promotionSteps.find((step) => step.route === route);
}

function hardMergeBlockReason(pull: PromotionPullRequest) {
  if (pull.draft) return "PR is still a draft";
  if (pull.mergeable === null) return "GitHub is still checking mergeability";
  if (pull.mergeable === false || pull.mergeableState === "dirty") {
    return "PR has merge conflicts";
  }
  return undefined;
}

function checksSoftBlockReason(pull: PromotionPullRequest) {
  if (pull.checks === "pending") return "Checks are pending";
  if (pull.checks === "failure") return "Checks are failing";
  return undefined;
}

function hasUnresolvedComments(pull: PromotionPullRequest) {
  return (pull.unresolvedReviewThreads ?? 0) > 0;
}

function hasForceMergeableUnresolvedComments(pull: PromotionPullRequest) {
  return hasUnresolvedComments(pull) && pull.reviewDecision === "approved";
}

function mergeBlockReason(pull: PromotionPullRequest) {
  if (hasUnresolvedComments(pull)) {
    return "Resolve unresolved review comments";
  }
  return hardMergeBlockReason(pull) ?? checksSoftBlockReason(pull);
}

function canForceMergePull(pull: PromotionPullRequest) {
  return (
    !hardMergeBlockReason(pull) &&
    (Boolean(checksSoftBlockReason(pull)) ||
      hasForceMergeableUnresolvedComments(pull))
  );
}

function phaseState(
  state: ReleaseControlRoomState | undefined,
  route: PromotionRoute,
  mode: "create" | "merge",
  syncStatus?: RepositorySyncStatus,
) {
  const step = routeStep(state, route);
  if (!step) {
    return {
      label:
        syncStatus === "queued" || syncStatus === "syncing"
          ? "Checking"
          : "Refresh pending",
      tone: "pending",
    };
  }
  if (step.state === "up_to_date") {
    return { label: mode === "merge" ? "Merged" : "Ready", tone: "success" };
  }
  if (step.state === "needs_pr") {
    return { label: "PR needed", tone: "pending" };
  }
  const blocked = step.pullRequest
    ? mergeBlockReason(step.pullRequest)
    : "PR details unavailable";
  if (mode === "merge" && blocked) {
    return { label: blocked, tone: "error" };
  }
  return {
    label: step.pullRequest ? `PR #${step.pullRequest.number}` : "PR open",
    tone: "success",
  };
}

const buildLabels: Record<BuildStatus, string> = {
  starting: "Waiting for workflow",
  running: "Build running",
  succeeded: "Build succeeded",
  failed: "Build failed",
  canceled: "Build canceled",
};

export function ReleaseDayOperations({
  dashboard,
  productionEnabled,
  onClose,
}: Props) {
  const useReleaseBranch = readUseReleaseBranch();
  const hopRoutes = promotionRoutes(useReleaseBranch);
  const firstHop = hopRoutes[0];
  const lastHop = hopRoutes[hopRoutes.length - 1];
  const [session, setSession] = useState(() => restoreSession(dashboard));
  const restoredRepositoryStates = useRef(
    restoreRepositoryStates(dashboard),
  ).current;
  const [states, setStates] = useState<
    Record<string, ReleaseControlRoomState | undefined>
  >(restoredRepositoryStates.states);
  const [refreshing, setRefreshing] = useState(false);
  const [batchSyncProgress, setBatchSyncProgress] =
    useState<ReleaseControlSyncProgress>();
  const [busyAction, setBusyAction] = useState("");
  const [activeProductionRelease, setActiveProductionRelease] = useState("");
  const [checkingBuildRepository, setCheckingBuildRepository] = useState("");
  const [developerLists, setDeveloperLists] = useState<
    Record<string, ReleaseDeveloper[]>
  >(() =>
    Object.fromEntries(
      dashboard.services.map((service) => [
        service.repository,
        developersForReleaseService(service),
      ]),
    ),
  );
  const [developerModal, setDeveloperModal] = useState<DeveloperModalState>();
  const [copyNotesStatus, setCopyNotesStatus] = useState<
    "idle" | "copying" | "copied" | "error"
  >("idle");
  const [jiraReleaseStatus, setJiraReleaseStatus] = useState<
    "idle" | "running" | "success" | "partial" | "error"
  >("idle");
  const [jiraReleaseMessage, setJiraReleaseMessage] = useState("");
  const [jiraReleaseDialogOpen, setJiraReleaseDialogOpen] = useState(false);
  const [selectedJiraIssueKeys, setSelectedJiraIssueKeys] = useState<string[]>(
    [],
  );
  const [releasedJiraIssueKeys, setReleasedJiraIssueKeys] = useState<
    Set<string>
  >(() => new Set());
  const jiraReleaseRequestId = useRef(0);
  const [copyNotesMenuOpen, setCopyNotesMenuOpen] = useState(false);
  const [operationLogExpanded, setOperationLogExpanded] = useState(true);
  const copyNotesMenuRef = useRef<HTMLDivElement>(null);
  const [cellOperation, setCellOperation] = useState<CellOperation>();
  const [repositorySync, setRepositorySync] = useState<
    Record<string, RepositorySyncStatus>
  >(
    Object.fromEntries(
      Object.keys(restoredRepositoryStates.states).map((repository) => [
        repository,
        "synced" as const,
      ]),
    ),
  );
  const [deployTarget, setDeployTarget] = useState<DeployTarget>();
  const sessionRef = useRef(session);
  const statesRef = useRef(states);
  const loadSequence = useRef(0);
  const repositoryCacheTimestamp = useRef(restoredRepositoryStates.cachedAt);
  const shouldAutoSync = useRef(
    restoredRepositoryStates.cachedAt === 0 ||
      session.selectedRepositories.some(
        (repository) => !restoredRepositoryStates.states[repository],
      ),
  );
  const autoSyncStarted = useRef(false);
  const releaseIssues = useMemo(() => {
    const issues = [
      ...dashboard.services.flatMap((service) =>
        service.items.map((item) => item.issue),
      ),
      ...dashboard.unmatched.map((item) => item.issue),
    ];
    return [
      ...new Map<string, JiraIssue>(
        issues.map((issue) => [issue.key, issue]),
      ).values(),
    ];
  }, [dashboard]);

  useEffect(() => {
    sessionRef.current = session;
    const timeout = window.setTimeout(() => {
      window.localStorage.setItem(
        sessionKey(session.versionId),
        JSON.stringify(session),
      );
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [session]);

  useEffect(() => {
    statesRef.current = states;
  }, [states]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const cachedStates = Object.fromEntries(
        Object.entries(states).filter(
          (entry): entry is [string, ReleaseControlRoomState] =>
            entry[1] !== undefined,
        ),
      );
      if (
        Object.keys(cachedStates).length === 0 ||
        !repositoryCacheTimestamp.current
      ) {
        window.localStorage.removeItem(
          repositoryStateCacheKey(dashboard.version.id),
        );
        return;
      }
      window.localStorage.setItem(
        repositoryStateCacheKey(dashboard.version.id),
        JSON.stringify({
          cachedAt: repositoryCacheTimestamp.current,
          states: cachedStates,
        } satisfies CachedRepositoryStates),
      );
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [dashboard.version.id, states]);

  const selected = session.selectedRepositories;
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const log = useCallback(
    (level: OperationLog["level"], message: string, repository?: string) => {
      setSession((current) => ({
        ...current,
        logs: [
          ...current.logs,
          {
            id: crypto.randomUUID(),
            at: new Date().toISOString(),
            repository,
            level,
            message,
          },
        ].slice(-500),
      }));
    },
    [],
  );

  const setRepositoryError = useCallback(
    (repository: string, error?: string) => {
      setSession((current) => ({
        ...current,
        repositories: {
          ...current.repositories,
          [repository]: {
            ...current.repositories[repository],
            error,
          },
        },
      }));
    },
    [],
  );

  const openDevelopers = useCallback(
    async (repository: string) => {
      const includedDevelopers = developerLists[repository];
      if (includedDevelopers) {
        const cacheKey = releaseDevelopersCacheKey(dashboard.version.id);
        let cached: CachedReleaseDevelopers = {};
        try {
          cached = JSON.parse(
            window.localStorage.getItem(cacheKey) ?? "{}",
          ) as CachedReleaseDevelopers;
        } catch {
          cached = {};
        }
        cached[repository] = {
          cachedAt: Date.now(),
          developers: includedDevelopers,
        };
        window.localStorage.setItem(cacheKey, JSON.stringify(cached));
        setDeveloperModal({
          repository,
          developers: includedDevelopers,
          loading: false,
        });
        return;
      }
      setDeveloperModal({ repository, developers: [], loading: true });
      await Promise.resolve();
      const cacheKey = releaseDevelopersCacheKey(dashboard.version.id);
      let cachedDevelopers: ReleaseDeveloper[] | undefined;
      let cached: CachedReleaseDevelopers = {};
      try {
        cached = JSON.parse(
          window.localStorage.getItem(cacheKey) ?? "{}",
        ) as CachedReleaseDevelopers;
        const entry = cached[repository];
        if (
          entry &&
          Date.now() - entry.cachedAt < REPOSITORY_STATE_CACHE_MS &&
          Array.isArray(entry.developers)
        ) {
          cachedDevelopers = entry.developers;
        }
      } catch {
        cached = {};
      }
      const service = dashboard.services.find(
        (item) => item.repository === repository,
      );
      const developers =
        cachedDevelopers ??
        (service ? developersForReleaseService(service) : []);
      if (!cachedDevelopers) {
        cached[repository] = { cachedAt: Date.now(), developers };
        window.localStorage.setItem(cacheKey, JSON.stringify(cached));
      }
      setDeveloperLists((current) => ({
        ...current,
        [repository]: developers,
      }));
      setDeveloperModal({ repository, developers, loading: false });
    },
    [dashboard.services, dashboard.version.id, developerLists],
  );

  const applyRepositoryState = useCallback(
    (
      repository: string,
      repositoryState: ReleaseControlRoomState,
      sequence: number,
      options?: { quiet?: boolean },
    ) => {
      if (sequence !== loadSequence.current) return;
      repositoryCacheTimestamp.current = Date.now();
      setStates((current) => {
        const previous = current[repository];
        const merged: ReleaseControlRoomState = {
          ...repositoryState,
          deployedTags:
            repositoryState.deployedTags.length > 0
              ? repositoryState.deployedTags
              : (previous?.deployedTags ?? []),
          deploymentLookupFailed:
            repositoryState.deployedTags.length > 0 || !previous
              ? repositoryState.deploymentLookupFailed
              : (previous.deploymentLookupFailed ?? false),
        };
        return {
          ...current,
          [repository]: merged,
        };
      });
      const discoveredRelease = latestProductionReleaseOnDate(
        repositoryState.productionReleases.filter(
          (release) => release.buildStatus !== "canceled",
        ),
        sessionRef.current.releaseDate,
      );
      if (discoveredRelease) {
        setSession((current) => {
          const saved = current.repositories[repository]?.productionRelease;
          if (
            saved &&
            releaseCreatedOnDate(saved.createdAt, current.releaseDate)
          ) {
            return current;
          }
          return {
            ...current,
            repositories: {
              ...current.repositories,
              [repository]: {
                ...current.repositories[repository],
                productionRelease: {
                  id: discoveredRelease.id,
                  repository,
                  tag: discoveredRelease.tag,
                  sourceBranch: repositoryState.defaultBranch,
                  url: discoveredRelease.url,
                  createdAt: discoveredRelease.createdAt,
                },
                productionReleaseError: undefined,
              },
            },
          };
        });
      }
      if (!options?.quiet) {
        const discoveries = repositoryState.promotionSteps.map((step) => {
          if (step.state === "pr_open" && step.pullRequest) {
            return `${step.fromBranch} → ${step.toBranch}: PR #${step.pullRequest.number}`;
          }
          if (step.state === "up_to_date") {
            return `${step.fromBranch} → ${step.toBranch}: up to date`;
          }
          return `${step.fromBranch} → ${step.toBranch}: ${step.commitsAhead} commits waiting`;
        });
        log("info", `Promotion state: ${discoveries.join("; ")}.`, repository);
      }
      setRepositorySync((current) => ({
        ...current,
        [repository]: "synced",
      }));
    },
    [log],
  );

  const failRepositorySync = useCallback(
    (repository: string, reason: unknown, sequence: number) => {
      if (sequence !== loadSequence.current) return;
      const message =
        reason instanceof Error
          ? reason.message
          : "Could not refresh repository state.";
      setRepositoryError(repository, message);
      setRepositorySync((current) => ({
        ...current,
        [repository]: "failed",
      }));
      log("error", `Repository state check failed: ${message}`, repository);
    },
    [log, setRepositoryError],
  );

  const loadLegacyRepositoryState = useCallback(
    async (repository: string, force: boolean) => {
      if (force) await api.refreshRepository(repository);
      return api.releaseControlState(repository);
    },
    [],
  );

  const kickDeploymentStatuses = useCallback(
    async (
      repositories: string[],
      sequence: number,
      forceRefresh = true,
    ) => {
      if (repositories.length === 0) {
        return;
      }
      try {
        const response = await api.repositoryDeploymentStatuses(
          repositories,
          forceRefresh,
        );
        if (sequence !== loadSequence.current) return;
        setStates((current) => {
          const next = { ...current };
          for (const result of response.results) {
            const existing = next[result.repository];
            if (!existing) continue;
            next[result.repository] = {
              ...existing,
              deployedTags: result.deployedTags,
              deploymentLookupFailed: result.deploymentLookupFailed,
            };
          }
          return next;
        });
      } catch {
        // Stable polling loop will retry deployments.
      }
    },
    [],
  );

  const monitorSyncProgress = useCallback(
    async (progressId: string, sequence: number, isActive: () => boolean) => {
      const deadline = Date.now() + SYNC_TIMEOUT_MS;
      while (
        isActive() &&
        sequence === loadSequence.current &&
        Date.now() < deadline
      ) {
        try {
          const progress = await api.releaseControlSyncProgress(progressId);
          if (!isActive() || sequence !== loadSequence.current) return;
          setBatchSyncProgress(progress);
          for (const service of progress.services) {
            if (service.state) {
              applyRepositoryState(service.repository, service.state, sequence, {
                quiet: true,
              });
            }
          }
          if (progress.status === "completed") return;
        } catch {
          // The POST may not have initialized progress yet; retry briefly.
        }
        await new Promise<void>((resolve) =>
          window.setTimeout(resolve, SYNC_PROGRESS_POLL_MS),
        );
      }
    },
    [applyRepositoryState],
  );

  const syncRepository = useCallback(
    async (repository: string, force: boolean, sequence: number) => {
      setRepositoryError(repository);
      setRepositorySync((current) => ({
        ...current,
        [repository]: "syncing",
      }));
      log(
        "info",
        "Checking repository promotion and release state.",
        repository,
      );
      const progressId = crypto.randomUUID();
      const controller = new AbortController();
      const timeout = window.setTimeout(
        () => controller.abort(),
        SYNC_TIMEOUT_MS,
      );
      let progressActive = true;
      setBatchSyncProgress(undefined);
      const syncStartedAt = Date.now();
      void monitorSyncProgress(
        progressId,
        sequence,
        () => progressActive,
      );
      try {
        let repositoryState: ReleaseControlRoomState | undefined;
        let batchResponse;
        try {
          batchResponse = await api.releaseControlStates(
            [repository],
            force,
            progressId,
            controller.signal,
          );
        } catch {
          if (controller.signal.aborted) {
            throw new Error("Repository sync timed out after 90 seconds.");
          }
          log(
            "warning",
            "Batch sync transport failed; using legacy repository sync.",
            repository,
          );
          repositoryState = await withTimeout(
            loadLegacyRepositoryState(repository, force),
            LEGACY_SYNC_TIMEOUT_MS,
          );
        }
        if (batchResponse) {
          const result = batchResponse.results[0];
          if (!result?.state) {
            throw new Error(
              result?.error?.message ?? "Repository sync returned no state.",
            );
          }
          repositoryState = result.state;
        }
        if (!repositoryState)
          throw new Error("Repository sync returned no state.");
        applyRepositoryState(repository, repositoryState, sequence);
        progressActive = false;
        void kickDeploymentStatuses([repository], sequence);
        updateSyncMsPerServicePrior(Date.now() - syncStartedAt);
      } catch (reason) {
        progressActive = false;
        failRepositorySync(repository, reason, sequence);
      } finally {
        progressActive = false;
        window.clearTimeout(timeout);
        if (sequence === loadSequence.current) setBatchSyncProgress(undefined);
      }
    },
    [
      applyRepositoryState,
      failRepositorySync,
      kickDeploymentStatuses,
      loadLegacyRepositoryState,
      log,
      monitorSyncProgress,
      setRepositoryError,
    ],
  );

  const refreshStates = useCallback(
    async (silent = false, force = false) => {
      const repositories = sessionRef.current.selectedRepositories;
      if (repositories.length === 0) return;
      const sequence = ++loadSequence.current;
      if (!silent) setRefreshing(true);
      setRepositorySync((current) => ({
        ...current,
        ...Object.fromEntries(
          repositories.map((repository) => [repository, "syncing" as const]),
        ),
      }));
      for (const repository of repositories) {
        setRepositoryError(repository);
        log(
          "info",
          "Checking repository promotion and release state.",
          repository,
        );
      }
      const progressId = crypto.randomUUID();
      const controller = new AbortController();
      const timeout = window.setTimeout(
        () => controller.abort(),
        SYNC_TIMEOUT_MS,
      );
      let progressActive = true;
      setBatchSyncProgress(undefined);
      const syncStartedAt = Date.now();
      void monitorSyncProgress(
        progressId,
        sequence,
        () => progressActive,
      );
      try {
        const response = await api.releaseControlStates(
          repositories,
          force,
          progressId,
          controller.signal,
        );
        for (const result of response.results) {
          if (result.state) {
            applyRepositoryState(result.repository, result.state, sequence);
          } else {
            failRepositorySync(
              result.repository,
              new Error(result.error?.message ?? "Repository sync failed."),
              sequence,
            );
          }
        }
        progressActive = false;
        if (!silent) setRefreshing(false);
        void kickDeploymentStatuses(repositories, sequence);
        if (repositories.length > 0) {
          updateSyncMsPerServicePrior(
            (Date.now() - syncStartedAt) / repositories.length,
          );
        }
      } catch {
        progressActive = false;
        if (controller.signal.aborted) {
          const timeoutError = new Error(
            "Control-room sync timed out after 90 seconds.",
          );
          for (const repository of repositories) {
            failRepositorySync(repository, timeoutError, sequence);
          }
          log(
            "error",
            "Control-room synchronization timed out. Retry failed services.",
          );
        } else {
          log(
            "warning",
            "Batch sync transport failed; using bounded repository sync.",
          );
          await mapConcurrent(
            repositories,
            async (repository) => {
              setRepositorySync((current) => ({
                ...current,
                [repository]: "syncing",
              }));
              try {
                const state = await withTimeout(
                  loadLegacyRepositoryState(repository, force),
                  LEGACY_SYNC_TIMEOUT_MS,
                );
                applyRepositoryState(repository, state, sequence);
              } catch (reason) {
                failRepositorySync(repository, reason, sequence);
              }
            },
            REPOSITORY_SYNC_CONCURRENCY,
          );
          void kickDeploymentStatuses(repositories, sequence);
          if (repositories.length > 0) {
            updateSyncMsPerServicePrior(
              (Date.now() - syncStartedAt) / repositories.length,
            );
          }
        }
      } finally {
        progressActive = false;
        window.clearTimeout(timeout);
        if (sequence === loadSequence.current) {
          setBatchSyncProgress(undefined);
          if (!silent) setRefreshing(false);
        }
      }
    },
    [
      applyRepositoryState,
      failRepositorySync,
      kickDeploymentStatuses,
      loadLegacyRepositoryState,
      log,
      monitorSyncProgress,
      setRepositoryError,
    ],
  );

  useEffect(() => {
    if (autoSyncStarted.current || !shouldAutoSync.current) return;
    autoSyncStarted.current = true;
    void refreshStates(false);
  }, [refreshStates]);

  useEffect(() => {
    if (shouldAutoSync.current) return;
    const repositories = sessionRef.current.selectedRepositories;
    void kickDeploymentStatuses(repositories, loadSequence.current, false);
  }, [kickDeploymentStatuses]);

  const refreshOneRepository = useCallback(
    async (repository: string) => {
      await syncRepository(repository, true, loadSequence.current);
    },
    [syncRepository],
  );

  const trackProductionDeployment = useCallback(
    (repository: string, deployment: TriggeredProductionDeployment) => {
      setSession((current) => ({
        ...current,
        repositories: {
          ...current.repositories,
          [repository]: {
            ...current.repositories[repository],
            productionDeployment: {
              ...deployment,
              status:
                deployment.buildNumber || deployment.buildUrl
                  ? "running"
                  : "queued",
            },
          },
        },
      }));
    },
    [],
  );

  const handleProductionDeploymentUpdated = useCallback(
    (deployment: TriggeredProductionDeployment) => {
      if (!deployTarget) return;
      trackProductionDeployment(deployTarget.repository, deployment);
      void kickDeploymentStatuses(
        [deployTarget.repository],
        loadSequence.current,
        true,
      );
    },
    [deployTarget, kickDeploymentStatuses, trackProductionDeployment],
  );

  useEffect(() => {
    let active = true;
    let timeout: number | undefined;
    const schedule = () => {
      if (active) timeout = window.setTimeout(() => void poll(), 3_000);
    };
    const poll = async () => {
      const pending = sessionRef.current.selectedRepositories.flatMap(
        (repository) => {
          const deployment =
            sessionRef.current.repositories[repository]?.productionDeployment;
          return deployment &&
            (deployment.status === "queued" || deployment.status === "running")
            ? [{ repository, deployment }]
            : [];
        },
      );
      if (pending.length === 0) {
        schedule();
        return;
      }
      const completedRepositories: string[] = [];
      const updates = await Promise.all(
        pending.map(async ({ repository, deployment }) => {
          try {
            if (deployment.buildNumber) {
              const status = await api.productionJenkinsBuildStatus(
                deployment.buildNumber,
              );
              if (
                status.status === "succeeded" ||
                status.status === "failed" ||
                status.status === "canceled"
              ) {
                completedRepositories.push(repository);
              }
              return {
                repository,
                deployment: {
                  ...deployment,
                  ...status,
                },
              };
            }
            const status = await api.productionJenkinsQueueStatus(
              deployment.queueId,
            );
            return {
              repository,
              deployment: {
                ...deployment,
                buildNumber: status.buildNumber,
                buildUrl: status.buildUrl ?? deployment.buildUrl,
                status:
                  status.status === "started"
                    ? ("running" as const)
                    : status.status,
              },
            };
          } catch {
            return undefined;
          }
        }),
      );
      if (!active) return;
      setSession((current) => {
        const repositories = { ...current.repositories };
        for (const update of updates) {
          if (!update) continue;
          repositories[update.repository] = {
            ...repositories[update.repository],
            productionDeployment: update.deployment,
          };
        }
        return { ...current, repositories };
      });
      await Promise.all(
        completedRepositories.map((repository) =>
          refreshOneRepository(repository),
        ),
      );
      schedule();
    };
    void poll();
    return () => {
      active = false;
      if (timeout) window.clearTimeout(timeout);
    };
  }, [refreshOneRepository]);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const poll = async () => {
      if (!active || inFlight || document.hidden) return;
      const currentSession = sessionRef.current;
      if (currentSession.selectedRepositories.length === 0) return;
      let activeReleases: {
        repository: string;
        tag: string;
        createdAt: string;
      }[] = [];
      try {
        activeReleases = currentSession.selectedRepositories.flatMap(
          (repository) => {
            const release =
              currentSession.repositories[repository]?.productionRelease;
            if (
              !release ||
              !releaseCreatedOnDate(
                release.createdAt,
                currentSession.releaseDate,
              )
            ) {
              return [];
            }
            const status = statesRef.current[
              repository
            ]?.productionReleases.find(
              (item) => item.tag === release.tag,
            )?.buildStatus;
            return status &&
              ["succeeded", "failed", "canceled"].includes(status)
              ? []
              : [
                  {
                    repository,
                    tag: release.tag,
                    createdAt: release.createdAt,
                  },
                ];
          },
        );
      } catch {
        // Keep the last known build state and retry on the next interval tick.
        return;
      }

      const forceDeploymentRefresh =
        currentSession.selectedRepositories.some((repository) =>
          statesRef.current[repository]?.deployedTags.some(
            (tag) => tag.status === "running",
          ),
        ) ||
        currentSession.selectedRepositories.some((repository) => {
          const deployment =
            currentSession.repositories[repository]?.productionDeployment;
          return (
            deployment?.status === "queued" ||
            deployment?.status === "running"
          );
        });

      inFlight = true;
      try {
        const [results, deploymentResults] = await withTimeout(
          Promise.all([
            activeReleases.length
              ? api.releaseBuildStatuses(activeReleases, true)
              : Promise.resolve([]),
            currentSession.selectedRepositories.length
              ? api
                  .repositoryDeploymentStatuses(
                    currentSession.selectedRepositories,
                    forceDeploymentRefresh,
                  )
                  .then((response) =>
                    response.results.map((result) => ({
                      repository: result.repository,
                      result,
                    })),
                  )
                  .catch(() =>
                    Promise.all(
                      currentSession.selectedRepositories.map(
                        async (repository) => {
                          try {
                            return {
                              repository,
                              result: await api.repositoryDeploymentStatus(
                                repository,
                                forceDeploymentRefresh,
                              ),
                            };
                          } catch {
                            return undefined;
                          }
                        },
                      ),
                    ),
                  )
              : Promise.resolve([]),
          ]),
          BUILD_POLL_TIMEOUT_MS,
        );
        if (!active) return;
        setStates((current) => {
          const next = { ...current };
          for (const result of results) {
            const repositoryState = next[result.repository];
            const created =
              sessionRef.current.repositories[result.repository]
                ?.productionRelease;
            if (!repositoryState || !created) continue;
            const tracked = repositoryState.productionReleases.find(
              (release) => release.tag === result.tag,
            );
            const updated = {
              id: tracked?.id ?? created.id,
              tag: result.tag,
              url: tracked?.url ?? created.url,
              createdAt: result.createdAt,
              buildStatus: result.buildStatus,
              runs: result.runs,
            };
            next[result.repository] = {
              ...repositoryState,
              productionReleases: tracked
                ? repositoryState.productionReleases.map((release) =>
                    release.tag === result.tag ? updated : release,
                  )
                : [updated, ...repositoryState.productionReleases],
              fetchedAt: new Date().toISOString(),
            };
          }
          for (const deploymentResult of deploymentResults) {
            if (!deploymentResult) continue;
            const repositoryState = next[deploymentResult.repository];
            if (!repositoryState) continue;
            next[deploymentResult.repository] = {
              ...repositoryState,
              deployedTags: deploymentResult.result.deployedTags,
              deploymentLookupFailed:
                deploymentResult.result.deploymentLookupFailed,
              fetchedAt: new Date().toISOString(),
            };
          }
          return next;
        });
      } catch {
        // Keep the last known build state and retry on the next interval tick.
      } finally {
        inFlight = false;
      }
    };
    const visibilityChanged = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    void poll();
    const interval = window.setInterval(() => void poll(), POLL_INTERVAL);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, []);

  const everySelected = useCallback(
    (predicate: (repository: string) => boolean) =>
      selected.length > 0 && selected.every(predicate),
    [selected],
  );
  const rowSyncCompleted = selected.filter((repository) =>
    ["synced", "failed"].includes(repositorySync[repository]),
  ).length;
  const syncInProgress = selected.some((repository) =>
    ["queued", "syncing"].includes(repositorySync[repository]),
  );
  const syncCompleted =
    syncInProgress && batchSyncProgress
      ? Math.max(batchSyncProgress.completed, rowSyncCompleted)
      : rowSyncCompleted;
  const syncStartedAtRef = useRef<number | undefined>(undefined);
  const syncPriorMsRef = useRef(EXPECTED_SYNC_MS_PER_SERVICE);
  const [syncClock, setSyncClock] = useState(() => Date.now());
  useEffect(() => {
    if (!syncInProgress) {
      syncStartedAtRef.current = undefined;
      return;
    }
    if (syncStartedAtRef.current === undefined) {
      syncStartedAtRef.current = Date.now();
      syncPriorMsRef.current = readSyncMsPerServicePrior();
    }
    setSyncClock(Date.now());
    const timer = window.setInterval(() => setSyncClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [syncInProgress]);
  const syncElapsedMs = syncStartedAtRef.current
    ? Math.max(0, syncClock - syncStartedAtRef.current)
    : 0;
  const syncProgress = displaySyncPercent({
    syncInProgress,
    serverPercent: batchSyncProgress?.percent,
    completedCount: syncCompleted,
    elapsedMs: syncElapsedMs,
    serviceCount: selected.length,
    priorMsPerService: syncPriorMsRef.current,
  });
  const firstPrsReady = everySelected((repository) => {
    const step = routeStep(states[repository], firstHop);
    return step?.state === "pr_open" || step?.state === "up_to_date";
  });
  const firstMerged = everySelected(
    (repository) =>
      routeStep(states[repository], firstHop)?.state === "up_to_date",
  );
  const lastPrsReady = everySelected((repository) => {
    const step = routeStep(states[repository], lastHop);
    return step?.state === "pr_open" || step?.state === "up_to_date";
  });
  const lastMerged = everySelected(
    (repository) =>
      routeStep(states[repository], lastHop)?.state === "up_to_date",
  );
  const releasesCreated = everySelected((repository) => {
    const release = session.repositories[repository]?.productionRelease;
    if (
      !release ||
      !releaseCreatedOnDate(release.createdAt, session.releaseDate)
    ) {
      return false;
    }
    return (
      states[repository]?.productionReleases.find(
        (item) => item.tag === release.tag,
      )?.buildStatus !== "canceled"
    );
  });
  const buildsSucceeded = everySelected((repository) => {
    const release = session.repositories[repository]?.productionRelease;
    if (
      !release ||
      !releaseCreatedOnDate(release.createdAt, session.releaseDate)
    ) {
      return false;
    }
    return (
      states[repository]?.productionReleases.find(
        (item) => item.tag === release.tag,
      )?.buildStatus === "succeeded"
    );
  });
  const hasSavedProgress =
    session.logs.length > 0 ||
    Object.values(session.repositories).some((item) => item.productionRelease);
  const controlRoomProgress = useMemo(
    () =>
      computeControlRoomProgress({
        versionId: `${dashboard.version.id}:control-room`,
        selectedRepositories: selected,
        firstHop,
        lastHop,
        states,
        productionReleases: Object.fromEntries(
          selected.map((repository) => [
            repository,
            session.repositories[repository]?.productionRelease,
          ]),
        ),
        releaseDate: session.releaseDate,
      }),
    [
      dashboard.version.id,
      firstHop,
      lastHop,
      selected,
      session.releaseDate,
      session.repositories,
      states,
    ],
  );
  async function runAction(
    action: string,
    task: (repository: string) => Promise<void>,
    options: {
      sequential?: boolean;
      reconcile?: boolean;
      attemptLabel?: string;
    } = {},
  ) {
    if (busyAction || selected.length === 0) return;
    const repositories = dashboard.services
      .map((service) => service.repository)
      .filter((repository) => selectedSet.has(repository));
    setBusyAction(action);
    log("info", `${action} started for ${repositories.length} services.`);
    const execute = async (repository: string, index: number) => {
      setRepositoryError(repository);
      log(
        "info",
        `Attempting ${options.attemptLabel ?? action.toLowerCase()} (${index + 1}/${repositories.length}).`,
        repository,
      );
      try {
        await task(repository);
      } catch (reason) {
        const message =
          reason instanceof Error ? reason.message : `${action} failed.`;
        setRepositoryError(repository, message);
        log("error", message, repository);
      }
    };
    if (options.sequential) {
      for (const [index, repository] of repositories.entries()) {
        await execute(repository, index);
      }
    } else {
      await mapConcurrent(repositories, async (repository) => {
        await execute(repository, repositories.indexOf(repository));
      });
    }
    if (options.reconcile !== false) await refreshStates(true);
    log(
      "info",
      `${action} finished. Review flagged services before continuing.`,
    );
    setBusyAction("");
  }

  async function createPullRequests(route: PromotionRoute) {
    const title = `Create ${promotionRouteLabel(route)} PRs`;
    await runAction(
      title,
      async (repository) => {
        const step = routeStep(states[repository], route);
        const fallback = promotionBranches(
          route,
          states[repository]?.defaultBranch ?? "main",
        );
        const fromBranch = step?.fromBranch ?? fallback.fromBranch;
        const toBranch = step?.toBranch ?? fallback.toBranch;
        log(
          "info",
          `Checking for an open ${fromBranch} → ${toBranch} PR.`,
          repository,
        );
        if (step?.state === "up_to_date") {
          log(
            "success",
            `Discovery: ${step.fromBranch} and ${step.toBranch} are already aligned; no PR needed.`,
            repository,
          );
          return;
        }
        let pull = step?.pullRequest;
        if (pull) {
          log(
            "success",
            `Discovery: found existing open PR #${pull.number}: ${pull.title}.`,
            repository,
          );
        }
        if (!pull) {
          log(
            "info",
            `Discovery: no open ${fromBranch} → ${toBranch} PR in loaded state.`,
            repository,
          );
          log(
            "info",
            "Submitting GitHub check-and-create request.",
            repository,
          );
          setCellOperation({ repository, route, label: "Creating PR" });
          try {
            pull = await api.createPromotionPullRequest({ repository, route });
          } finally {
            setCellOperation((current) =>
              current?.repository === repository && current.route === route
                ? undefined
                : current,
            );
          }
          log(
            pull.resolution === "existing" ? "success" : "info",
            pull.resolution === "existing"
              ? `GitHub discovered existing PR #${pull.number}; no duplicate was created.`
              : `GitHub created PR #${pull.number}.`,
            repository,
          );
        }
        setStates((current) => {
          const repositoryState = current[repository];
          if (!repositoryState) return current;
          return {
            ...current,
            [repository]: {
              ...repositoryState,
              promotionSteps: repositoryState.promotionSteps.map((item) =>
                item.route === route
                  ? { ...item, state: "pr_open", pullRequest: pull }
                  : item,
              ),
              fetchedAt: new Date().toISOString(),
            },
          };
        });
        log(
          "success",
          `Result: PR #${pull.number} is ready for tracking: ${pull.title} (${pull.headBranch} → ${pull.baseBranch}).`,
          repository,
        );
      },
      {
        sequential: true,
        reconcile: false,
        attemptLabel: `${promotionRouteLabel(route)} PR creation`,
      },
    );
  }

  async function mergePullRequests(route: PromotionRoute) {
    const title = `Merge ${promotionRouteLabel(route)} PRs`;
    await runAction(
      title,
      async (repository) => {
        const step = routeStep(states[repository], route);
        log(
          "info",
          `Checking merge target for ${step?.fromBranch ?? route} → ${step?.toBranch ?? "target branch"}.`,
          repository,
        );
        if (step?.state === "up_to_date") {
          log(
            "success",
            "Discovery: branches are already aligned; no merge required.",
            repository,
          );
          return;
        }
        if (!step?.pullRequest) {
          log(
            "warning",
            "Discovery: no open promotion PR to merge.",
            repository,
          );
          throw new Error("No open promotion PR was found.");
        }
        log(
          "info",
          `Discovery: validating PR #${step.pullRequest.number}: ${step.pullRequest.title}.`,
          repository,
        );
        const blocked = mergeBlockReason(step.pullRequest);
        const force = canForceMergePull(step.pullRequest);
        if (blocked && !force) {
          log(
            "warning",
            `Validation blocked PR #${step.pullRequest.number}: ${blocked}.`,
            repository,
          );
          throw new Error(`${blocked} on PR #${step.pullRequest.number}.`);
        }
        if (force) {
          log(
            "warning",
            `Checks are blocking PR #${step.pullRequest.number}; force-merging with branch-protection bypass.`,
            repository,
          );
        } else {
          log(
            "success",
            `Validation passed for PR #${step.pullRequest.number}; submitting merge to ${step.toBranch}.`,
            repository,
          );
        }
        setCellOperation({
          repository,
          route,
          label: force
            ? `Force merging to ${step.toBranch}`
            : `Merging to ${step.toBranch}`,
        });
        let result;
        try {
          result = await api.mergePromotionPullRequest({
            repository,
            pullNumber: step.pullRequest.number,
            ...(force ? { bypassBranchProtection: true } : {}),
          });
        } finally {
          setCellOperation((current) =>
            current?.repository === repository && current.route === route
              ? undefined
              : current,
          );
        }
        if (!result.merged) {
          log(
            "error",
            `GitHub rejected merge for PR #${step.pullRequest.number}: ${result.message || "No reason returned."}`,
            repository,
          );
          throw new Error(result.message || "GitHub did not merge the PR.");
        }
        setStates((current) => {
          const repositoryState = current[repository];
          if (!repositoryState) return current;
          return {
            ...current,
            [repository]: {
              ...repositoryState,
              promotionSteps: repositoryState.promotionSteps.map((item) => {
                if (item.route === route) {
                  return {
                    ...item,
                    commitsAhead: 0,
                    filesChanged: 0,
                    state: "up_to_date",
                    pullRequest: undefined,
                  };
                }
                if (
                  route === firstHop &&
                  firstHop !== lastHop &&
                  item.route === lastHop
                ) {
                  return { ...item, state: "needs_pr" };
                }
                return item;
              }),
              productionReady:
                route === lastHop
                  ? true
                  : repositoryState.productionReady,
              fetchedAt: new Date().toISOString(),
            },
          };
        });
        log(
          "success",
          `Result: merged PR #${step.pullRequest.number} into ${step.toBranch}${result.sha ? ` at ${result.sha.slice(0, 8)}` : ""}.`,
          repository,
        );
      },
      {
        sequential: true,
        reconcile: false,
        attemptLabel: `${promotionRouteLabel(route)} PR merge`,
      },
    );
  }

  async function createProductionRelease(repository: string) {
    const saved =
      sessionRef.current.repositories[repository]?.productionRelease;
    const savedBuildStatus = saved
      ? states[repository]?.productionReleases.find(
          (release) => release.tag === saved.tag,
        )?.buildStatus
      : undefined;
    const needsNewTag = defaultBranchNeedsNewProductionTag(states[repository]);
    if (
      saved &&
      releaseCreatedOnDate(saved.createdAt, sessionRef.current.releaseDate) &&
      savedBuildStatus !== "canceled" &&
      !needsNewTag
    ) {
      log(
        "success",
        `${saved.tag} was already created for this run.`,
        repository,
      );
      return;
    }
    if (needsNewTag && states[repository]?.latestProductionTagDelta) {
      const delta = states[repository]!.latestProductionTagDelta!;
      log(
        "info",
        `${states[repository]!.defaultBranch} is ${delta.commitsAhead} ${delta.commitsAhead === 1 ? "commit" : "commits"} ahead of ${delta.tag}; creating a new production tag.`,
        repository,
      );
    }
    setSession((current) => ({
      ...current,
      repositories: {
        ...current.repositories,
        [repository]: {
          ...current.repositories[repository],
          productionReleaseError: undefined,
        },
      },
    }));
    try {
      const release = await api.createProductionRelease({
        repository,
        mode: 'release-day',
        date: sessionRef.current.releaseDate,
        // ponytail: omit operationId when default moved past latest tag so
        // GitHub creates a fresh tag instead of returning the idempotent one.
        ...(needsNewTag ? {} : { operationId: sessionRef.current.operationId }),
      });
      setSession((current) => ({
        ...current,
        repositories: {
          ...current.repositories,
          [repository]: {
            ...current.repositories[repository],
            productionRelease: release,
            productionReleaseError: undefined,
            error: undefined,
          },
        },
      }));
      setStates((current) => {
        const repositoryState = current[repository];
        if (!repositoryState) return current;
        const tracked = {
          id: release.id,
          tag: release.tag,
          url: release.url,
          createdAt: release.createdAt,
          buildStatus: "starting" as const,
          runs: [],
        };
        return {
          ...current,
          [repository]: {
            ...repositoryState,
            productionReleases: [
              tracked,
              ...repositoryState.productionReleases.filter(
                (item) => item.tag !== release.tag,
              ),
            ],
            latestProductionTagDelta: undefined,
            fetchedAt: new Date().toISOString(),
          },
        };
      });
      try {
        const [build] = await api.releaseBuildStatuses(
          [
            {
              repository,
              tag: release.tag,
              createdAt: release.createdAt,
            },
          ],
          true,
        );
        if (build) {
          setStates((current) => {
            const repositoryState = current[repository];
            if (!repositoryState) return current;
            return {
              ...current,
              [repository]: {
                ...repositoryState,
                productionReleases: repositoryState.productionReleases.map(
                  (item) =>
                    item.tag === build.tag
                      ? {
                          ...item,
                          buildStatus: build.buildStatus,
                          runs: build.runs,
                        }
                      : item,
                ),
              },
            };
          });
        }
      } catch {
        // The stable polling loop will retry active builds.
      }
      log(
        "success",
        `Created ${release.tag} from ${release.sourceBranch}.`,
        repository,
      );
      window.dispatchEvent(
        new CustomEvent("production-release-created", {
          detail: { repository, release },
        }),
      );
    } catch (reason) {
      const message =
        reason instanceof Error
          ? reason.message
          : "Could not create the production tag.";
      setSession((current) => ({
        ...current,
        repositories: {
          ...current.repositories,
          [repository]: {
            ...current.repositories[repository],
            productionReleaseError: message,
          },
        },
      }));
      throw reason;
    }
  }

  async function createProductionReleases() {
    await runAction("Create production releases", createProductionRelease, {
      reconcile: false,
    });
  }

  async function checkLatestBuild(repository: string) {
    if (checkingBuildRepository) return;
    setCheckingBuildRepository(repository);
    log("info", "Finding the latest eligible production tag.", repository);
    try {
      let repositoryState: ReleaseControlRoomState | undefined;
      let batchResponse;
      try {
        batchResponse = await api.releaseControlStates([repository], true);
      } catch {
        await api.refreshRepository(repository);
        repositoryState = await api.releaseControlState(repository);
      }
      if (batchResponse) {
        const result = batchResponse.results[0];
        if (!result?.state) {
          throw new Error(
            result?.error?.message ?? "Repository sync returned no state.",
          );
        }
        repositoryState = result.state;
      }
      if (!repositoryState)
        throw new Error("Repository sync returned no state.");
      const latest = latestProductionReleaseOnDate(
        repositoryState.productionReleases,
        sessionRef.current.releaseDate,
      );
      if (!latest) {
        log(
          "warning",
          `No production tag was created on ${sessionRef.current.releaseDate}.`,
          repository,
        );
        return;
      }
      const release: CreatedProductionRelease = {
        id: latest.id,
        repository,
        tag: latest.tag,
        sourceBranch: repositoryState.defaultBranch,
        url: latest.url,
        createdAt: latest.createdAt,
      };
      repositoryCacheTimestamp.current = Date.now();
      setStates((current) => ({
        ...current,
        [repository]: repositoryState,
      }));
      setSession((current) => ({
        ...current,
        repositories: {
          ...current.repositories,
          [repository]: {
            ...current.repositories[repository],
            productionRelease: release,
            productionReleaseError: undefined,
          },
        },
      }));
      log("info", `Checking the latest build for ${release.tag}.`, repository);
      const [result] = await api.releaseBuildStatuses(
        [
          {
            repository,
            tag: release.tag,
            createdAt: release.createdAt,
          },
        ],
        true,
      );
      if (!result) return;
      setStates((current) => {
        const repositoryState = current[repository];
        if (!repositoryState) return current;
        const tracked = repositoryState.productionReleases.find(
          (item) => item.tag === result.tag,
        );
        const updated = {
          id: tracked?.id ?? release.id,
          tag: result.tag,
          url: tracked?.url ?? release.url,
          createdAt: result.createdAt,
          buildStatus: result.buildStatus,
          runs: result.runs,
        };
        return {
          ...current,
          [repository]: {
            ...repositoryState,
            productionReleases: tracked
              ? repositoryState.productionReleases.map((item) =>
                  item.tag === result.tag ? updated : item,
                )
              : [updated, ...repositoryState.productionReleases],
            fetchedAt: new Date().toISOString(),
          },
        };
      });
      log(
        "success",
        `${release.tag}: ${buildLabels[result.buildStatus]}.`,
        repository,
      );
    } catch (reason) {
      log(
        "error",
        reason instanceof Error
          ? reason.message
          : "Could not refresh the latest production build.",
        repository,
      );
    } finally {
      setCheckingBuildRepository("");
    }
  }

  async function createSingleProductionRelease(repository: string) {
    if (busyAction || refreshing || activeProductionRelease) return;
    const retrying = Boolean(
      sessionRef.current.repositories[repository]?.productionReleaseError,
    );
    setActiveProductionRelease(repository);
    setRepositoryError(repository);
    log(
      "info",
      retrying
        ? "Retrying production tag creation."
        : "Creating production tag.",
      repository,
    );
    try {
      await createProductionRelease(repository);
    } catch (reason) {
      const message =
        reason instanceof Error
          ? reason.message
          : "Could not create the production tag.";
      setRepositoryError(repository, message);
      log("error", message, repository);
    } finally {
      setActiveProductionRelease("");
    }
  }

  function toggleRepository(repository: string) {
    if (busyAction) return;
    const included =
      sessionRef.current.selectedRepositories.includes(repository);
    setSession((current) => {
      return {
        ...current,
        selectedRepositories: included
          ? current.selectedRepositories.filter((item) => item !== repository)
          : [...current.selectedRepositories, repository],
      };
    });
    if (
      !included &&
      !statesRef.current[repository] &&
      !["queued", "syncing"].includes(repositorySync[repository])
    ) {
      void syncRepository(repository, false, loadSequence.current);
    }
  }

  useEffect(() => {
    if (!copyNotesMenuOpen) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (
        copyNotesMenuRef.current &&
        !copyNotesMenuRef.current.contains(event.target as Node)
      ) {
        setCopyNotesMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [copyNotesMenuOpen]);

  async function copyReleaseNotes(format: ReleaseNotesFormat) {
    if (copyNotesStatus === "copying") return;
    setCopyNotesMenuOpen(false);
    setCopyNotesStatus("copying");
    const releasesByRepository: Record<string, TrackedProductionRelease[]> = {};
    const failures: string[] = [];
    const selectedServices = dashboard.services.filter((service) =>
      selectedSet.has(service.repository),
    );
    try {
      await mapConcurrent(
        selectedServices,
        async (service) => {
          const cached =
            statesRef.current[service.repository]?.productionReleases;
          if (cached) {
            releasesByRepository[service.repository] = cached;
            return;
          }
          try {
            const history = await api.releaseHistory(service.repository);
            releasesByRepository[service.repository] =
              history.productionReleases;
          } catch {
            failures.push(service.repository);
          }
        },
        REPOSITORY_SYNC_CONCURRENCY,
      );
      if (failures.length > 0) {
        throw new Error(
          `Could not load release notes for: ${failures.join(", ")}.`,
        );
      }
      await copyReleaseNotesContent(
        releaseNotesForDashboard(
          { ...dashboard, services: selectedServices },
          releasesByRepository,
          sessionRef.current.releaseDate,
        ),
        format,
      );
      setCopyNotesStatus("copied");
      log(
        "success",
        `Copied ${format} release notes for ${selectedServices.length} repositories.`,
      );
    } catch (reason) {
      setCopyNotesStatus("error");
      log(
        "error",
        reason instanceof Error
          ? reason.message
          : "Could not copy release notes.",
      );
    }
  }

  const remainingJiraIssues = releaseIssues.filter(
    (issue) => !releasedJiraIssueKeys.has(issue.key),
  );

  function openJiraReleaseDialog() {
    if (jiraReleaseStatus === "running") return;
    setSelectedJiraIssueKeys(remainingJiraIssues.map((issue) => issue.key));
    setJiraReleaseDialogOpen(true);
  }

  function closeJiraReleaseDialog() {
    jiraReleaseRequestId.current += 1;
    setJiraReleaseDialogOpen(false);
    if (jiraReleaseStatus === "running") {
      setJiraReleaseStatus("idle");
    }
  }

  async function markJiraTicketsReleased() {
    if (jiraReleaseStatus === "running") return;
    if (selectedJiraIssueKeys.length === 0) return;
    const requestId = ++jiraReleaseRequestId.current;
    setJiraReleaseStatus("running");
    setJiraReleaseMessage("");
    log("info", "Marking release tickets as Released in Jira.");
    try {
      const result = await withTimeout(
        api.markReleaseIssuesReleased(
          dashboard.version.id,
          selectedJiraIssueKeys,
        ),
        JIRA_RELEASE_TIMEOUT_MS,
      );
      if (requestId !== jiraReleaseRequestId.current) return;
      const marked = new Set(releasedJiraIssueKeys);
      for (const key of result.transitioned) marked.add(key);
      for (const key of result.alreadyReleased) marked.add(key);
      setReleasedJiraIssueKeys(marked);
      const remaining = releaseIssues.filter((issue) => !marked.has(issue.key));
      setJiraReleaseDialogOpen(false);
      if (result.failed.length > 0) {
        const message = `${result.transitioned.length} transitioned, ${result.alreadyReleased.length} already released, ${result.failed.length} failed.`;
        setJiraReleaseStatus("partial");
        setJiraReleaseMessage(message);
        log("warning", message);
      } else if (remaining.length > 0) {
        const message = `${result.transitioned.length} marked as released. ${remaining.length} ticket${remaining.length === 1 ? "" : "s"} remaining.`;
        setJiraReleaseStatus("idle");
        setJiraReleaseMessage(message);
        log("success", `Jira release statuses updated. ${message}`);
      } else {
        const message = `${result.transitioned.length} transitioned; ${result.alreadyReleased.length} were already released.`;
        setJiraReleaseStatus("success");
        setJiraReleaseMessage(message);
        log("success", `Jira release statuses updated. ${message}`);
      }
    } catch (reason) {
      if (requestId !== jiraReleaseRequestId.current) return;
      const message =
        reason instanceof Error && reason.message === "Timed out"
          ? "Jira update timed out. You can select remaining tickets and try again."
          : reason instanceof Error
            ? reason.message
            : "Could not update Jira ticket statuses.";
      setJiraReleaseStatus("error");
      setJiraReleaseMessage(message);
      log("error", message);
    }
  }

  function resetSession() {
    if (
      hasSavedProgress &&
      !window.confirm("Start a new run and clear the saved operation log?")
    ) {
      return;
    }
    const next = newSession(dashboard);
    setSession(next);
    sessionRef.current = next;
    loadSequence.current += 1;
    repositoryCacheTimestamp.current = 0;
    setStates({});
    setRepositorySync({});
    window.localStorage.removeItem(
      repositoryStateCacheKey(dashboard.version.id),
    );
  }

  return (
    <>
      <section className="release-day-page" aria-labelledby="release-day-title">
        {syncInProgress && (
          <div
            className="release-day-sync-progress"
            role="progressbar"
            aria-label="Synchronizing release control room"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={syncProgress}
          >
            <span style={{ width: `${syncProgress}%` }} />
          </div>
        )}
        <header className="release-day-header">
          <div className="release-day-title">
            <h2 id="release-day-title">{dashboard.version.name}</h2>
            <span>
              {selected.length}/{dashboard.services.length} selected
              {refreshing && ` · Syncing ${syncCompleted}/${selected.length}`}
            </span>
          </div>
          <div className="release-day-toolbar">
            <label>
              <span>Production date</span>
              <input
                type="date"
                value={session.releaseDate}
                disabled={releasesCreated || refreshing || Boolean(busyAction)}
                onChange={(event) =>
                  setSession((current) => ({
                    ...current,
                    releaseDate: event.target.value,
                  }))
                }
              />
            </label>
            <button
              className="text-button"
              type="button"
              disabled={refreshing || Boolean(busyAction)}
              onClick={resetSession}
            >
              New run
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void refreshStates(false, true)}
              disabled={refreshing || Boolean(busyAction)}
            >
              {refreshing
                ? `Syncing ${syncCompleted}/${selected.length}`
                : "↻ Refresh status"}
            </button>
            <div className="copy-notes-menu" ref={copyNotesMenuRef}>
              <button
                className="secondary-button"
                type="button"
                aria-haspopup="menu"
                aria-expanded={copyNotesMenuOpen}
                onClick={() => setCopyNotesMenuOpen((current) => !current)}
                disabled={
                  refreshing ||
                  Boolean(busyAction) ||
                  copyNotesStatus === "copying"
                }
              >
                {copyNotesStatus === "copying"
                  ? "Copying…"
                  : copyNotesStatus === "copied"
                    ? "✓ Copied!"
                    : copyNotesStatus === "error"
                      ? "Retry Copy Release Notes"
                      : "Copy Release Notes"}
                <svg
                  className={`dropdown-chevron${copyNotesMenuOpen ? " open" : ""}`}
                  viewBox="0 0 16 16"
                  width="14"
                  height="14"
                  aria-hidden="true"
                  fill="none"
                >
                  <path
                    d="M3.5 6 8 10.5 12.5 6"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {copyNotesMenuOpen && (
                <div className="copy-notes-menu-panel" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void copyReleaseNotes("slack")}
                  >
                    Slack
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void copyReleaseNotes("plain")}
                  >
                    Plain text
                  </button>
                </div>
              )}
            </div>
            <button
              className="secondary-button"
              type="button"
              disabled={
                remainingJiraIssues.length === 0 ||
                jiraReleaseStatus === "running"
              }
              onClick={openJiraReleaseDialog}
            >
              {jiraReleaseStatus === "running"
                ? "Updating Jira…"
                : remainingJiraIssues.length === 0 &&
                    releasedJiraIssueKeys.size > 0
                  ? "✓ Jira tickets released"
                  : jiraReleaseStatus === "partial"
                    ? "Retry Jira release"
                    : releasedJiraIssueKeys.size > 0
                      ? "Mark remaining as released"
                      : "Mark tickets as released"}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={onClose}
            >
              ← Dashboard
            </button>
          </div>
        </header>

        {jiraReleaseMessage && (
          <div
            className={`alert ${
              jiraReleaseStatus === "error"
                ? "error"
                : jiraReleaseStatus === "partial"
                  ? "warning"
                  : "success"
            }`}
            role="status"
          >
            {jiraReleaseMessage}
          </div>
        )}

        {!productionEnabled && (
          <div className="alert warning">
            Production Jenkins is not connected. Promotion and release creation
            are available, but deploy buttons will remain disabled.
          </div>
        )}

        <div className="release-day-progress">
          <ReleaseProgressBar progress={controlRoomProgress} />
        </div>

        <div className="release-day-steps">
          <article className="release-day-step">
            <span>1</span>
            <div>
              <strong>Create {promotionRouteLabel(firstHop)} PRs</strong>
            </div>
            <button
              className="primary-button"
              type="button"
              disabled={Boolean(busyAction) || selected.length === 0}
              onClick={() => void createPullRequests(firstHop)}
            >
              {busyAction === `Create ${promotionRouteLabel(firstHop)} PRs`
                ? "Creating…"
                : firstPrsReady
                  ? "Recheck / create"
                  : "Create PRs"}
            </button>
          </article>
          <article
            className={`release-day-step ${!firstPrsReady ? "locked" : ""}`}
          >
            <span>2</span>
            <div>
              <strong>Merge {promotionRouteLabel(firstHop)} PRs</strong>
            </div>
            <button
              className="primary-button"
              type="button"
              disabled={!firstPrsReady || Boolean(busyAction)}
              onClick={() => void mergePullRequests(firstHop)}
            >
              {busyAction === `Merge ${promotionRouteLabel(firstHop)} PRs`
                ? "Merging…"
                : firstMerged
                  ? "All merged"
                  : "Merge ready PRs"}
            </button>
          </article>
          {useReleaseBranch && (
            <>
              <article
                className={`release-day-step ${!firstMerged ? "locked" : ""}`}
              >
                <span>3</span>
                <div>
                  <strong>Create {promotionRouteLabel(lastHop)} PRs</strong>
                </div>
                <button
                  className="primary-button"
                  type="button"
                  disabled={!firstMerged || Boolean(busyAction)}
                  onClick={() => void createPullRequests(lastHop)}
                >
                  {busyAction === `Create ${promotionRouteLabel(lastHop)} PRs`
                    ? "Creating…"
                    : lastPrsReady
                      ? "Recheck / create"
                      : "Create PRs"}
                </button>
              </article>
              <article
                className={`release-day-step ${!lastPrsReady ? "locked" : ""}`}
              >
                <span>4</span>
                <div>
                  <strong>Merge {promotionRouteLabel(lastHop)} PRs</strong>
                </div>
                <button
                  className="primary-button"
                  type="button"
                  disabled={
                    !lastPrsReady || Boolean(busyAction)
                  }
                  onClick={() => void mergePullRequests(lastHop)}
                >
                  {busyAction === `Merge ${promotionRouteLabel(lastHop)} PRs`
                    ? "Merging…"
                    : lastMerged
                      ? "All merged"
                      : "Merge ready PRs"}
                </button>
              </article>
            </>
          )}
          <article
            className={`release-day-step ${!lastMerged ? "locked" : ""}`}
          >
            <span>{useReleaseBranch ? 5 : 3}</span>
            <div>
              <strong>Create production releases</strong>
            </div>
            <button
              className="primary-button"
              type="button"
              disabled={!lastMerged || refreshing || Boolean(busyAction)}
              onClick={() => void createProductionReleases()}
            >
              {busyAction === "Create production releases"
                ? "Creating…"
                : releasesCreated
                  ? "Reconcile releases"
                  : "Create releases"}
            </button>
          </article>
          <article
            className={`release-day-step ${!releasesCreated ? "locked" : ""}`}
          >
            <span>{useReleaseBranch ? 6 : 4}</span>
            <div>
              <strong>Monitor builds and deploy</strong>
            </div>
            <span
              className={`batch-status ${buildsSucceeded ? "success" : "running"}`}
            >
              {buildsSucceeded ? "Ready" : "Live"}
            </span>
          </article>
        </div>

        <div
          className={`release-day-workspace${operationLogExpanded ? "" : " log-collapsed"}`}
        >
          <div className="release-day-table-wrap">
            <table className="release-day-table">
              <thead>
                <tr>
                  <th scope="col">
                    <input
                      type="checkbox"
                      aria-label="Select all services"
                      checked={selected.length === dashboard.services.length}
                      ref={(input) => {
                        if (input) {
                          input.indeterminate =
                            selected.length > 0 &&
                            selected.length < dashboard.services.length;
                        }
                      }}
                      disabled={refreshing || Boolean(busyAction)}
                      onChange={(event) =>
                        setSession((current) => ({
                          ...current,
                          selectedRepositories: event.target.checked
                            ? dashboard.services.map(
                                (service) => service.repository,
                              )
                            : [],
                        }))
                      }
                    />
                  </th>
                  <th scope="col">Service</th>
                  <th scope="col">Developers</th>
                  <th scope="col">{promotionRouteLabel(firstHop)}</th>
                  {useReleaseBranch && (
                    <th scope="col">{promotionRouteLabel(lastHop)}</th>
                  )}
                  <th scope="col">Production build</th>
                  <th scope="col">Deploy</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.services.map((service) => {
                  const repository = service.repository;
                  const progress = session.repositories[repository];
                  const deploymentProgress = progress?.productionDeployment;
                  const syncStatus = repositorySync[repository];
                  const serviceSyncProgress = batchSyncProgress?.services.find(
                    (item) => item.repository === repository,
                  );
                  const rowSyncing =
                    syncStatus === "queued" || syncStatus === "syncing";
                  const repositoryState = states[repository];
                  const release = progress?.productionRelease;
                  const releaseCreationError = progress?.productionReleaseError;
                  const trackedRelease = release
                    ? states[repository]?.productionReleases.find(
                        (item) => item.tag === release.tag,
                      )
                    : undefined;
                  const existingRelease =
                    trackedRelease?.buildStatus === "canceled" ||
                    !release ||
                    !releaseCreatedOnDate(
                      release.createdAt,
                      session.releaseDate,
                    )
                      ? undefined
                      : release;
                  const tagDelta = repositoryState?.latestProductionTagDelta;
                  const needsNewTag =
                    defaultBranchNeedsNewProductionTag(repositoryState);
                  const tagDeltaPending = productionTagDeltaPending(
                    repositoryState,
                  );
                  const productionDeployments =
                    repositoryState?.deployedTags.filter(
                      (deployment) => deployment.environment === "production",
                    ) ?? [];
                  const productionDeploymentRunning =
                    productionDeployments.some(
                      (deployment) => deployment.status === "running",
                    ) || deploymentProgress?.status === "running";
                  const latestTagAlreadyDeployed =
                    Boolean(existingRelease) &&
                    Boolean(repositoryState?.jenkinsServices.length) &&
                    repositoryState?.jenkinsServices.every((jenkinsService) =>
                      productionDeployments.some(
                        (deployment) =>
                          deployment.service === jenkinsService &&
                          deployment.tag === existingRelease?.tag &&
                          (deployment.status === undefined ||
                            deployment.status === "succeeded"),
                      ),
                    );
                  const first = phaseState(
                    states[repository],
                    firstHop,
                    firstPrsReady ? "merge" : "create",
                    syncStatus,
                  );
                  const last = phaseState(
                    states[repository],
                    lastHop,
                    lastPrsReady ? "merge" : "create",
                    syncStatus,
                  );
                  const firstOperation =
                    cellOperation?.repository === repository &&
                    cellOperation.route === firstHop
                      ? cellOperation
                      : undefined;
                  const lastOperation =
                    cellOperation?.repository === repository &&
                    cellOperation.route === lastHop
                      ? cellOperation
                      : undefined;
                  return (
                    <tr
                      key={repository}
                      aria-busy={rowSyncing}
                      inert={rowSyncing ? true : undefined}
                      className={[
                        !selectedSet.has(repository) ? "unselected" : "",
                        rowSyncing ? "sync-in-progress" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedSet.has(repository)}
                          disabled={refreshing || Boolean(busyAction)}
                          onChange={() => toggleRepository(repository)}
                          aria-label={`Include ${repository}`}
                        />
                      </td>
                      <td>
                        <strong>{repository.split("/").at(-1)}</strong>
                        <small>{repository}</small>
                        <button
                          className="release-day-row-sync"
                          type="button"
                          onClick={() => void refreshOneRepository(repository)}
                          disabled={
                            refreshing ||
                            Boolean(busyAction) ||
                            syncStatus === "syncing"
                          }
                          aria-label={`Sync ${repository.split("/").at(-1)}`}
                        >
                          {syncStatus === "syncing" ? (
                            <>
                              <span className="spinner" /> Syncing…
                            </>
                          ) : (
                            "↻ Sync"
                          )}
                        </button>
                        {syncStatus && (
                          <span
                            className={`release-day-repository-sync ${syncStatus}`}
                          >
                            {syncStatus === "syncing"
                              ? (serviceSyncProgress?.message ?? "Syncing")
                              : syncStatus === "queued"
                                ? "Queued"
                                : syncStatus === "synced"
                                  ? "Synced"
                                  : "Sync failed"}
                          </span>
                        )}
                        {progress?.error && (
                          <span className="release-day-error">
                            {progress.error}
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="release-day-developers-cell">
                          {developerLists[repository] && (
                            <div
                              className="release-day-developer-avatars"
                              aria-label={`Developers for ${repository}`}
                            >
                              {developerLists[repository]
                                .slice(0, 5)
                                .map((developer) => (
                                  <img
                                    src={developer.avatarUrl}
                                    alt={developer.login}
                                    title={developer.login}
                                    key={developer.login}
                                  />
                                ))}
                              {developerLists[repository].length > 5 && (
                                <span>
                                  +{developerLists[repository].length - 5}
                                </span>
                              )}
                              {developerLists[repository].length === 0 && (
                                <small>No developers found</small>
                              )}
                            </div>
                          )}
                          <button
                            className="release-day-view-developers"
                            type="button"
                            onClick={() => void openDevelopers(repository)}
                          >
                            View Developers
                          </button>
                        </div>
                      </td>
                      <td>
                        {firstOperation ? (
                          <span className="release-day-cell-operation">
                            <span className="spinner" />
                            {firstOperation.label}
                          </span>
                        ) : (
                          <>
                            <span className={`batch-status ${first.tone}`}>
                              {first.label}
                            </span>
                            {routeStep(states[repository], firstHop)
                              ?.pullRequest && (
                              <a
                                href={
                                  routeStep(states[repository], firstHop)
                                    ?.pullRequest?.url
                                }
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open PR ↗
                              </a>
                            )}
                          </>
                        )}
                      </td>
                      {useReleaseBranch && (
                      <td>
                        {lastOperation ? (
                          <span className="release-day-cell-operation">
                            <span className="spinner" />
                            {lastOperation.label}
                          </span>
                        ) : (
                          <>
                            <span className={`batch-status ${last.tone}`}>
                              {last.label}
                            </span>
                            {routeStep(states[repository], lastHop)
                              ?.pullRequest && (
                              <a
                                href={
                                  routeStep(states[repository], lastHop)
                                    ?.pullRequest?.url
                                }
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open PR ↗
                              </a>
                            )}
                          </>
                        )}
                      </td>
                      )}
                      <td>
                        {existingRelease ? (
                          <div className="release-day-production-build">
                            <a
                              href={existingRelease.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {existingRelease.tag} ↗
                            </a>
                            <span
                              className={`batch-status ${
                                trackedRelease?.buildStatus ?? "pending"
                              }`}
                            >
                              {trackedRelease
                                ? buildLabels[trackedRelease.buildStatus]
                                : "Waiting for workflow"}
                            </span>
                            <button
                              className="release-day-check-build"
                              type="button"
                              disabled={
                                refreshing ||
                                Boolean(busyAction) ||
                                Boolean(checkingBuildRepository)
                              }
                              title={`Find the newest production tag created on ${session.releaseDate} and refresh its workflow status`}
                              onClick={() => void checkLatestBuild(repository)}
                            >
                              {checkingBuildRepository === repository ? (
                                <>
                                  <span className="spinner" /> Checking…
                                </>
                              ) : (
                                "↻ Check latest build"
                              )}
                            </button>
                            {tagDeltaPending && (
                              <div className="release-day-tag-ahead">
                                <small>Checking for new production tag…</small>
                              </div>
                            )}
                            {needsNewTag && tagDelta && (
                              <div className="release-day-tag-ahead">
                                <small>
                                  {repositoryState?.defaultBranch} is{" "}
                                  {tagDelta.commitsAhead}{" "}
                                  {tagDelta.commitsAhead === 1
                                    ? "commit"
                                    : "commits"}{" "}
                                  ahead of {tagDelta.tag}
                                </small>
                                <button
                                  className="release-day-tag-button"
                                  type="button"
                                  disabled={
                                    refreshing ||
                                    Boolean(busyAction) ||
                                    Boolean(activeProductionRelease)
                                  }
                                  onClick={() =>
                                    void createSingleProductionRelease(
                                      repository,
                                    )
                                  }
                                >
                                  {activeProductionRelease === repository ? (
                                    <>
                                      <span className="spinner" /> Creating…
                                    </>
                                  ) : (
                                    "+ Create tag"
                                  )}
                                </button>
                              </div>
                            )}
                          </div>
                        ) : releaseCreationError ? (
                          <div className="release-day-release-failure">
                            <span className="batch-status error">
                              Tag creation failed
                            </span>
                            <small>{releaseCreationError}</small>
                            <button
                              className="release-day-tag-button retry"
                              type="button"
                              disabled={
                                refreshing ||
                                Boolean(busyAction) ||
                                Boolean(activeProductionRelease)
                              }
                              onClick={() =>
                                void createSingleProductionRelease(repository)
                              }
                            >
                              {activeProductionRelease === repository ? (
                                <>
                                  <span className="spinner" /> Retrying…
                                </>
                              ) : (
                                "↻ Retry tag creation"
                              )}
                            </button>
                          </div>
                        ) : (
                          <div className="release-day-release-empty">
                            <span className="batch-status pending">
                              Not created
                            </span>
                            {tagDelta && needsNewTag && (
                              <small>
                                {repositoryState?.defaultBranch} is{" "}
                                {tagDelta.commitsAhead}{" "}
                                {tagDelta.commitsAhead === 1
                                  ? "commit"
                                  : "commits"}{" "}
                                ahead of {tagDelta.tag}
                              </small>
                            )}
                            <button
                              className="release-day-tag-button"
                              type="button"
                              disabled={
                                refreshing ||
                                Boolean(busyAction) ||
                                Boolean(activeProductionRelease)
                              }
                              onClick={() =>
                                void createSingleProductionRelease(repository)
                              }
                            >
                              {activeProductionRelease === repository ? (
                                <>
                                  <span className="spinner" /> Creating…
                                </>
                              ) : (
                                "+ Create tag"
                              )}
                            </button>
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="release-day-production-deployment">
                          <button
                            className="production-deploy-button"
                            type="button"
                            disabled={
                              !productionEnabled ||
                              !existingRelease ||
                              trackedRelease?.buildStatus !== "succeeded" ||
                              !repositoryState?.jenkinsServices.length ||
                              productionDeploymentRunning ||
                              latestTagAlreadyDeployed
                            }
                            title={
                              productionDeploymentRunning
                                ? "A production deployment is already running"
                                : latestTagAlreadyDeployed
                                  ? `${existingRelease?.tag} is already deployed to production`
                                  : "Deploy the latest production build"
                            }
                            onClick={() =>
                              existingRelease &&
                              setDeployTarget({
                                repository,
                                release: existingRelease,
                                services:
                                  repositoryState?.jenkinsServices ?? [],
                              })
                            }
                          >
                            {latestTagAlreadyDeployed
                              ? "Already deployed"
                              : "Deploy"}
                          </button>
                          {deploymentProgress && (
                            <a
                              className={`batch-status ${deploymentProgress.status}`}
                              href={
                                deploymentProgress.buildUrl ??
                                deploymentProgress.queueUrl
                              }
                              target="_blank"
                              rel="noreferrer"
                            >
                              Jenkins:{" "}
                              {deploymentProgress.status === "queued"
                                ? "Queued"
                                : deploymentProgress.status === "running"
                                  ? "Running"
                                  : deploymentProgress.status === "succeeded"
                                    ? "Succeeded"
                                    : deploymentProgress.status === "canceled"
                                      ? "Canceled"
                                      : "Failed"}{" "}
                              ↗
                            </a>
                          )}
                          {productionDeployments.length > 0 ? (
                            productionDeployments.map((deployment) => (
                              <a
                                className={`release-day-production-live ${deployment.status ?? "succeeded"}`}
                                href={deployment.buildUrl}
                                target="_blank"
                                rel="noreferrer"
                                key={`${deployment.service}-${deployment.buildNumber}`}
                                title={`Jenkins build #${deployment.buildNumber}${
                                  deployment.currentStage
                                    ? ` · ${deployment.currentStage}`
                                    : ""
                                }`}
                              >
                                {productionDeploymentLabel(deployment)}
                                {productionDeployments.length > 1
                                  ? ` · ${deployment.service}`
                                  : ""}{" "}
                                ↗
                              </a>
                            ))
                          ) : !deploymentProgress ? (
                            <small className="release-day-production-unknown">
                              {repositoryState?.deploymentLookupFailed
                                ? "Production status unavailable"
                                : "Production deployment unknown"}
                            </small>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <section
            className={`release-day-log${operationLogExpanded ? "" : " collapsed"}`}
            aria-label="Operation log"
          >
            <div>
              <button
                className="release-day-log-toggle"
                type="button"
                aria-expanded={operationLogExpanded}
                aria-controls="release-day-operation-log"
                onClick={() =>
                  setOperationLogExpanded((current) => !current)
                }
              >
                <h3>Operation log</h3>
                <svg
                  className={`release-day-log-chevron${operationLogExpanded ? " open" : ""}`}
                  viewBox="0 0 16 16"
                  width="14"
                  height="14"
                  aria-hidden="true"
                  fill="none"
                >
                  <path
                    d="M3.5 6 8 10.5 12.5 6"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <span>{session.logs.length} events</span>
            </div>
            <div
              id="release-day-operation-log"
              className="release-day-log-body"
              hidden={!operationLogExpanded}
            >
              {session.logs.length ? (
                <ol>
                  {[...session.logs].reverse().map((entry) => (
                    <li className={entry.level} key={entry.id}>
                      <time>{new Date(entry.at).toLocaleTimeString()}</time>
                      {entry.repository && (
                        <code>{entry.repository.split("/").at(-1)}</code>
                      )}
                      <span>{entry.message}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>No operations have run yet.</p>
              )}
            </div>
          </section>
        </div>
      </section>

      {jiraReleaseDialogOpen && (
        <DialogBackdrop
          onMouseDown={() => {
            closeJiraReleaseDialog();
          }}
        >
          <section
            className="release-dialog jira-release-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="jira-release-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="dialog-close"
              type="button"
              onClick={closeJiraReleaseDialog}
              aria-label="Close"
            >
              ×
            </button>
            <p className="eyebrow">Jira · {dashboard.version.name}</p>
            <h2 id="jira-release-dialog-title">Mark tickets as released</h2>
            <p className="dialog-copy">
              Uncheck any tickets that should remain in their current status.
            </p>
            <label className="jira-release-select-all">
              <input
                type="checkbox"
                checked={
                  remainingJiraIssues.length > 0 &&
                  selectedJiraIssueKeys.length === remainingJiraIssues.length
                }
                disabled={jiraReleaseStatus === "running"}
                onChange={(event) =>
                  setSelectedJiraIssueKeys(
                    event.target.checked
                      ? remainingJiraIssues.map((issue) => issue.key)
                      : [],
                  )
                }
              />
              Select all {remainingJiraIssues.length} remaining tickets
            </label>
            <div className="jira-release-ticket-list">
              {remainingJiraIssues.map((issue) => (
                <label key={issue.key}>
                  <input
                    type="checkbox"
                    aria-label={`${issue.key} ${issue.summary}`}
                    checked={selectedJiraIssueKeys.includes(issue.key)}
                    disabled={jiraReleaseStatus === "running"}
                    onChange={(event) =>
                      setSelectedJiraIssueKeys((current) =>
                        event.target.checked
                          ? [...current, issue.key]
                          : current.filter((key) => key !== issue.key),
                      )
                    }
                  />
                  <span>
                    <strong>{issue.key}</strong>
                    <span>{issue.summary}</span>
                    <small>{issue.status}</small>
                  </span>
                </label>
              ))}
            </div>
            <div className="dialog-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={closeJiraReleaseDialog}
              >
                {jiraReleaseStatus === "running" ? "Stop waiting" : "Cancel"}
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={
                  selectedJiraIssueKeys.length === 0 ||
                  jiraReleaseStatus === "running"
                }
                onClick={() => void markJiraTicketsReleased()}
              >
                {jiraReleaseStatus === "running"
                  ? "Marking released…"
                  : `Mark ${selectedJiraIssueKeys.length} selected as released`}
              </button>
            </div>
          </section>
        </DialogBackdrop>
      )}

      {developerModal && (
        <ReleaseDevelopersDialog
          repository={developerModal.repository}
          developers={developerModal.developers}
          loading={developerModal.loading}
          onClose={() => setDeveloperModal(undefined)}
        />
      )}

      {deployTarget && (
        <ProductionDeployDialog
          repository={deployTarget.repository}
          services={deployTarget.services}
          sourceTag={deployTarget.release.tag}
          deployedTags={states[deployTarget.repository]?.deployedTags ?? []}
          onDeploymentUpdated={handleProductionDeploymentUpdated}
          onClose={() => setDeployTarget(undefined)}
        />
      )}
    </>
  );
}
