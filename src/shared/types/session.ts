import type { WorktreePaneInfo } from './worktree'

export interface SessionInfo {
  id: string
  tmuxName: string
  title: string
  tool: string
  cwd: string
  mainPane?: string
  status: 'running' | 'detached' | 'dead'
  createdAt: string
  groupId?: string
  groupName?: string
  groupColor?: string
  hidden?: boolean
  roles?: string
  expertise?: string
  isGitRepo?: boolean
  worktreePanes?: WorktreePaneInfo[]
}

export interface GroupInfo {
  id: string
  name: string
  color?: string
  collabEnabled?: boolean
  mainSessionId?: string
}
