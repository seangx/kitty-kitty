# Inbox Watcher Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an agent receives a message via `talk`, automatically push the content into the target agent's tmux pane so they don't need to manually call `listen`.

**Architecture:** An `InboxWatcher` class in `collab-manager.ts` uses `fs.watch` (with polling fallback) to monitor each collaborating agent's inbox file. On new content, it parses the JSONL, formats a notification (full message if <= 100 chars, truncated summary otherwise), and injects it via `tmux send-keys` after checking the pane is running an agent process.

**Tech Stack:** Node.js `fs.watch` / `fs.watchFile`, tmux CLI, existing collab-manager infrastructure.

---

## File Structure

| File | Role |
|---|---|
| `src/main/mcp/inbox-watcher.ts` | New. `InboxWatcher` class: watch inbox files, parse new messages, inject into tmux panes. |
| `src/main/mcp/collab-manager.ts` | Modify. Import and wire `InboxWatcher` into `startCollaboration` / `stopCollaboration` lifecycle. |

---

### Task 1: InboxWatcher Core — Watch + Parse

**Files:**
- Create: `src/main/mcp/inbox-watcher.ts`

- [ ] **Step 1: Create InboxWatcher skeleton with types**

```typescript
// src/main/mcp/inbox-watcher.ts
import { watch, watchFile, unwatchFile, readFileSync, statSync, type FSWatcher } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { log } from '../logger'

interface WatchedSession {
  sessionId: string
  tmuxName: string
  tool: string
  inboxPath: string
  offset: number
  watcher: FSWatcher | null
  fallbackActive: boolean
  /** Throttle: last inject timestamp per sender */
  lastInjectBySender: Map<string, number>
}

interface InboxMessage {
  from: string
  fromId: string
  message: string
  done: boolean
  ts: number
}

const THROTTLE_MS = 2000
const SHORT_MESSAGE_LIMIT = 100
const SUMMARY_LENGTH = 80

export class InboxWatcher {
  private sessions = new Map<string, WatchedSession>()
  private busDir: string

  constructor(busDir: string) {
    this.busDir = busDir
  }

  /**
   * Start watching an agent's inbox file.
   */
  watch(sessionId: string, tmuxName: string, tool: string): void {
    if (this.sessions.has(sessionId)) return
    const inboxPath = join(this.busDir, `${sessionId}.inbox.jsonl`)
    let offset = 0
    try {
      offset = statSync(inboxPath).size
    } catch { /* file may not exist yet */ }

    const entry: WatchedSession = {
      sessionId,
      tmuxName,
      tool,
      inboxPath,
      offset,
      watcher: null,
      fallbackActive: false,
      lastInjectBySender: new Map(),
    }

    try {
      entry.watcher = watch(inboxPath, { persistent: false }, () => {
        this.onInboxChange(sessionId)
      })
      entry.watcher.on('error', () => {
        log('inbox-watcher', `fs.watch error for ${sessionId}, falling back to polling`)
        this.startFallbackPolling(sessionId)
      })
    } catch {
      log('inbox-watcher', `fs.watch failed for ${sessionId}, using polling`)
      this.startFallbackPolling(sessionId)
    }

    this.sessions.set(sessionId, entry)
    log('inbox-watcher', `watching ${sessionId}`)
  }

  /**
   * Stop watching an agent's inbox.
   */
  unwatch(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    if (entry.watcher) {
      try { entry.watcher.close() } catch { /* ignore */ }
    }
    if (entry.fallbackActive) {
      unwatchFile(entry.inboxPath)
    }
    this.sessions.delete(sessionId)
    log('inbox-watcher', `unwatched ${sessionId}`)
  }

  /**
   * Stop all watchers.
   */
  unwatchAll(): void {
    for (const id of this.sessions.keys()) {
      this.unwatch(id)
    }
  }

  private startFallbackPolling(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.fallbackActive) return
    if (entry.watcher) {
      try { entry.watcher.close() } catch { /* ignore */ }
      entry.watcher = null
    }
    entry.fallbackActive = true
    watchFile(entry.inboxPath, { interval: 2000 }, () => {
      this.onInboxChange(sessionId)
    })
  }

  private onInboxChange(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return

    let content: string
    try {
      content = readFileSync(entry.inboxPath, 'utf-8')
    } catch { return }

    if (content.length <= entry.offset) return
    const newContent = content.slice(entry.offset)
    entry.offset = content.length

    const messages = newContent
      .trim()
      .split('\n')
      .map((line) => {
        try { return JSON.parse(line) as InboxMessage } catch { return null }
      })
      .filter((m): m is InboxMessage => m !== null)

    if (!messages.length) return

    // Throttle: group by sender, keep last message per sender
    const bySender = new Map<string, InboxMessage>()
    for (const msg of messages) {
      bySender.set(msg.fromId, msg)
    }

    for (const [senderId, msg] of bySender) {
      const lastInject = entry.lastInjectBySender.get(senderId) || 0
      if (Date.now() - lastInject < THROTTLE_MS) continue
      entry.lastInjectBySender.set(senderId, Date.now())
      this.injectMessage(entry, msg)
    }
  }

  private injectMessage(entry: WatchedSession, msg: InboxMessage): void {
    const target = `${entry.tmuxName}:0.0`

    // Check pane is running an agent process (not bare shell)
    if (!this.isPaneRunningAgent(target)) {
      log('inbox-watcher', `skip inject for ${entry.sessionId}: pane not running agent`)
      return
    }

    const text = this.formatNotification(msg)
    const escaped = text.replace(/"/g, '\\"')
    try {
      execSync(`tmux send-keys -t "${target}" "${escaped}" Enter`, { stdio: 'ignore' })
      log('inbox-watcher', `injected message from ${msg.from} to ${entry.sessionId}`)
    } catch (err) {
      log('inbox-watcher', `inject failed for ${entry.sessionId}:`, err)
    }
  }

  private isPaneRunningAgent(tmuxTarget: string): boolean {
    const agentCommands = new Set(['claude', 'codex', 'node', 'aichat'])
    try {
      const current = execSync(
        `tmux display-message -p -t "${tmuxTarget}" "#{pane_current_command}"`,
        { encoding: 'utf-8' }
      ).trim()
      return agentCommands.has(current)
    } catch {
      return false
    }
  }

  private formatNotification(msg: InboxMessage): string {
    const prefix = `[来自 ${msg.from} 的消息]`
    if (msg.message.length <= SHORT_MESSAGE_LIMIT) {
      return `${prefix} ${msg.message}${msg.done ? ' (会话结束)' : ''} 如需回复请使用 talk 工具。`
    }
    const summary = msg.message.slice(0, SUMMARY_LENGTH) + '...'
    return `${prefix} ${summary} 请调用 listen 查看完整消息并回复。`
  }
}
```

