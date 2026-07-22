export interface SessionInfo {
  id: string
  tmuxName: string
  title: string
  tool: string
  color?: string
  cwd: string
  status: 'running' | 'detached' | 'dead'
  createdAt: string
  groupId?: string
  groupName?: string
  groupColor?: string
  hidden?: boolean
  roles?: string
  expertise?: string
  paneId?: string
  isGitRepo?: boolean
}

export interface GroupInfo {
  id: string
  name: string
  color?: string
  mainSessionId?: string
  parentGroupId?: string
}

export interface GroupRestartProgress {
  operationId: string
  groupId: string
  groupName: string
  completed: number
  total: number
  ok: number
  fail: number
  currentTitle?: string
  done: boolean
}
