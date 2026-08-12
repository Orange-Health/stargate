export type ReleaseDeveloper = {
  login: string
  avatarUrl: string
  roles: Array<'author' | 'assignee' | 'reviewer'>
  pullRequests: number[]
}

type Participant = {
  login: string
  avatarUrl: string
  role: 'author' | 'assignee' | 'reviewer'
}

export function developersFromParticipants(
  participants: Participant[],
  pullNumber: number,
): ReleaseDeveloper[] {
  const developers = new Map<
    string,
    {
      login: string
      avatarUrl: string
      roles: Set<'author' | 'assignee' | 'reviewer'>
    }
  >()
  for (const participant of participants) {
    const key = participant.login.toLowerCase()
    const existing = developers.get(key) ?? {
      login: participant.login,
      avatarUrl: participant.avatarUrl,
      roles: new Set(),
    }
    existing.roles.add(participant.role)
    developers.set(key, existing)
  }
  return [...developers.values()]
    .map((developer) => ({
      login: developer.login,
      avatarUrl: developer.avatarUrl,
      roles: [...developer.roles],
      pullRequests: [pullNumber],
    }))
    .sort((left, right) => left.login.localeCompare(right.login))
}