- [ ] **Step 2: Verify file compiles**

Run: `npx tsc --noEmit src/main/mcp/inbox-watcher.ts`

If tsc doesn't work standalone due to project config, run:
```bash
npm run build
```
Expected: no errors related to `inbox-watcher.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/main/mcp/inbox-watcher.ts
git commit -m "feat: add InboxWatcher class for push notifications"
```

---

### Task 2: Wire InboxWatcher into collab-manager lifecycle

**Files:**
- Modify: `src/main/mcp/collab-manager.ts`

- [ ] **Step 1: Import and instantiate InboxWatcher**

At the top of `collab-manager.ts`, after existing imports, add:

```typescript
import { InboxWatcher } from './inbox-watcher'
```

After the `const activeSessions = new Set<string>()` line, add:

```typescript
let inboxWatcher: InboxWatcher | null = null

function getInboxWatcher(): InboxWatcher {
  if (!inboxWatcher) {
    inboxWatcher = new InboxWatcher(BUS_DIR)
  }
  return inboxWatcher
}
```

- [ ] **Step 2: Register session in startCollaboration**

In `startCollaboration()`, after the `activeSessions.add(sessionId)` line, add:

```typescript
    getInboxWatcher().watch(sessionId, tmuxName, tool)
```

- [ ] **Step 3: Unregister session in stopCollaboration**

In `stopCollaboration()`, after `activeSessions.delete(sessionId)`, add:

```typescript
    getInboxWatcher().unwatch(sessionId)
```

- [ ] **Step 4: Clean up in cleanupAll**

In `cleanupAll()`, before `activeSessions.clear()`, add:

```typescript
  if (inboxWatcher) {
    inboxWatcher.unwatchAll()
    inboxWatcher = null
  }
```

- [ ] **Step 5: Verify build**

Run:
```bash
npm run build
```
Expected: success, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp/collab-manager.ts
git commit -m "feat: wire InboxWatcher into collab lifecycle"
```

---

### Task 3: Handle edge cases — tool switch and restart

**Files:**
- Modify: `src/main/mcp/collab-manager.ts`

- [ ] **Step 1: Update watcher on restartSessionAgent**

In `restartSessionAgent()`, after the `startCollaboration(...)` call path completes, the watcher is already re-registered by `startCollaboration`. But when `stopCollaboration` is called (e.g. during tool switch in `session-handlers.ts`), the watcher is removed and re-added by `startCollaboration`. This is correct — no change needed here.

However, add re-watch support in the watcher: when `watch()` is called for an already-watched session, update `tmuxName` and `tool` in case they changed:

In `inbox-watcher.ts`, modify the `watch()` method — replace the early return:

```typescript
  watch(sessionId: string, tmuxName: string, tool: string): void {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      // Update in case tmuxName or tool changed (e.g. tool switch)
      existing.tmuxName = tmuxName
      existing.tool = tool
      return
    }
    // ... rest unchanged
```

- [ ] **Step 2: Verify build**

Run:
```bash
npm run build
```
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add src/main/mcp/inbox-watcher.ts src/main/mcp/collab-manager.ts
git commit -m "fix: update watcher metadata on tool switch"
```

---

### Task 4: Manual integration test

**Files:**
- No code changes. Verification only.

- [ ] **Step 1: Start dev mode**

```bash
npm run dev
```

- [ ] **Step 2: Create a group with collab enabled and 2 sessions**

Use the Kitty Kitty UI to:
1. Create a group with collaboration enabled
2. Create 2 sessions in the group (e.g. "Alice" and "Bob")
3. Wait for both agents to start

- [ ] **Step 3: Send a message from Alice to Bob**

In Alice's agent pane, use:
```
/@ Bob 你好，请帮我看看 auth 模块
```

- [ ] **Step 4: Verify Bob's pane receives the notification**

Expected: Bob's pane should show something like:
```
[来自 Alice 的消息] 你好，请帮我看看 auth 模块 如需回复请使用 talk 工具。
```

- [ ] **Step 5: Test long message truncation**

Send a message > 100 characters from Alice. Verify Bob's pane shows truncated summary with `请调用 listen 查看完整消息并回复。`

- [ ] **Step 6: Test agent-not-running case**

Stop Bob's agent (Ctrl+C to return to shell). Send a message from Alice. Verify Bob's pane does NOT receive injected text.
