import { getDB } from './database'
import type { TmuxSession } from '../tmux/session-manager'

export interface SessionRow {
  id: string
  tmuxName: string
  title: string
  tool: string
  cwd: string
  mainPane: string
  status: string
  createdAt: string
  updatedAt: string
  groupId: string | null
  groupName: string | null
  groupColor: string | null
  roles: string
  expertise: string
  paneId: string
  externalSessionId: string
  env: string
  launchArgs: string
  transferOrigin: string
  hiveAgentId: string
  hidden?: number
}

export interface GroupRow {
  id: string
  name: string
  color: string | null
  mainSessionId: string | null
  parentGroupId: string | null
  archived: number
}

// --- Sessions ---

export function saveSession(session: TmuxSession & { cwd?: string }): void {
  const db = getDB()
  db.prepare(`
    INSERT OR REPLACE INTO sessions (id, tmux_name, title, tool, cwd, main_pane, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, COALESCE((SELECT main_pane FROM sessions WHERE id = ?), '0.0'), ?, ?, datetime('now'))
  `).run(session.id, session.tmuxName, session.title, session.tool, session.cwd || '', session.id, session.status, session.createdAt)
}

export function listSessions(): SessionRow[] {
  const db = getDB()
  return db.prepare(`
    SELECT s.id, s.tmux_name as tmuxName, s.title, s.tool, s.cwd, s.status,
           s.main_pane as mainPane, s.hidden,
           s.roles, s.expertise, s.pane_id as paneId,
           COALESCE(s.claude_session_id, '') as externalSessionId,
           COALESCE(s.hive_agent_id, '') as hiveAgentId,
           COALESCE(s.env, '') as env,
           COALESCE(s.launch_args, '') as launchArgs,
           COALESCE(s.transfer_origin, '') as transferOrigin,
           s.created_at as createdAt, s.updated_at as updatedAt,
           s.group_id as groupId, g.name as groupName, g.color as groupColor
    FROM sessions s
    LEFT JOIN groups g ON s.group_id = g.id
    ORDER BY s.updated_at DESC
  `).all() as SessionRow[]
}

