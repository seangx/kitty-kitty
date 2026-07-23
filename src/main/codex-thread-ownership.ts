export interface CodexThreadSession {
  id: string
  title: string
  tool: string
  externalSessionId: string
}

export interface CodexThreadCollision {
  threadId: string
  owner: CodexThreadSession
}

export class CodexThreadCollisionError extends Error {
  readonly sessionId: string
  readonly threadId: string
  readonly owner: CodexThreadSession

  constructor(sessionId: string, collision: CodexThreadCollision) {
    super(
      `Codex thread ${collision.threadId} is already owned by `
      + `${collision.owner.title} (${collision.owner.id})`,
    )
    this.name = 'CodexThreadCollisionError'
    this.sessionId = sessionId
    this.threadId = collision.threadId
    this.owner = collision.owner
  }
}

/**
 * A Codex rollout is mutable conversation state. Two Kitty sessions must never
 * attach to the same rollout, even when they share a cwd or Hive returns a
 * stale daemon binding.
 */
export function findCodexThreadCollision(
  sessions: readonly CodexThreadSession[],
  sessionId: string,
  threadId: string,
): CodexThreadCollision | null {
  const candidate = threadId.trim()
  if (!candidate) return null
  const owner = sessions.find((session) => (
    session.id !== sessionId
    && session.tool === 'codex'
    && session.externalSessionId === candidate
  ))
  return owner ? { threadId: candidate, owner } : null
}

export function assertCodexThreadAvailable(
  sessions: readonly CodexThreadSession[],
  sessionId: string,
  threadId: string,
): void {
  const collision = findCodexThreadCollision(sessions, sessionId, threadId)
  if (collision) throw new CodexThreadCollisionError(sessionId, collision)
}
