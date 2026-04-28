/**
 * External CLI session provider abstraction.
 *
 * Each supported tool (claude / codex) has its own on-disk session storage.
 * Providers expose a uniform interface for: listing recent sessions in a cwd,
 * matching a freshly-created live session to its on-disk session id, and
 * deleting a session file when the session is killed-and-deleted.
 */

export interface ExternalSessionEntry {
  id: string
  summary: string
  date: string
}

export interface ExternalSessionProvider {
  readonly tool: string

  /** List recent sessions started from `projectDir` (newest first, capped). */
  findSessions(projectDir: string): ExternalSessionEntry[]

  /**
   * Find the most-recent session id created from `cwd` that isn't already
   * mapped to another kitty session. Used to backfill external_session_id
   * for live sessions where we didn't start the CLI ourselves (e.g. user
   * launched it in a tmux pane and we attached after the fact).
   */
  findUnclaimedSessionId(cwd: string, claimed: Set<string>): string | null

  /** Best-effort delete of the on-disk file when a session is removed. */
  deleteSessionFile(sessionId: string, cwd: string): void
}
