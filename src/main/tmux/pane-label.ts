import { basename } from 'path'

export const PANE_BORDER_STATUS = 'bottom'
export const PANE_BORDER_FORMAT = '#[fg=#{?pane_active,#8ab8ff,#5a6378},bg=#1b1e2a,align=right] #{?@kitty_label,#{@kitty_label},#{b:pane_current_path}} '

export interface PaneLocation {
  paneId: string
  cwd: string
}

export interface HostedPaneLocation extends PaneLocation {
  tmuxName: string
}

export interface SessionPaneIdentity {
  id: string
  tmuxName: string
  cwd: string
}

/** Resolve one Kitty session to its live pane without guessing among siblings. */
export function resolveSessionPaneId(
  session: PaneLocation,
  panes: PaneLocation[],
): string | undefined {
  if (session.paneId && panes.some((pane) => pane.paneId === session.paneId)) {
    return session.paneId
  }
  const cwdMatches = panes.filter((pane) => pane.cwd === session.cwd)
  if (cwdMatches.length === 1) return cwdMatches[0].paneId
  if (panes.length === 1) return panes[0].paneId
  return undefined
}

/**
 * Recover a missing/stale pane id only when both sides of the match are unique.
 *
 * Multiple Kitty sessions may intentionally share a cwd, so cwd alone is not
 * enough unless exactly one unresolved session and one unclaimed live pane in
 * the same tmux host share it.
 */
export function recoverSessionPaneId(
  session: SessionPaneIdentity,
  unresolvedSessions: SessionPaneIdentity[],
  panes: HostedPaneLocation[],
  claimedPaneIds: ReadonlySet<string>,
): string | undefined {
  const unresolvedPeers = unresolvedSessions.filter(
    (candidate) =>
      candidate.tmuxName === session.tmuxName
      && candidate.cwd === session.cwd,
  )
  if (unresolvedPeers.length !== 1 || unresolvedPeers[0].id !== session.id) {
    return undefined
  }

  const matches = panes.filter(
    (pane) =>
      pane.tmuxName === session.tmuxName
      && pane.cwd === session.cwd
      && !claimedPaneIds.has(pane.paneId),
  )
  return matches.length === 1 ? matches[0].paneId : undefined
}

/** Build the stable pane header shown by tmux from Kitty's own session data. */
export function formatPaneLabel(title: string, cwd: string): string {
  const dirName = basename(cwd.trim()) || cwd.trim()
  const customName = title.replace(/[\r\n]+/g, ' ').trim()
  if (!customName) return dirName
  if (!dirName || customName === dirName) return customName
  return `${customName} (${dirName})`
}
