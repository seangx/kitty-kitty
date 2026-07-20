export interface RestartableGroupSession {
  groupId?: string | null
  hidden?: unknown
  tmuxName: string
}

export function selectGroupRestartCandidates<T extends RestartableGroupSession>(
  subtreeIds: string[],
  sessions: T[],
  isAlive: (tmuxName: string) => boolean,
): T[] {
  const groupIds = new Set(subtreeIds)
  return sessions.filter((session) => (
    !!session.groupId
    && groupIds.has(session.groupId)
    && !session.hidden
    && isAlive(session.tmuxName)
  ))
}
