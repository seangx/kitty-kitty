export interface PaneRemovalSession {
  id: string
  cwd: string
  paneId?: string
}

export interface LivePane {
  paneId: string
  cwd: string
}

export type SharedPaneRemovalPlan =
  | { kind: 'kill-pane'; paneId: string }
  | { kind: 'preserve-host'; reason: 'last-live-pane' | 'pane-not-proven' }

/**
 * Resolve the exact pane belonging to one row in a shared tmux host.
 *
 * Deletion must fail closed: an unproven pane is preferable to killing the
 * host and taking every sibling session down with it.
 */
export function planSharedPaneRemoval(
  session: PaneRemovalSession,
  siblings: PaneRemovalSession[],
  livePanes: LivePane[],
): SharedPaneRemovalPlan {
  if (livePanes.length <= 1) {
    return { kind: 'preserve-host', reason: 'last-live-pane' }
  }

  const liveIds = new Set(livePanes.map((pane) => pane.paneId))
  const siblingClaims = new Set(
    siblings
      .map((sibling) => sibling.paneId || '')
      .filter((paneId) => paneId && liveIds.has(paneId)),
  )

  if (
    session.paneId
    && liveIds.has(session.paneId)
    && !siblingClaims.has(session.paneId)
  ) {
    return { kind: 'kill-pane', paneId: session.paneId }
  }

  const unresolvedSameCwd = [session, ...siblings].filter(
    (candidate) =>
      candidate.cwd === session.cwd
      && (!candidate.paneId || !liveIds.has(candidate.paneId)),
  )
  const unclaimedCwdMatches = livePanes.filter(
    (pane) => pane.cwd === session.cwd && !siblingClaims.has(pane.paneId),
  )
  if (
    unresolvedSameCwd.length === 1
    && unresolvedSameCwd[0].id === session.id
    && unclaimedCwdMatches.length === 1
  ) {
    return { kind: 'kill-pane', paneId: unclaimedCwdMatches[0].paneId }
  }

  return { kind: 'preserve-host', reason: 'pane-not-proven' }
}
