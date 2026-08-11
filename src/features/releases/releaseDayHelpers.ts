import type {
  ReleaseControlRoomState,
  ReleaseDashboard,
} from "../../shared/types";
import type { ReleaseDeveloper } from "./releaseDevelopers";

export function defaultBranchNeedsNewProductionTag(
  state: ReleaseControlRoomState | undefined,
) {
  if (!state || state.partial) return false;
  return Boolean(state.latestProductionTagDelta?.hasSourceChanges);
}

export function productionTagDeltaPending(
  state: ReleaseControlRoomState | undefined,
) {
  return Boolean(state?.partial && !state.latestProductionTagDelta);
}

export function developersForReleaseService(
  service: ReleaseDashboard["services"][number],
): ReleaseDeveloper[] {
  const developers = new Map<
    string,
    {
      login: string;
      avatarUrl: string;
      roles: Set<"author" | "assignee" | "reviewer">;
      pullRequests: Set<number>;
    }
  >();
  for (const item of service.items) {
    const pull = item.pullRequest;
    if (!pull) continue;
    const participants = pull.participants?.length
      ? pull.participants
      : [
          {
            login: pull.author,
            avatarUrl: `https://github.com/${pull.author}.png?size=80`,
            role: "author" as const,
          },
          ...pull.assignees.map((login) => ({
            login,
            avatarUrl: `https://github.com/${login}.png?size=80`,
            role: "assignee" as const,
          })),
        ];
    for (const participant of participants) {
      const key = participant.login.toLowerCase();
      const existing = developers.get(key) ?? {
        login: participant.login,
        avatarUrl: participant.avatarUrl,
        roles: new Set(),
        pullRequests: new Set(),
      };
      existing.roles.add(participant.role);
      existing.pullRequests.add(pull.number);
      developers.set(key, existing);
    }
  }
  return [...developers.values()]
    .map((developer) => ({
      login: developer.login,
      avatarUrl: developer.avatarUrl,
      roles: [...developer.roles],
      pullRequests: [...developer.pullRequests],
    }))
    .sort((left, right) => left.login.localeCompare(right.login));
}
