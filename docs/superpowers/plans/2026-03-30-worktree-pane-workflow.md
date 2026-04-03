# Worktree-as-Pane Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pane-level worktree management to kitty-kitty sessions — each worktree becomes a tmux pane inside an existing session, with lifecycle tracking, status monitoring, and smart suggestions.

**Architecture:** New `worktree/` module handles git worktree CRUD and tmux pane operations. A `worktree_panes` DB table tracks pane-worktree associations with CASCADE delete on session removal. A background monitor polls git status every 30s and emits IPC events for UI updates. The renderer shows worktree panes as expandable sub-items on session tags.

**Tech Stack:** Electron (main process), better-sqlite3, tmux CLI, git CLI, React + Zustand (renderer)

---

## File Structure

```
Create: src/main/db/worktree-pane-repo.ts       — DB CRUD for worktree_panes table
Create: src/main/worktree/worktree-manager.ts    — git worktree + tmux pane operations
Create: src/main/worktree/worktree-monitor.ts    — background status polling + advice
Create: src/main/ipc/worktree-handlers.ts        — IPC handler registration
Create: src/shared/types/worktree.ts             — shared type definitions
Modify: src/main/db/database.ts                  — add worktree_panes migration
Modify: src/main/ipc/handlers.ts                 — register worktree handlers
Modify: src/main/ipc/session-handlers.ts         — extract worktree logic to manager, add restore
Modify: src/shared/types/ipc.ts                  — add worktree IPC constants
Modify: src/shared/types/session.ts              — add worktreePanes to SessionInfo
Modify: src/renderer/lib/ipc.ts                  — add worktree IPC wrappers
Modify: src/renderer/store/session-store.ts      — add worktree pane state + actions
Modify: src/renderer/pet/TagCloud.tsx             — expandable worktree pane sub-items
Modify: src/renderer/pet/SessionPicker.tsx        — worktree discovery + multi-select picker
Modify: src/renderer/pet/PetCanvas.tsx            — wire up worktree advice notifications
```

---

### Task 1: Shared Types

**Files:**
- Create: `src/shared/types/worktree.ts`
- Modify: `src/shared/types/ipc.ts`
- Modify: `src/shared/types/session.ts`

- [ ] **Step 1: Create worktree type definitions**

```typescript
// src/shared/types/worktree.ts

export interface WorktreePaneInfo {
  id: string
  sessionId: string
  paneId: string           // tmux pane id, e.g. "0.1" or "%5"
  branch: string
  path: string             // worktree absolute path
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
  isTracked: boolean       // already in DB
}

export type WorktreeAdvice =
  | { type: 'suggest-cleanup'; paneId: string; branch: string; reason: string }
  | { type: 'suggest-rebase'; paneId: string; branch: string; behind: number }
  | { type: 'warn-conflict'; paneIds: string[]; branches: string[]; files: string[] }
  | { type: 'warn-stale'; paneId: string; branch: string; staleDays: number }
  | { type: 'suggest-worktree'; reason: string; suggestedBranch: string }
```

- [ ] **Step 2: Add IPC constants**

Add to `src/shared/types/ipc.ts`, inside the `IPC` object after the `SESSION_SYNC` line:

```typescript
  // Worktree panes
  WORKTREE_DISCOVER: 'worktree:discover',
  WORKTREE_CREATE_PANE: 'worktree:create-pane',
  WORKTREE_ATTACH_PANES: 'worktree:attach-panes',
  WORKTREE_REMOVE_PANE: 'worktree:remove-pane',
  WORKTREE_PRUNE_MERGED: 'worktree:prune-merged',
  WORKTREE_LIST_PANES: 'worktree:list-panes',
```

- [ ] **Step 3: Extend SessionInfo to include worktree panes**

Add to `src/shared/types/session.ts`:

```typescript
import type { WorktreePaneInfo } from './worktree'

// Add to SessionInfo interface:
  worktreePanes?: WorktreePaneInfo[]
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Build succeeds (types are only referenced, no runtime code yet)

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/worktree.ts src/shared/types/ipc.ts src/shared/types/session.ts
git commit -m "feat: add shared types for worktree pane workflow"
```

---

### Task 2: Database Migration + Repository

**Files:**
- Create: `src/main/db/worktree-pane-repo.ts`
- Modify: `src/main/db/database.ts`

- [ ] **Step 1: Add migration in database.ts**

In `src/main/db/database.ts`, inside `runMigrations()`, after the existing `if (currentVersion >= 1)` block (after line 63), add:

```typescript
    // Add worktree_panes table (v3 → v4)
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS worktree_panes (
          id           TEXT PRIMARY KEY,
          session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          pane_id      TEXT NOT NULL,
          branch       TEXT NOT NULL,
          path         TEXT NOT NULL,
          base_branch  TEXT DEFAULT 'main',
          tool         TEXT DEFAULT 'claude',
          merge_state  TEXT DEFAULT 'unknown',
          status       TEXT DEFAULT 'active',
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(session_id, pane_id)
        )
      `)
    } catch { /* already exists */ }
