export interface WorktreePaneInfo {
  id: string
  sessionId: string
  paneId: string
  branch: string
  path: string
  baseBranch: string
  tool: string
  mergeState: 'unknown' | 'clean' | 'conflict' | 'behind' | 'merged'
  status: 'active' | 'done' | 'stale'
  aheadBehind?: { ahead: number; behind: number }
  hasUncommitted?: boolean
  createdAt: string
  updatedAt: string
}

export interface DiscoveredWorktree {
  branch: string
  path: string
  isTracked: boolean
}

export type WorktreeAdvice =
  | { type: 'suggest-cleanup'; paneId: string; branch: string; reason: string }
  | { type: 'suggest-rebase'; paneId: string; branch: string; behind: number }
  | { type: 'warn-conflict'; paneIds: string[]; branches: string[]; files: string[] }
  | { type: 'warn-stale'; paneId: string; branch: string; staleDays: number }
  | { type: 'suggest-worktree'; reason: string; suggestedBranch: string }