export function updateSessionStatus(id: string, status: string): void {
  const db = getDB()
  db.prepare("UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id)
}

export function updateSessionTitle(id: string, title: string): void {
  const db = getDB()
  db.prepare("UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, id)
}

export function updateSessionCwd(id: string, cwd: string): void {
  const db = getDB()
  db.prepare("UPDATE sessions SET cwd = ?, updated_at = datetime('now') WHERE id = ?").run(cwd, id)
}

export function updateSessionGroup(id: string, groupId: string | null): void {
  const db = getDB()
  db.prepare("UPDATE sessions SET group_id = ?, updated_at = datetime('now') WHERE id = ?").run(groupId, id)
}

export function updateSessionTool(id: string, tool: string): void {
  const db = getDB()
  db.prepare("UPDATE sessions SET tool = ?, updated_at = datetime('now') WHERE id = ?").run(tool, id)
}

export function updateSessionMainPane(id: string, mainPane: string): void {
  const db = getDB()
  db.prepare("UPDATE sessions SET main_pane = ?, updated_at = datetime('now') WHERE id = ?").run(mainPane, id)
}

export function updateSessionHidden(id: string, hidden: boolean): void {
  const db = getDB()
  db.prepare("UPDATE sessions SET hidden = ?, updated_at = datetime('now') WHERE id = ?").run(hidden ? 1 : 0, id)
}

export function updateSessionRoles(id: string, roles: string): void {
  const db = getDB()
  db.prepare("UPDATE sessions SET roles = ?, updated_at = datetime('now') WHERE id = ?").run(roles, id)
}

export function updateSessionExpertise(id: string, expertise: string): void {
  const db = getDB()
  db.prepare("UPDATE sessions SET expertise = ?, updated_at = datetime('now') WHERE id = ?").run(expertise, id)
}

export function updateSessionPaneId(id: string, paneId: string): void {
  const db = getDB()
  db.prepare("UPDATE sessions SET pane_id = ?, updated_at = datetime('now') WHERE id = ?").run(paneId, id)
}

export function updateSessionHiveAgentId(id: string, hiveAgentId: string): void {
  const db = getDB()
  db.prepare("UPDATE sessions SET hive_agent_id = ?, updated_at = datetime('now') WHERE id = ?").run(hiveAgentId, id)
}

export function updateSessionExternalId(id: string, externalSessionId: string): void {
  const db = getDB()
  // DB column stays `claude_session_id` for backward compat (no migration needed);
  // semantically it now holds the external CLI session id for any tool (claude/codex/...)
  db.prepare("UPDATE sessions SET claude_session_id = ?, updated_at = datetime('now') WHERE id = ?").run(externalSessionId, id)
}

export function updateSessionEnv(id: string, envJson: string): void {
  const db = getDB()
  db.prepare("UPDATE sessions SET env = ?, updated_at = datetime('now') WHERE id = ?").run(envJson, id)
}

export function updateSessionLaunchArgs(id: string, launchArgs: string): void {
  const db = getDB()
  db.prepare("UPDATE sessions SET launch_args = ?, updated_at = datetime('now') WHERE id = ?").run(launchArgs, id)
}

export function updateSessionTransferOrigin(id: string, originJson: string): void {
  const db = getDB()
  db.prepare("UPDATE sessions SET transfer_origin = ?, updated_at = datetime('now') WHERE id = ?").run(originJson, id)
}

export function deleteSession(id: string): void {
  const db = getDB()
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

export function getSessionByTmuxName(tmuxName: string): SessionRow | undefined {
  const db = getDB()
  return db.prepare(`
    SELECT s.id, s.tmux_name as tmuxName, s.title, s.tool, s.cwd, s.status,
           s.main_pane as mainPane, s.pane_id as paneId,
           COALESCE(s.claude_session_id, '') as externalSessionId,
           COALESCE(s.hive_agent_id, '') as hiveAgentId,
           COALESCE(s.env, '') as env,
           COALESCE(s.launch_args, '') as launchArgs,
           COALESCE(s.transfer_origin, '') as transferOrigin,
           s.created_at as createdAt, s.updated_at as updatedAt,
           s.group_id as groupId, g.name as groupName, g.color as groupColor
    FROM sessions s
    LEFT JOIN groups g ON s.group_id = g.id
    WHERE s.tmux_name = ?
  `).get(tmuxName) as SessionRow | undefined
}

// --- Groups ---

export function createGroup(id: string, name: string, color?: string, parentGroupId?: string): void {
  const db = getDB()
  db.prepare('INSERT INTO groups (id, name, color, parent_group_id) VALUES (?, ?, ?, ?)')
    .run(id, name, color || null, parentGroupId || null)
}

export function listGroups(): GroupRow[] {
  const db = getDB()
  // 主界面列表：归档的 group 不返回，SessionDeck 因此自动不渲染它们。
  return db.prepare(`
    SELECT id, name, color, main_session_id as mainSessionId,
           parent_group_id as parentGroupId,
           COALESCE(archived, 0) as archived
    FROM groups
    WHERE COALESCE(archived, 0) = 0
    ORDER BY created_at
  `).all() as GroupRow[]
}

export function listArchivedGroups(): GroupRow[] {
  const db = getDB()
  return db.prepare(`
    SELECT g.id, g.name, g.color, g.main_session_id as mainSessionId,
           g.parent_group_id as parentGroupId,
           COALESCE(g.archived, 0) as archived
    FROM groups g
    LEFT JOIN groups parent ON parent.id = g.parent_group_id
    WHERE COALESCE(g.archived, 0) = 1
      AND (g.parent_group_id IS NULL OR COALESCE(parent.archived, 0) = 0)
    ORDER BY g.created_at
  `).all() as GroupRow[]
}

export function setGroupArchived(id: string, archived: boolean): void {
  const db = getDB()
  db.prepare('UPDATE groups SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id)
}

export function getGroupById(id: string): GroupRow | undefined {
  const db = getDB()
  return db.prepare(`
    SELECT id, name, color, main_session_id as mainSessionId,
           parent_group_id as parentGroupId,
           COALESCE(archived, 0) as archived
    FROM groups
    WHERE id = ?
  `).get(id) as GroupRow | undefined
}

export function setGroupMainSession(groupId: string, sessionId: string | null): void {
  const db = getDB()
  db.prepare('UPDATE groups SET main_session_id = ? WHERE id = ?').run(sessionId, groupId)
}

export function listSessionsByGroup(groupId: string): (SessionRow & { hidden?: number })[] {
  const db = getDB()
  return db.prepare(`
    SELECT s.id, s.tmux_name as tmuxName, s.title, s.tool, s.cwd, s.status,
           s.main_pane as mainPane, s.hidden, s.pane_id as paneId,
           COALESCE(s.claude_session_id, '') as externalSessionId,
           COALESCE(s.hive_agent_id, '') as hiveAgentId,
           COALESCE(s.env, '') as env,
           COALESCE(s.launch_args, '') as launchArgs,
           COALESCE(s.transfer_origin, '') as transferOrigin,
           s.created_at as createdAt, s.updated_at as updatedAt,
           s.group_id as groupId, g.name as groupName, g.color as groupColor
    FROM sessions s
    LEFT JOIN groups g ON s.group_id = g.id
    WHERE s.group_id = ?
    ORDER BY s.updated_at DESC
  `).all(groupId) as (SessionRow & { hidden?: number })[]
}

export function deleteGroup(id: string): void {
  const db = getDB()
  // Sessions in this group get ungrouped (ON DELETE SET NULL)
  db.prepare('DELETE FROM groups WHERE id = ?').run(id)
}

export function renameGroup(id: string, name: string): void {
  const db = getDB()
  db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, id)
}

export function updateGroupColor(id: string, color: string | null): void {
  const db = getDB()
  db.prepare('UPDATE groups SET color = ? WHERE id = ?').run(color, id)
}

export function updateGroupParent(id: string, parentGroupId: string | null): void {
  const db = getDB()
  if (parentGroupId === id) throw new Error('分组不能放进自己')
  if (parentGroupId) {
    const target = getGroupById(parentGroupId)
    if (!target) throw new Error('目标分组不存在')

    // Walk upwards from the target. If we meet `id`, the move would create a cycle.
    let cursor: GroupRow | undefined = target
    const visited = new Set<string>()
    while (cursor) {
      if (cursor.id === id) throw new Error('不能把分组放进自己的子分组')
      if (visited.has(cursor.id)) throw new Error('分组层级已存在循环')
      visited.add(cursor.id)
      cursor = cursor.parentGroupId ? getGroupById(cursor.parentGroupId) : undefined
    }
  }
  db.prepare('UPDATE groups SET parent_group_id = ? WHERE id = ?').run(parentGroupId, id)
}

export function listGroupSubtreeIds(rootId: string): string[] {
  const db = getDB()
  const rows = db.prepare('SELECT id, parent_group_id as parentGroupId FROM groups').all() as Array<{
    id: string
    parentGroupId: string | null
  }>
  const result: string[] = []
  const queue = [rootId]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    result.push(id)
    for (const row of rows) {
      if (row.parentGroupId === id) queue.push(row.id)
    }
  }
  return result
}
