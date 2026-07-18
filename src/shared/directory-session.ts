export type DirectoryTool = 'claude' | 'codex' | 'opencode'

export interface ExternalDirectorySession {
  id: string
  summary: string
  date: string
  tool?: string
}

export interface DirectoryPickResult {
  type: 'pick'
  dir: string
  sessions: ExternalDirectorySession[]
  isGitRepo: boolean
}

export type DirectoryStartAction =
  | { type: 'new'; tool: DirectoryTool }
  | { type: 'continue-latest'; tool: DirectoryTool }

export const DIRECTORY_TOOLS: DirectoryTool[] = ['claude', 'codex', 'opencode']

export function createDirectoryPickResult(
  dir: string,
  sessions: ExternalDirectorySession[],
  isGitRepo: boolean,
): DirectoryPickResult {
  return { type: 'pick', dir, sessions, isGitRepo }
}

export function createDirectoryStartAction(
  type: DirectoryStartAction['type'],
  tool: DirectoryTool,
): DirectoryStartAction {
  return { type, tool }
}
