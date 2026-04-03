import { getDB } from './database'

export interface WorktreePaneRow {
  id: string
  sessionId: string
  paneId: string
  branch: string
  path: string
  baseBranch: string
  tool: string
  mergeState: string
  status: string
  createdAt: string
  updatedAt: string
}

export function saveWorktreePane(pane: {
  id: string
  sessionId: string
  paneId: string
  branch: string
  path: string
  baseBranch: string
  tool: string
}): void {
  const db = getDB()
  db.prepare(`
    INSERT OR REPLACE INTO worktree_panes
      (id, session_id, pane_id, branch, path, base_branch, tool, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(pane.id, pane.sessionId, pane.paneId, pane.branch, pane.path, pane.baseBranch, pane.tool)
}

export function listPanesBySession(sessionId: string): WorktreePaneRow[] {
  const db = getDB()
  return db.prepare(`
    SELECT id, session_id as sessionId, pane_id as paneId, branch, path,
           base_branch as baseBranch, tool, merge_state as mergeState,
           status, created_at as createdAt, updated_at as updatedAt
    FROM worktree_panes
    WHERE session_id = ?
    ORDER BY created_at
  `).all(sessionId) as WorktreePaneRow[]
}

export function listAllActivePanes(): WorktreePaneRow[] {
  const db = getDB()
  return db.prepare(`
    SELECT id, session_id as sessionId, pane_id as paneId, branch, path,
           base_branch as baseBranch, tool, merge_state as mergeState,
           status, created_at as createdAt, updated_at as updatedAt
    FROM worktree_panes
    WHERE status = 'active'
    ORDER BY created_at
  `).all() as WorktreePaneRow[]
}

export function updatePaneMergeState(id: string, mergeState: string): void {
  const db = getDB()
  db.prepare("UPDATE worktree_panes SET merge_state = ?, updated_at = datetime('now') WHERE id = ?")
    .run(mergeState, id)
}

export function updatePaneStatus(id: string, status: string): void {
  const db = getDB()
  db.prepare("UPDATE worktree_panes SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, id)
}

export function updatePanePaneId(id: string, paneId: string): void {
  const db = getDB()
  db.prepare("UPDATE worktree_panes SET pane_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(paneId, id)
}

export function deleteWorktreePane(id: string): void {
  const db = getDB()
  db.prepare('DELETE FROM worktree_panes WHERE id = ?').run(id)
}

export function getPaneById(id: string): WorktreePaneRow | undefined {
  const db = getDB()
  return db.prepare(`
    SELECT id, session_id as sessionId, pane_id as paneId, branch, path,
           base_branch as baseBranch, tool, merge_state as mergeState,
           status, created_at as createdAt, updated_at as updatedAt
    FROM worktree_panes
    WHERE id = ?
  `).get(id) as WorktreePaneRow | undefined
}
