import { IPC } from '@shared/types/ipc'
import type { SessionInfo } from '@shared/types/session'
import type { PetState, InteractionType } from '@shared/types/pet'
import type { WorktreePaneInfo, DiscoveredWorktree } from '@shared/types/worktree'
import type { SkillsListResult, SkillOpResult, SearchResult } from '@shared/types/skills'

const api = () => window.api

// Sessions
export const createSession = (tool: string, firstMessage?: string) =>
  api().invoke(IPC.SESSION_CREATE, tool, firstMessage) as Promise<SessionInfo>

export const createSessionInDir = (tool: string) =>
  api().invoke(IPC.SESSION_CREATE_IN_DIR, tool) as Promise<SessionInfo | null>

export const importSessions = () =>
  api().invoke(IPC.SESSION_IMPORT) as Promise<SessionInfo[]>

export const listSessions = () =>
  api().invoke(IPC.SESSION_LIST) as Promise<SessionInfo[]>

export const attachSession = (id: string) =>
  api().invoke(IPC.SESSION_ATTACH, id) as Promise<boolean>

export const killSession = (id: string) =>
  api().invoke(IPC.SESSION_KILL, id) as Promise<{ success: boolean }>

export const syncSessions = () =>
  api().invoke(IPC.SESSION_SYNC) as Promise<SessionInfo[]>

// Pet
export const getPetState = () =>
  api().invoke(IPC.PET_STATE_GET) as Promise<PetState>

export const petInteract = (type: InteractionType, detail?: string) =>
  api().invoke(IPC.PET_INTERACT, type, detail) as Promise<PetState>

// Worktree panes
export const discoverWorktrees = (projectRoot: string) =>
  api().invoke(IPC.WORKTREE_DISCOVER, projectRoot) as Promise<DiscoveredWorktree[]>

export const createWorktreePane = (sessionId: string, branch: string, baseBranch?: string, tool?: string) =>
  api().invoke(IPC.WORKTREE_CREATE_PANE, sessionId, branch, baseBranch, tool) as Promise<WorktreePaneInfo>

export const attachWorktreePanes = (sessionId: string, worktrees: Array<{ branch: string; path: string }>, tool?: string) =>
  api().invoke(IPC.WORKTREE_ATTACH_PANES, sessionId, worktrees, tool) as Promise<WorktreePaneInfo[]>

export const removeWorktreePane = (paneId: string, opts?: { keepWorktree?: boolean }) =>
  api().invoke(IPC.WORKTREE_REMOVE_PANE, paneId, opts) as Promise<{ success: boolean }>

export const pruneMergedPanes = (sessionId: string) =>
  api().invoke(IPC.WORKTREE_PRUNE_MERGED, sessionId) as Promise<string[]>

export const listWorktreePanes = (sessionId: string) =>
  api().invoke(IPC.WORKTREE_LIST_PANES, sessionId) as Promise<WorktreePaneInfo[]>

// Skills
export const listSkills = (sessionId: string) =>
  api().invoke(IPC.SKILLS_LIST, sessionId) as Promise<SkillsListResult>

export const addSkill = (sessionId: string, skillName: string) =>
  api().invoke(IPC.SKILLS_ADD, sessionId, skillName) as Promise<SkillOpResult>

export const removeSkill = (sessionId: string, skillName: string) =>
  api().invoke(IPC.SKILLS_REMOVE, sessionId, skillName) as Promise<SkillOpResult>

export const searchSkills = (query: string) =>
  api().invoke(IPC.SKILLS_SEARCH, query) as Promise<{ results: SearchResult[] }>

export const installSkill = (skillName: string) =>
  api().invoke(IPC.SKILLS_INSTALL, skillName) as Promise<SkillOpResult>
