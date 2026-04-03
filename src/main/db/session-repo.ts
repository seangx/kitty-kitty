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
}

export interface GroupRow {
  id: string
  name: string
  color: string | null
  collabEnabled: number
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
           s.main_pane as mainPane,
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

export function deleteSession(id: string): void {
  const db = getDB()
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

export function getSessionByTmuxName(tmuxName: string): SessionRow | undefined {
  const db = getDB()
  return db.prepare(`
    SELECT s.id, s.tmux_name as tmuxName, s.title, s.tool, s.cwd, s.status,
           s.main_pane as mainPane,
           s.created_at as createdAt, s.updated_at as updatedAt,
           s.group_id as groupId, g.name as groupName, g.color as groupColor
    FROM sessions s
    LEFT JOIN groups g ON s.group_id = g.id
    WHERE s.tmux_name = ?
  `).get(tmuxName) as SessionRow | undefined
}

// --- Groups ---

export function createGroup(id: string, name: string, color?: string): void {
  const db = getDB()
  db.prepare('INSERT INTO groups (id, name, color) VALUES (?, ?, ?)').run(id, name, color || null)
}

export function listGroups(): GroupRow[] {
  const db = getDB()
  return db.prepare(`
    SELECT id, name, color, collab_enabled as collabEnabled
    FROM groups
    ORDER BY created_at
  `).all() as GroupRow[]
}

export function getGroupById(id: string): GroupRow | undefined {
  const db = getDB()
  return db.prepare(`
    SELECT id, name, color, collab_enabled as collabEnabled
    FROM groups
    WHERE id = ?
  `).get(id) as GroupRow | undefined
}

export function setGroupCollabEnabled(id: string, enabled: boolean): void {
  const db = getDB()
  db.prepare('UPDATE groups SET collab_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

export function listSessionsByGroup(groupId: string): SessionRow[] {
  const db = getDB()
  return db.prepare(`
    SELECT s.id, s.tmux_name as tmuxName, s.title, s.tool, s.cwd, s.status,
           s.main_pane as mainPane,
           s.created_at as createdAt, s.updated_at as updatedAt,
           s.group_id as groupId, g.name as groupName, g.color as groupColor
    FROM sessions s
    LEFT JOIN groups g ON s.group_id = g.id
    WHERE s.group_id = ?
    ORDER BY s.updated_at DESC
  `).all(groupId) as SessionRow[]
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