```

- [ ] **Step 2: Create worktree-pane-repo.ts**

```typescript
// src/main/db/worktree-pane-repo.ts
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
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/main/db/worktree-pane-repo.ts src/main/db/database.ts
git commit -m "feat: add worktree_panes table and repository"
```

---

### Task 3: Worktree Manager

**Files:**
- Create: `src/main/worktree/worktree-manager.ts`
- Modify: `src/main/ipc/session-handlers.ts` (extract worktree git logic)

- [ ] **Step 1: Create worktree-manager.ts**

```typescript
// src/main/worktree/worktree-manager.ts
import { execSync } from 'child_process'
import { existsSync, symlinkSync, mkdirSync, readFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { v4 as uuid } from 'uuid'
import * as tmux from '../tmux/session-manager'
import { generateLaunchScript } from '../tmux/cli-wrapper'
import * as wtRepo from '../db/worktree-pane-repo'
import type { WorktreePaneInfo, DiscoveredWorktree } from '@shared/types/worktree'

/**
 * Create a git worktree and split it as a new pane in an existing tmux session.
 */
export function createWorktreePane(
  sessionId: string,
  tmuxName: string,
  projectRoot: string,
  branch: string,
  baseBranch = 'main',
  tool = 'claude'
): WorktreePaneInfo {
  const safeBranch = branch.replace(/[^a-zA-Z0-9/_.-]/g, '-')
  if (!safeBranch) throw new Error('无效的分支名')

  const worktreePath = join(projectRoot, '.worktrees', safeBranch.replace(/\//g, '-'))

  // Create git worktree
  try {
    try {
      execSync(`git -C "${projectRoot}" rev-parse --verify "${safeBranch}"`, { stdio: 'ignore' })
      execSync(`git -C "${projectRoot}" worktree add "${worktreePath}" "${safeBranch}"`, { stdio: 'ignore' })
    } catch {
      execSync(`git -C "${projectRoot}" worktree add -b "${safeBranch}" "${worktreePath}"`, { stdio: 'ignore' })
    }
  } catch (err: any) {
    throw new Error(`worktree 创建失败: ${err.message}`)
  }

  // Ensure .worktrees in .gitignore
  ensureGitignore(projectRoot)

  // Symlink Claude project dir
  symlinkClaudeDir(projectRoot, worktreePath)

  // Symlink openspec dir
  symlinkOpenspec(projectRoot, worktreePath)

  // Split a new tmux pane in the session
  const script = generateLaunchScript(tool, 'new')
  let paneId: string
  try {
    paneId = execSync(
      `tmux split-window -t "${tmuxName}" -h -c "${worktreePath}" -P -F "#{pane_id}" "${script}"`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
  } catch (err: any) {
    throw new Error(`tmux pane 创建失败: ${err.message}`)
  }

  // Save to DB
  const id = uuid().slice(0, 8)
  wtRepo.saveWorktreePane({ id, sessionId, paneId, branch: safeBranch, path: worktreePath, baseBranch, tool })

  return {
    id,
    sessionId,
    paneId,
    branch: safeBranch,
    path: worktreePath,
    baseBranch,
    tool,
    mergeState: 'unknown',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Remove a worktree pane. Optionally clean up the git worktree.
 */
export function removeWorktreePane(
  paneId: string,
  opts: { keepWorktree?: boolean } = {}
): void {
  const pane = wtRepo.getPaneById(paneId)
  if (!pane) return

  // Kill tmux pane if alive
  try {
    execSync(`tmux kill-pane -t "${pane.paneId}"`, { stdio: 'ignore' })
  } catch { /* already dead */ }

  if (!opts.keepWorktree && pane.path && existsSync(pane.path)) {
    // git worktree remove
    try {
      execSync(`git worktree remove "${pane.path}" --force`, { stdio: 'ignore' })
    } catch { /* ignore */ }

    // Delete merged branch (only -d, not -D)
    if (pane.mergeState === 'merged') {
      try {
        // Find the main repo from worktree path
        const gitDir = execSync(`git -C "${pane.path}" rev-parse --git-common-dir`, {
          encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore']
        }).trim()
        const mainRepo = join(gitDir, '..')
        execSync(`git -C "${mainRepo}" branch -d "${pane.branch}"`, { stdio: 'ignore' })
      } catch { /* branch not fully merged or already deleted */ }
    }
  }

  wtRepo.deleteWorktreePane(paneId)
}

/**
 * Discover existing worktrees in a project that are not yet tracked.
 */
export function discoverWorktrees(projectRoot: string): DiscoveredWorktree[] {
  const results: DiscoveredWorktree[] = []
  const tracked = new Set<string>()

  // Get all tracked worktree paths from DB (across all sessions)
  const allPanes = wtRepo.listAllActivePanes()
  for (const p of allPanes) tracked.add(p.path)

  try {
    const output = execSync(`git -C "${projectRoot}" worktree list --porcelain`, {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore']
    })

    let currentPath = ''
    let currentBranch = ''
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice('worktree '.length)
      } else if (line.startsWith('branch ')) {
        currentBranch = line.slice('branch refs/heads/'.length)
      } else if (line === '') {
        // End of entry — skip the main worktree (same as projectRoot)
        if (currentPath && currentPath !== projectRoot && currentBranch) {
          results.push({
            branch: currentBranch,
            path: currentPath,
            isTracked: tracked.has(currentPath),
          })
        }
        currentPath = ''
        currentBranch = ''
      }
    }
  } catch { /* not a git repo or git worktree list failed */ }

  return results
}

/**
 * Attach discovered worktrees as panes in an existing session.
 */
export function attachWorktrees(
  sessionId: string,
  tmuxName: string,
  worktrees: DiscoveredWorktree[],
  tool = 'claude'
): WorktreePaneInfo[] {
  const results: WorktreePaneInfo[] = []

  for (const wt of worktrees) {
    if (wt.isTracked) continue

    const script = generateLaunchScript(tool, 'new')
    let paneId: string
    try {
      paneId = execSync(
        `tmux split-window -t "${tmuxName}" -h -c "${wt.path}" -P -F "#{pane_id}" "${script}"`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
    } catch { continue }

    const id = uuid().slice(0, 8)
    // Detect base branch
    let baseBranch = 'main'
    try {
      execSync(`git -C "${wt.path}" rev-parse --verify main`, { stdio: 'ignore' })
    } catch {
      try {
        execSync(`git -C "${wt.path}" rev-parse --verify master`, { stdio: 'ignore' })
        baseBranch = 'master'
      } catch { /* keep main as default */ }
    }

    wtRepo.saveWorktreePane({ id, sessionId, paneId, branch: wt.branch, path: wt.path, baseBranch, tool })

    results.push({
      id, sessionId, paneId, branch: wt.branch, path: wt.path, baseBranch, tool,
      mergeState: 'unknown', status: 'active',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    })
  }

  return results
}

/**
 * Prune all merged worktree panes for a session.
 */
export function pruneMerged(sessionId: string): string[] {
  const panes = wtRepo.listPanesBySession(sessionId)
  const removed: string[] = []
  for (const p of panes) {
    if (p.mergeState === 'merged') {
      removeWorktreePane(p.id, { keepWorktree: false })
      removed.push(p.branch)
    }
  }
  return removed
}

/**
 * Restore worktree panes for a session after app restart.
 * Re-creates tmux panes for each tracked worktree.
 */
export function restorePanes(sessionId: string, tmuxName: string): void {
  const panes = wtRepo.listPanesBySession(sessionId)
  for (const p of panes) {
    if (p.status !== 'active') continue
    if (!existsSync(p.path)) {
      wtRepo.updatePaneStatus(p.id, 'done')
      continue
    }

    // Check if pane is already alive
    try {
      execSync(`tmux display-message -t "${p.paneId}" -p "#{pane_id}"`, { stdio: 'ignore' })
      continue // pane still exists
    } catch { /* pane gone, re-create */ }

    const script = generateLaunchScript(p.tool, 'new')
    try {
      const newPaneId = execSync(
        `tmux split-window -t "${tmuxName}" -h -c "${p.path}" -P -F "#{pane_id}" "${script}"`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
      wtRepo.updatePanePaneId(p.id, newPaneId)
    } catch {
      wtRepo.updatePaneStatus(p.id, 'done')
    }
  }
}

/**
 * Get pane info list for a session (with DB row → shared type mapping).
 */
export function listPanes(sessionId: string): WorktreePaneInfo[] {
  return wtRepo.listPanesBySession(sessionId).map(rowToInfo)
}

function rowToInfo(row: wtRepo.WorktreePaneRow): WorktreePaneInfo {
  return {
    id: row.id,
    sessionId: row.sessionId,
    paneId: row.paneId,
    branch: row.branch,
    path: row.path,
    baseBranch: row.baseBranch,
    tool: row.tool,
    mergeState: row.mergeState as WorktreePaneInfo['mergeState'],
    status: row.status as WorktreePaneInfo['status'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// --- Internal helpers (extracted from session-handlers.ts L153-226) ---

function ensureGitignore(projectRoot: string): void {
  const gitignorePath = join(projectRoot, '.gitignore')
  try {
    const content = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : ''
    if (!content.split('\n').some((l: string) => l.trim() === '.worktrees')) {
      appendFileSync(gitignorePath, `${content.endsWith('\n') ? '' : '\n'}.worktrees\n`)
    }
  } catch { /* ignore */ }
}

function symlinkClaudeDir(projectRoot: string, worktreePath: string): void {
  const claudeProjectsDir = join(homedir(), '.claude', 'projects')
  const mainEncoded = projectRoot.replace(/\//g, '-')
  const wtEncoded = worktreePath.replace(/\//g, '-')
  const mainClaudeDir = join(claudeProjectsDir, mainEncoded)
  const wtClaudeDir = join(claudeProjectsDir, wtEncoded)
  try {
    if (!existsSync(mainClaudeDir)) mkdirSync(mainClaudeDir, { recursive: true })
    if (!existsSync(wtClaudeDir)) symlinkSync(mainClaudeDir, wtClaudeDir)
  } catch { /* ignore */ }
}

function symlinkOpenspec(projectRoot: string, worktreePath: string): void {
  const mainOpenspec = join(projectRoot, 'openspec')
  const wtOpenspec = join(worktreePath, 'openspec')
  try {
    if (existsSync(mainOpenspec) && !existsSync(wtOpenspec)) {
      symlinkSync(mainOpenspec, wtOpenspec)
    }
  } catch { /* ignore */ }
}
```

- [ ] **Step 2: Refactor session-handlers.ts to use worktree-manager**

In `src/main/ipc/session-handlers.ts`, replace the `session:create-worktree` handler (lines 153-226) with:

```typescript
  // Create worktree and start session in it (legacy — creates a new session per worktree)
  ipcMain.handle('session:create-worktree', (_event, tool: string, dir: string, branch: string, resumeId?: string) => {
    const safeBranch = branch.replace(/[^a-zA-Z0-9/_.-]/g, '-')
    if (!safeBranch) throw new Error('无效的分支名')

    const worktreePath = join(dir, '.worktrees', safeBranch.replace(/\//g, '-'))

    // Delegate worktree creation to manager (reuse git + symlink logic)
    const { createWorktreeDir } = require('../worktree/worktree-manager')
    createWorktreeDir(dir, safeBranch)

    // Start session in the worktree directory
    const script = generateLaunchScript(
      tool || 'claude',
      resumeId ? 'resume' : 'continue',
      resumeId || undefined
    )
    const session = tmux.createTmuxSession(tool || 'claude', undefined, worktreePath, script)
    sessionRepo.saveSession(session)
    tmux.attachSession(session.tmuxName)
    return toSessionInfo(session)
  })
```

Actually, to minimize disruption to the existing handler, we should keep it working as-is for now and add the new pane-based flow alongside it. The old handler creates a standalone session in a worktree (whole session = one worktree). The new flow adds worktree panes inside an existing session. Both can coexist.

**So instead**: keep `session:create-worktree` unchanged. The new worktree-as-pane flow goes through the new IPC handlers in Task 4. We can deprecate the old one later.

- [ ] **Step 3: Add worktree pane restore to syncAndList**

In `src/main/ipc/session-handlers.ts`, at the top add import:

```typescript
import * as worktreeManager from '../worktree/worktree-manager'
```

In the `syncAndList()` function, inside the `if (!statusBarsInitialized)` block, after the session restore loop (after line 528 `}`), add:

```typescript
      // Restore worktree panes for all live sessions
      for (const row of sessionRepo.listSessions()) {
        if (liveNames.has(row.tmuxName)) {
          try {
            worktreeManager.restorePanes(row.id, row.tmuxName)
          } catch (err) {
            console.error(`[restore] Failed to restore worktree panes for ${row.tmuxName}:`, err)
          }
        }
      }
```

In the `toSessionInfo` function, add worktree panes:

```typescript
function toSessionInfo(s: tmux.TmuxSession): SessionInfo {
  return {
    id: s.id,
    tmuxName: s.tmuxName,
    title: s.title,
    tool: s.tool,
    cwd: s.cwd,
    mainPane: '0.0',
    status: s.status,
    createdAt: s.createdAt,
    worktreePanes: worktreeManager.listPanes(s.id),
  }
}
```

Also update the `syncAndList` result mapping to include worktree panes:

```typescript
  const result = sessionRepo.listSessions().map((row) => ({
    id: row.id,
    tmuxName: row.tmuxName,
    title: row.title,
    tool: row.tool,
    cwd: row.cwd,
    mainPane: row.mainPane || '0.0',
    status: row.status as SessionInfo['status'],
    createdAt: row.createdAt,
    groupId: row.groupId || undefined,
    groupName: row.groupName || undefined,
    groupColor: row.groupColor || undefined,
    worktreePanes: worktreeManager.listPanes(row.id),
  }))
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/main/worktree/worktree-manager.ts src/main/ipc/session-handlers.ts
git commit -m "feat: add worktree manager with pane creation, discovery, and restore"
```

---

### Task 4: IPC Handlers

**Files:**
- Create: `src/main/ipc/worktree-handlers.ts`
- Modify: `src/main/ipc/handlers.ts`

- [ ] **Step 1: Create worktree-handlers.ts**

```typescript
// src/main/ipc/worktree-handlers.ts
import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '@shared/types/ipc'
import * as worktreeManager from '../worktree/worktree-manager'
import * as sessionRepo from '../db/session-repo'

export function registerWorktreeHandlers(): void {
  // Discover untracked worktrees in a project
  ipcMain.handle(IPC.WORKTREE_DISCOVER, (_event, projectRoot: string) => {
    return worktreeManager.discoverWorktrees(projectRoot)
  })

  // Create a new worktree pane in a session
  ipcMain.handle(IPC.WORKTREE_CREATE_PANE, (_event, sessionId: string, branch: string, baseBranch?: string, tool?: string) => {
    const session = sessionRepo.listSessions().find(s => s.id === sessionId)
    if (!session) throw new Error('Session not found')
    if (!session.cwd) throw new Error('Session has no working directory')

    return worktreeManager.createWorktreePane(
      sessionId, session.tmuxName, session.cwd, branch, baseBranch || 'main', tool || session.tool
    )
  })

  // Attach discovered worktrees as panes
  ipcMain.handle(IPC.WORKTREE_ATTACH_PANES, (_event, sessionId: string, worktrees: Array<{ branch: string; path: string }>, tool?: string) => {
    const session = sessionRepo.listSessions().find(s => s.id === sessionId)
    if (!session) throw new Error('Session not found')

    return worktreeManager.attachWorktrees(
      sessionId, session.tmuxName,
      worktrees.map(w => ({ ...w, isTracked: false })),
      tool || session.tool
    )
  })

  // Remove a worktree pane
  ipcMain.handle(IPC.WORKTREE_REMOVE_PANE, (_event, paneId: string, opts?: { keepWorktree?: boolean }) => {
    worktreeManager.removeWorktreePane(paneId, opts)
    return { success: true }
  })

  // Prune all merged worktree panes in a session
  ipcMain.handle(IPC.WORKTREE_PRUNE_MERGED, (_event, sessionId: string) => {
    return worktreeManager.pruneMerged(sessionId)
  })

  // List worktree panes for a session
  ipcMain.handle(IPC.WORKTREE_LIST_PANES, (_event, sessionId: string) => {
    return worktreeManager.listPanes(sessionId)
  })
}
```

- [ ] **Step 2: Register in handlers.ts**

Replace `src/main/ipc/handlers.ts`:

```typescript
import { registerSessionHandlers } from './session-handlers'
import { registerPetHandlers } from './pet-handlers'
import { registerWorktreeHandlers } from './worktree-handlers'

export function registerIpcHandlers(): void {
  registerSessionHandlers()
  registerPetHandlers()
  registerWorktreeHandlers()
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/worktree-handlers.ts src/main/ipc/handlers.ts
git commit -m "feat: register worktree IPC handlers"
```

---

### Task 5: Worktree Monitor

**Files:**
- Create: `src/main/worktree/worktree-monitor.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Create worktree-monitor.ts**

```typescript
// src/main/worktree/worktree-monitor.ts
import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { BrowserWindow } from 'electron'
import * as wtRepo from '../db/worktree-pane-repo'
import type { WorktreeAdvice } from '@shared/types/worktree'

const POLL_INTERVAL = 30_000 // 30 seconds
const STALE_DAYS = 7
const ADVICE_COOLDOWN = 24 * 60 * 60 * 1000 // 24h per advice type+pane

let timer: ReturnType<typeof setInterval> | null = null
const lastAdvice = new Map<string, number>() // key → timestamp

export function start(): void {
  if (timer) return
  timer = setInterval(tick, POLL_INTERVAL)
  // Run first tick after a short delay (let app finish booting)
  setTimeout(tick, 5000)
}

export function stop(): void {
  if (timer) { clearInterval(timer); timer = null }
}

function tick(): void {
  const panes = wtRepo.listAllActivePanes()
  const advices: WorktreeAdvice[] = []

  // Track which files each pane modifies (for conflict detection)
  const modifiedFiles = new Map<string, { paneId: string; branch: string; files: string[] }>()

  for (const pane of panes) {
    if (!existsSync(pane.path)) {
      wtRepo.updatePaneStatus(pane.id, 'done')
      continue
    }

    // Check merge state
    const mergeState = detectMergeState(pane.path, pane.branch, pane.baseBranch)
    if (mergeState !== pane.mergeState) {
      wtRepo.updatePaneMergeState(pane.id, mergeState)
      emitStatusChanged(pane.id, mergeState)
    }

    // Check ahead/behind
    const ab = getAheadBehind(pane.path, pane.branch, pane.baseBranch)

    // Generate advice
    if (mergeState === 'merged') {
      pushAdvice(advices, {
        type: 'suggest-cleanup', paneId: pane.id, branch: pane.branch,
        reason: `${pane.branch} 已合并到 ${pane.baseBranch}`
      })
    }

    if (ab.behind > 20) {
      pushAdvice(advices, {
        type: 'suggest-rebase', paneId: pane.id, branch: pane.branch, behind: ab.behind
      })
    }

    // Stale check
    const lastCommitAge = getLastCommitAgeDays(pane.path)
    if (lastCommitAge > STALE_DAYS) {
      wtRepo.updatePaneStatus(pane.id, 'stale')
      pushAdvice(advices, {
        type: 'warn-stale', paneId: pane.id, branch: pane.branch, staleDays: lastCommitAge
      })
    }

    // Collect modified files for cross-pane conflict detection
    const files = getModifiedFiles(pane.path)
    if (files.length > 0) {
      modifiedFiles.set(pane.id, { paneId: pane.id, branch: pane.branch, files })
    }
  }

  // Cross-pane conflict detection
  const entries = [...modifiedFiles.values()]
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const overlap = entries[i].files.filter(f => entries[j].files.includes(f))
      if (overlap.length > 0) {
        pushAdvice(advices, {
          type: 'warn-conflict',
          paneIds: [entries[i].paneId, entries[j].paneId],
          branches: [entries[i].branch, entries[j].branch],
          files: overlap.slice(0, 5), // limit to 5 files
        })
      }
    }
  }

  // Emit advices
  for (const advice of advices) {
    emitAdvice(advice)
  }
}

function detectMergeState(path: string, branch: string, baseBranch: string): string {
  try {
    // Check if branch is ancestor of base (i.e., merged)
    try {
      execSync(`git -C "${path}" merge-base --is-ancestor "${branch}" "${baseBranch}"`, { stdio: 'ignore' })
      return 'merged'
    } catch { /* not merged */ }

    // Check for conflicts with merge-tree
    try {
      const mergeBase = execSync(`git -C "${path}" merge-base "${baseBranch}" "${branch}"`, {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      const result = execSync(
        `git -C "${path}" merge-tree "${mergeBase}" "${baseBranch}" "${branch}"`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
      )
      if (result.includes('<<<<<<<')) return 'conflict'
    } catch { /* ignore */ }

    // Check behind
    const ab = getAheadBehind(path, branch, baseBranch)
    if (ab.behind > 0) return 'behind'

    return 'clean'
  } catch {
    return 'unknown'
  }
}

function getAheadBehind(path: string, branch: string, baseBranch: string): { ahead: number; behind: number } {
  try {
    const output = execSync(
      `git -C "${path}" rev-list --left-right --count "${baseBranch}...${branch}"`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    const [behind, ahead] = output.split(/\s+/).map(Number)
    return { ahead: ahead || 0, behind: behind || 0 }
  } catch {
    return { ahead: 0, behind: 0 }
  }
}

function getLastCommitAgeDays(path: string): number {
  try {
    const timestamp = execSync(
      `git -C "${path}" log -1 --format=%ct`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    const seconds = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10)
    return Math.floor(seconds / 86400)
  } catch {
    return 0
  }
}

function getModifiedFiles(path: string): string[] {
  try {
    const output = execSync(
      `git -C "${path}" diff --name-only HEAD`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    return output ? output.split('\n') : []
  } catch {
    return []
  }
}

function pushAdvice(list: WorktreeAdvice[], advice: WorktreeAdvice): void {
  // Dedupe key: type + relevant pane ID
  const key = advice.type === 'warn-conflict'
    ? `${advice.type}:${advice.paneIds.sort().join(',')}`
    : `${advice.type}:${'paneId' in advice ? advice.paneId : 'global'}`

  const now = Date.now()
  const last = lastAdvice.get(key)
  if (last && now - last < ADVICE_COOLDOWN) return

  lastAdvice.set(key, now)
  list.push(advice)
}

function emitStatusChanged(paneId: string, mergeState: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('worktree:pane-status-changed', paneId, mergeState)
  }
}

function emitAdvice(advice: WorktreeAdvice): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('worktree:advice', advice)
  }
}
```

- [ ] **Step 2: Start monitor on app ready**

In `src/main/index.ts`, add import and start call. After line 8 add:

```typescript
import * as worktreeMonitor from './worktree/worktree-monitor'
```

After the `createPetWindow()` call (after line 23), add:

```typescript
  try { worktreeMonitor.start(); log('app', 'worktree monitor started') } catch (e) { log('app', 'worktree monitor error:', e) }
```

In the `before-quit` handler, before `closeDB()`, add:

```typescript
  worktreeMonitor.stop()
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/main/worktree/worktree-monitor.ts src/main/index.ts
git commit -m "feat: add worktree monitor with merge state detection and advice"
```

---

### Task 6: Renderer — IPC Wrappers + Store

**Files:**
- Modify: `src/renderer/lib/ipc.ts`
- Modify: `src/renderer/store/session-store.ts`

- [ ] **Step 1: Add IPC wrappers**

In `src/renderer/lib/ipc.ts`, add after the session functions:

```typescript
import { IPC } from '@shared/types/ipc'
import type { WorktreePaneInfo, DiscoveredWorktree } from '@shared/types/worktree'

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
```

- [ ] **Step 2: Add worktree actions to session store**

In `src/renderer/store/session-store.ts`, add to the interface after `renameSession`:

```typescript
  createWorktreePane: (sessionId: string, branch: string, baseBranch?: string, tool?: string) => Promise<void>
  removeWorktreePane: (paneId: string, keepWorktree?: boolean) => Promise<void>
```

Add the implementations in the store:

```typescript
  createWorktreePane: async (sessionId, branch, baseBranch, tool) => {
    await ipc.createWorktreePane(sessionId, branch, baseBranch, tool)
    await get().loadSessions()
  },

  removeWorktreePane: async (paneId, keepWorktree) => {
    await ipc.removeWorktreePane(paneId, { keepWorktree })
    await get().loadSessions()
  },
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/renderer/lib/ipc.ts src/renderer/store/session-store.ts
git commit -m "feat: add worktree pane IPC wrappers and store actions"
```

---

### Task 7: UI — TagCloud Worktree Pane Expansion

**Files:**
- Modify: `src/renderer/pet/TagCloud.tsx`

- [ ] **Step 1: Add expandable worktree panes to session tags**

In `src/renderer/pet/TagCloud.tsx`, add state for expansion:

After the existing `const [editTitle, setEditTitle] = useState('')` line, add:

```typescript
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null)
```

Add to the Props interface:

```typescript
  onCreateWorktreePane: (sessionId: string, branch: string) => void
  onRemoveWorktreePane: (paneId: string, keepWorktree: boolean) => void
```

Inside `renderTag()`, after the branch label `div` (after line 319's closing `}`), add the worktree pane expansion:

```typescript
          {/* Worktree panes expandable */}
          {session.worktreePanes && session.worktreePanes.length > 0 && (
            <div
              onClick={(e) => { e.stopPropagation(); setExpandedSessionId(expandedSessionId === session.id ? null : session.id) }}
              style={{ fontSize: Math.max(fontSize - 4, 7), color: '#10b981', cursor: 'pointer', marginTop: 1 }}
            >
              {expandedSessionId === session.id ? '▾' : '▸'} {session.worktreePanes.length} worktree
            </div>
          )}
```

After the `renderTag` function, add a `renderWorktreePanes` function:

```typescript
  const mergeStateColor: Record<string, string> = {
    clean: '#10b981', behind: '#d97706', conflict: '#e11d48', merged: '#6b7280', unknown: '#6b7280'
  }

  const renderWorktreePanes = (session: SessionInfo) => {
    if (!session.worktreePanes || expandedSessionId !== session.id) return null
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4,
        padding: `4px 8px`, borderRadius: 8,
        background: '#17172fcc', border: '1px solid #46465c33',
        fontSize: Math.round(10 * scale),
        fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
      }}>
        {session.worktreePanes.map((wp) => (
          <div key={wp.id} style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#e5e3ff' }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
              background: mergeStateColor[wp.mergeState] || '#6b7280',
            }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {wp.branch}
            </span>
            {wp.aheadBehind && (wp.aheadBehind.ahead > 0 || wp.aheadBehind.behind > 0) && (
              <span style={{ color: '#aaa8c3', fontSize: Math.round(8 * scale) }}>
                {wp.aheadBehind.ahead > 0 && `↑${wp.aheadBehind.ahead}`}
                {wp.aheadBehind.behind > 0 && `↓${wp.aheadBehind.behind}`}
              </span>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onRemoveWorktreePane(wp.id, true) }}
              title="关闭 pane（保留 worktree）"
              style={{
                background: 'none', border: 'none', color: '#aaa8c3', cursor: 'pointer',
                fontSize: Math.round(9 * scale), padding: '0 2px', flexShrink: 0,
              }}
            >✕</button>
          </div>
        ))}
        <button
          onClick={(e) => {
            e.stopPropagation()
            const branch = window.prompt('输入分支名:')
            if (branch?.trim()) onCreateWorktreePane(session.id, branch.trim())
          }}
          style={{
            background: 'none', border: '1px dashed #46465c44', borderRadius: 6,
            color: '#10b981', fontSize: Math.round(9 * scale), cursor: 'pointer',
            padding: '2px 6px', fontFamily: 'inherit',
          }}
        >+ worktree pane</button>
      </div>
    )
  }
```

In the render output, after each `renderTag(session, ...)` call in the hero/medium/small/grouped sections, add `renderWorktreePanes(session)`. For the hero section, change:

```typescript
      {hero && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {renderTag(hero, 0)}
          {renderWorktreePanes(hero)}
        </div>
      )}
```

For medium/small rows, wrap each tag+panes pair in a column div within the flex row.

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/renderer/pet/TagCloud.tsx
git commit -m "feat: add expandable worktree panes to session tags in TagCloud"
```

---

### Task 8: UI — SessionPicker Worktree Discovery

**Files:**
- Modify: `src/renderer/pet/SessionPicker.tsx`

- [ ] **Step 1: Add worktree discovery and multi-select to SessionPicker**

In `src/renderer/pet/SessionPicker.tsx`, update the Props interface to accept discovered worktrees:

```typescript
interface Props {
  dir: string
  sessions: ClaudeSession[]
  isGitRepo: boolean
  discoveredWorktrees?: Array<{ branch: string; path: string; isTracked: boolean }>
  onPick: (resumeId: string | null) => void
  onWorktree: (branch: string, resumeId?: string) => void
  onAttachWorktrees: (worktrees: Array<{ branch: string; path: string }>) => void
  onClose: () => void
}
```

Add state for selected worktrees:

```typescript
  const [selectedWorktrees, setSelectedWorktrees] = useState<Set<string>>(new Set())
```

In the worktree section (after the "新建 worktree" input), add a discovered worktree list:

```typescript
          {/* Discovered existing worktrees */}
          {discoveredWorktrees && discoveredWorktrees.filter(w => !w.isTracked).length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 10, color: '#10b981', marginBottom: 4 }}>🌿 已有 worktree：</div>
              {discoveredWorktrees.filter(w => !w.isTracked).map((wt) => (
                <label
                  key={wt.path}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3,
                    padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
                    background: selectedWorktrees.has(wt.path) ? '#10b98118' : 'transparent',
                    border: selectedWorktrees.has(wt.path) ? '1px solid #10b98133' : '1px solid transparent',
                    fontSize: 11, color: C.text, fontFamily: 'inherit',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedWorktrees.has(wt.path)}
                    onChange={() => {
                      setSelectedWorktrees(prev => {
                        const next = new Set(prev)
                        if (next.has(wt.path)) next.delete(wt.path)
                        else next.add(wt.path)
                        return next
                      })
                    }}
                    style={{ accentColor: '#10b981' }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {wt.branch}
                  </span>
                </label>
              ))}
              {selectedWorktrees.size > 0 && (
                <button
                  onClick={() => {
                    const selected = discoveredWorktrees!.filter(w => selectedWorktrees.has(w.path))
                    onAttachWorktrees(selected)
                  }}
                  style={{
                    width: '100%', padding: '6px 12px', borderRadius: 8, marginTop: 4,
                    background: '#10b981', border: 'none',
                    color: '#0c0c1f', fontSize: 11, fontWeight: 600,
                    cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  挂载 {selectedWorktrees.size} 个 worktree 为 pane
                </button>
              )}
            </div>
          )}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/renderer/pet/SessionPicker.tsx
git commit -m "feat: add worktree discovery and multi-select to SessionPicker"
```

---

### Task 9: UI — PetCanvas Wiring + Advice Notifications

**Files:**
- Modify: `src/renderer/pet/PetCanvas.tsx`

- [ ] **Step 1: Wire up worktree props and advice listener**

In `src/renderer/pet/PetCanvas.tsx`, add worktree store actions to the destructuring:

```typescript
  const { sessions, loadSessions, createSession, importSessions, attachSession, killSession, renameSession, createWorktreePane, removeWorktreePane } = useSessionStore()
```

Add advice state and IPC listener in the useEffect:

```typescript
  const [worktreeAdvice, setWorktreeAdvice] = useState<string | null>(null)

  useEffect(() => {
    const unsubAdvice = window.api.on('worktree:advice', (_event: any, advice: any) => {
      let message = ''
      switch (advice.type) {
        case 'suggest-cleanup':
          message = `🌿 ${advice.branch} 已合并，要清理吗？`; break
        case 'warn-conflict':
          message = `⚠️ ${advice.branches.join(' 和 ')} 修改了相同文件`; break
        case 'warn-stale':
          message = `💤 ${advice.branch} 已 ${advice.staleDays} 天没有提交`; break
        case 'suggest-rebase':
          message = `📥 ${advice.branch} 落后 ${advice.behind} 个提交`; break
      }
      if (message) say(message, 5000)
    })
    return () => { unsubAdvice() }
  }, [say])
```

Pass worktree handlers to SessionPicker. In the `handleOpenInDir` callback, after getting the `result`, also fetch discovered worktrees:

```typescript
  const handleOpenInDir = useCallback(async () => {
    try {
      const result = await window.api.invoke('session:create-in-dir', 'claude') as any
      if (!result) return
      if (result.type === 'pick') {
        // Also discover worktrees
        let discovered: any[] = []
        if (result.isGitRepo) {
          try {
            discovered = await window.api.invoke('worktree:discover', result.dir)
          } catch { /* ignore */ }
        }
        setDirPick({ ...result, discoveredWorktrees: discovered })
      } else if (result.type === 'created') {
        machine.forceState('happy', 2000)
        say('在新目录开始啦~')
        await loadSessions()
      }
    } catch {
      machine.forceState('sad', 1500); say('打开失败了喵...')
    }
  }, [machine, loadSessions, say])
```

Update the DirPickResult interface:

```typescript
interface DirPickResult {
  type: 'pick'
  dir: string
  sessions: Array<{ id: string; summary: string; date: string }>
  isGitRepo: boolean
  discoveredWorktrees?: Array<{ branch: string; path: string; isTracked: boolean }>
}
```

Pass new props to SessionPicker:

```typescript
      {dirPick && (
        <DraggablePopup>
          <SessionPicker
            dir={dirPick.dir}
            sessions={dirPick.sessions}
            isGitRepo={dirPick.isGitRepo}
            discoveredWorktrees={dirPick.discoveredWorktrees}
            onPick={handleDirConfirm}
            onWorktree={handleWorktree}
            onAttachWorktrees={async (worktrees) => {
              // This will be wired when the session exists — for now, close picker
              // The attach happens after session creation
              setDirPick(null)
            }}
            onClose={() => setDirPick(null)}
          />
        </DraggablePopup>
      )}
```

Pass worktree handlers to TagCloud:

```typescript
      <TagCloud
        sessions={sessions}
        onAttach={handleAttach}
        onKill={killSession}
        onRename={renameSession}
        onCreateWorktreePane={async (sessionId, branch) => {
          try {
            await createWorktreePane(sessionId, branch)
            say(`🌿 ${branch} pane 已创建喵~`)
          } catch (err: any) {
            say(err?.message || 'worktree pane 创建失败喵...')
          }
        }}
        onRemoveWorktreePane={async (paneId, keepWorktree) => {
          await removeWorktreePane(paneId, keepWorktree)
          say('pane 已关闭喵~')
        }}
        onChangeCwd={async (id) => {
          const newCwd = await window.api.invoke('session:change-cwd', id)
          if (newCwd) { loadSessions(); say('目录已更改喵~') }
        }}
      />
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/renderer/pet/PetCanvas.tsx
git commit -m "feat: wire worktree pane actions and advice notifications in PetCanvas"
```

---

### Task 10: Integration Verification

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 2: Run existing tests**

Run: `npm run test:mcp`
Expected: All existing tests pass (worktree changes shouldn't break MCP)

- [ ] **Step 3: Manual smoke test checklist**

Run `npm run dev` and verify:

1. App starts without errors in console
2. Existing sessions display correctly (no regression)
3. Right-click "📂 在目录中开始" on a git repo → SessionPicker shows "🌿 Worktree 分支" button
4. Create a worktree pane in an existing session → tmux splits, agent starts in worktree dir
5. Session tag shows "▸ 1 worktree" → click expands to show pane details
6. Close worktree pane from UI → pane killed, tag updates
7. Kill session → worktree pane records cleaned up (CASCADE)
8. Restart app → worktree panes restored in tmux

- [ ] **Step 4: Commit final state**

```bash
git add -A
git commit -m "feat: worktree-as-pane workflow — complete integration"
```
