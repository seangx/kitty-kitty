import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { BrowserWindow } from 'electron'
import * as wtRepo from '../db/worktree-pane-repo'
import type { WorktreeAdvice } from '@shared/types/worktree'

const POLL_INTERVAL = 30_000
const STALE_DAYS = 7
const ADVICE_COOLDOWN = 24 * 60 * 60 * 1000 // 24h

let timer: ReturnType<typeof setInterval> | null = null
const lastAdvice = new Map<string, number>()

export function start(): void {
  if (timer) return
  timer = setInterval(tick, POLL_INTERVAL)
  setTimeout(tick, 5000) // first tick after boot
}

export function stop(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
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

function shouldEmitAdvice(key: string): boolean {
  const last = lastAdvice.get(key)
  if (last === undefined) return true
  return Date.now() - last > ADVICE_COOLDOWN
}

function markAdviceEmitted(key: string): void {
  lastAdvice.set(key, Date.now())
}

function runGit(args: string): string {
  return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
}

function tick(): void {
  let panes: wtRepo.WorktreePaneRow[]
  try {
    panes = wtRepo.listAllActivePanes()
  } catch {
    return
  }

  // Map from paneId to list of modified files for cross-pane conflict detection
  const modifiedFilesMap = new Map<string, string[]>()

  for (const pane of panes) {
    const { id, path, branch, baseBranch } = pane

    // Check path exists
    if (!existsSync(path)) {
      try { wtRepo.updatePaneStatus(id, 'done') } catch { /* ignore */ }
      emitStatusChanged(id, 'done')
      continue
    }

    // Detect merge state
    let mergeState = 'unknown'

    try {
      // Check if branch is merged into baseBranch
      runGit(`-C "${path}" merge-base --is-ancestor ${branch} ${baseBranch}`)
      // If no error, the branch is an ancestor (merged)
      mergeState = 'merged'
    } catch {
      // Not merged - check ahead/behind
      try {
        const countOutput = runGit(`-C "${path}" rev-list --left-right --count ${baseBranch}...${branch}`)
        const parts = countOutput.split(/\s+/)
        const behind = parseInt(parts[0] ?? '0', 10)
        const ahead = parseInt(parts[1] ?? '0', 10)

        if (behind > 0) {
          // Check for conflicts using merge-tree
          try {
            const mergeBase = runGit(`-C "${path}" merge-base ${baseBranch} ${branch}`)
            const mergeTreeOutput = runGit(`-C "${path}" merge-tree ${mergeBase} ${baseBranch} ${branch}`)
            if (mergeTreeOutput.includes('<<<<<<<')) {
              mergeState = 'conflict'
            } else {
              mergeState = 'behind'
            }
          } catch {
            mergeState = 'behind'
          }

          // Emit behind advice
          if (mergeState === 'behind') {
            const adviceKey = `suggest-rebase:${id}`
            if (shouldEmitAdvice(adviceKey)) {
              markAdviceEmitted(adviceKey)
              emitAdvice({ type: 'suggest-rebase', paneId: id, branch, behind })
            }
          }
        } else if (ahead > 0) {
          mergeState = 'clean'
        } else {
          mergeState = 'clean'
        }
      } catch {
        mergeState = 'unknown'
      }
    }

    // Update merge state in DB if changed
    if (pane.mergeState !== mergeState) {
      try { wtRepo.updatePaneMergeState(id, mergeState) } catch { /* ignore */ }
      emitStatusChanged(id, mergeState)
    }

    // Emit cleanup suggestion for merged branches
    if (mergeState === 'merged') {
      const adviceKey = `suggest-cleanup:${id}`
      if (shouldEmitAdvice(adviceKey)) {
        markAdviceEmitted(adviceKey)
        emitAdvice({ type: 'suggest-cleanup', paneId: id, branch, reason: 'Branch has been merged into base branch' })
      }
    }

    // Check stale: last commit timestamp
    try {
      const timestampStr = runGit(`-C "${path}" log -1 --format=%ct`)
      const lastCommitTs = parseInt(timestampStr, 10)
      if (!isNaN(lastCommitTs)) {
        const ageMs = Date.now() - lastCommitTs * 1000
        const ageDays = ageMs / (1000 * 60 * 60 * 24)
        if (ageDays > STALE_DAYS) {
          const adviceKey = `warn-stale:${id}`
          if (shouldEmitAdvice(adviceKey)) {
            markAdviceEmitted(adviceKey)
            emitAdvice({ type: 'warn-stale', paneId: id, branch, staleDays: Math.floor(ageDays) })
          }
        }
      }
    } catch { /* ignore */ }

    // Collect modified files for cross-pane conflict detection
    try {
      const modifiedOutput = runGit(`-C "${path}" diff --name-only HEAD`)
      if (modifiedOutput) {
        modifiedFilesMap.set(id, modifiedOutput.split('\n').filter(Boolean))
      }
    } catch { /* ignore */ }
  }

  // Cross-pane conflict detection: compare modified file lists
  const paneIds = Array.from(modifiedFilesMap.keys())
  for (let i = 0; i < paneIds.length; i++) {
    for (let j = i + 1; j < paneIds.length; j++) {
      const idA = paneIds[i]!
      const idB = paneIds[j]!
      const filesA = modifiedFilesMap.get(idA)!
      const filesB = modifiedFilesMap.get(idB)!
      const setA = new Set(filesA)
      const overlap = filesB.filter((f) => setA.has(f))
      if (overlap.length > 0) {
        const adviceKey = `warn-conflict:${[idA, idB].sort().join(':')}`
        if (shouldEmitAdvice(adviceKey)) {
          markAdviceEmitted(adviceKey)
          const paneA = panes.find((p) => p.id === idA)
          const paneB = panes.find((p) => p.id === idB)
          emitAdvice({
            type: 'warn-conflict',
            paneIds: [idA, idB],
            branches: [paneA?.branch ?? idA, paneB?.branch ?? idB],
            files: overlap
          })
        }
      }
    }
  }
}
