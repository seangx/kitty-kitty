import { watch, watchFile, unwatchFile, readFileSync, writeFileSync, statSync, existsSync, readdirSync, type FSWatcher } from 'fs'
import { execSync } from 'child_process'
import { join, basename } from 'path'
import { log } from '../logger'
import { TMUX } from '../tmux/session-manager'

interface WatchedSession {
  sessionId: string
  tmuxName: string
  /** Resolved tmux pane target (e.g. "kitty_abc:0.0" or "%42") */
  paneTarget: string
  tool: string
  inboxPath: string
  offset: number
  /** Throttle: last inject timestamp per sender */
  lastInjectBySender: Map<string, number>
  /** Per-file watcher */
  fileWatcher?: FSWatcher | null
  pollActive?: boolean
  /** Auto-discovered from agents.json (not explicitly registered) */
  autoDiscovered?: boolean
}

interface InboxMessage {
  from: string
  fromId: string
  message: string
  done: boolean
  ts: number
}

interface AgentEntry {
  id: string
  name: string
  groupId?: string
  groupName?: string
  tool?: string
  cwd?: string
  tmuxName?: string
  lastSeen: number
}

const THROTTLE_MS = 2000
const SHORT_MESSAGE_LIMIT = 100
const SUMMARY_LENGTH = 80
const AUTO_DISCOVER_INTERVAL_MS = 5000

export interface CollabMessage {
  sessionId: string
  from: string
  fromId: string
  message: string
  done: boolean
  ts: number
}

export type OnCollabMessage = (msg: CollabMessage) => void

export class InboxWatcher {
  private sessions = new Map<string, WatchedSession>()
  private busDir: string
  private dirWatcher: FSWatcher | null = null
  private fallbackActive = false
  private onMessageCallback: OnCollabMessage | null = null
  private autoDiscoverTimer: ReturnType<typeof setInterval> | null = null
  private offsetsFile: string
  private persistedOffsets: Map<string, number> = new Map()

  constructor(busDir: string) {
    this.busDir = busDir
    this.offsetsFile = join(busDir, 'inbox-offsets.json')
    this.loadOffsets()
  }

  private loadOffsets(): void {
    try {
      const raw = readFileSync(this.offsetsFile, 'utf-8')
      const obj = JSON.parse(raw) as Record<string, number>
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'number') this.persistedOffsets.set(k, v)
      }
    } catch { /* file may not exist yet */ }
  }

  private saveOffsets(): void {
    try {
      const obj: Record<string, number> = {}
      for (const [k, v] of this.persistedOffsets) obj[k] = v
      writeFileSync(this.offsetsFile, JSON.stringify(obj, null, 2))
    } catch (err) {
      log('inbox-watcher', 'saveOffsets failed:', err)
    }
  }

  private updatePersistedOffset(sessionId: string, offset: number): void {
    this.persistedOffsets.set(sessionId, offset)
    this.saveOffsets()
  }

  /** Register a callback to be notified when a collab message arrives. */
  onMessage(cb: OnCollabMessage): void {
    this.onMessageCallback = cb
  }

  /**
   * Start watching an agent's inbox file.
   */
  watch(sessionId: string, tmuxName: string, tool: string): void {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      // Update in case tmuxName or tool changed (e.g. tool switch)
      existing.tmuxName = tmuxName
      existing.paneTarget = `${tmuxName}:0.0`
      existing.tool = tool
      return
    }

    const inboxPath = join(this.busDir, `${sessionId}.inbox.jsonl`)
    let offset: number
    if (this.persistedOffsets.has(sessionId)) {
      // Resume from persisted offset — process any messages written while watcher was offline
      offset = this.persistedOffsets.get(sessionId)!
      // Defensive: clamp if file shrunk (truncation)
      try {
        const size = statSync(inboxPath).size
        if (offset > size) offset = 0
      } catch { /* file may not exist yet */ }
    } else {
      // First-ever watch for this session — skip existing messages and persist current EOF
      offset = 0
      try {
        offset = statSync(inboxPath).size
      } catch { /* file may not exist yet */ }
      this.updatePersistedOffset(sessionId, offset)
    }

    const entry: WatchedSession = {
      sessionId,
      tmuxName,
      paneTarget: `${tmuxName}:0.0`,
      tool,
      inboxPath,
      offset,
      lastInjectBySender: new Map(),
    }
    this.sessions.set(sessionId, entry)

    // Watch the individual inbox file for changes (append)
    this.watchFile(entry)

    this.ensureDirWatcher()
    this.ensureAutoDiscover()
    log('inbox-watcher', `watching ${sessionId} (offset ${offset})`)

    // If file already grew past persisted offset (e.g. messages while offline), process now
    if (this.persistedOffsets.has(sessionId)) {
      this.onInboxChange(sessionId)
    }
  }

  /**
   * Stop watching an agent's inbox.
   */
  unwatch(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    if (entry.pollActive) { try { unwatchFile(entry.inboxPath) } catch {} }
    this.sessions.delete(sessionId)
    log('inbox-watcher', `unwatched ${sessionId}`)
    if (this.sessions.size === 0) {
      this.stopDirWatcher()
      this.stopAutoDiscover()
    }
  }

  /**
   * Stop all watchers.
   */
  unwatchAll(): void {
    for (const entry of this.sessions.values()) {
      if (entry.pollActive) { try { unwatchFile(entry.inboxPath) } catch {} }
    }
    this.sessions.clear()
    this.stopDirWatcher()
    this.stopAutoDiscover()
    log('inbox-watcher', 'unwatched all')
  }

  private watchFile(entry: WatchedSession): void {
    // Use stat-based polling — fs.watch is unreliable for file appends on macOS tmpdir
    if (entry.pollActive) return
    entry.pollActive = true
    log('inbox-watcher', `polling ${entry.sessionId} at ${entry.inboxPath}`)
    watchFile(entry.inboxPath, { interval: 1000 }, (curr, prev) => {
      log('inbox-watcher', `file change ${entry.sessionId}: size ${prev.size} → ${curr.size}`)
      this.onInboxChange(entry.sessionId)
    })
  }

  private ensureDirWatcher(): void {
    if (this.dirWatcher || this.fallbackActive) return

    try {
      this.dirWatcher = watch(this.busDir, { persistent: false }, (_event, filename) => {
        if (!filename) {
          // macOS sometimes omits filename — scan all sessions
          this.checkAll()
          return
        }
        const match = filename.match(/^(.+)\.inbox\.jsonl$/)
        if (match) {
          const sessionId = match[1]
          if (this.sessions.has(sessionId)) {
            this.onInboxChange(sessionId)
          } else {
            // New inbox file — try auto-discover
            this.tryAutoDiscoverAgent(sessionId)
          }
        }
      })
      this.dirWatcher.on('error', (err) => {
        log('inbox-watcher', 'dir watcher error, falling back to polling:', err)
        this.startFallbackPolling()
      })
      log('inbox-watcher', `watching dir ${this.busDir}`)
    } catch (err) {
      log('inbox-watcher', `fs.watch dir failed, using polling:`, err)
      this.startFallbackPolling()
    }
  }

  private stopDirWatcher(): void {
    if (this.dirWatcher) {
      try { this.dirWatcher.close() } catch { /* ignore */ }
      this.dirWatcher = null
    }
    if (this.fallbackActive) {
      unwatchFile(this.busDir)
      this.fallbackActive = false
    }
  }

  private startFallbackPolling(): void {
    if (this.fallbackActive) return
    if (this.dirWatcher) {
      try { this.dirWatcher.close() } catch { /* ignore */ }
      this.dirWatcher = null
    }
    this.fallbackActive = true
    // Poll each inbox file individually
    watchFile(this.busDir, { interval: 2000 }, () => {
      this.checkAll()
    })
    // Ensure per-file polling for all current sessions (skip if already active)
    for (const entry of this.sessions.values()) {
      if (!entry.pollActive) {
        this.watchFile(entry)
      }
    }
    log('inbox-watcher', 'fallback polling active')
  }

  private checkAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.onInboxChange(sessionId)
    }
  }

  // --- Auto-discovery of pane agents ---

  private ensureAutoDiscover(): void {
    if (this.autoDiscoverTimer) return
    this.autoDiscoverTimer = setInterval(() => this.scanForNewAgents(), AUTO_DISCOVER_INTERVAL_MS)
  }

  private stopAutoDiscover(): void {
    if (this.autoDiscoverTimer) {
      clearInterval(this.autoDiscoverTimer)
      this.autoDiscoverTimer = null
    }
  }

  /**
   * Scan agents.json for agents not yet watched and auto-register them.
   * Also prune stale auto-discovered sessions no longer in agents.json.
   */
  private scanForNewAgents(): void {
    const agents = this.readAgentsJson()
    if (!agents) return

    // Prune stale auto-discovered watchers
    for (const [sessionId, entry] of this.sessions) {
      if (!entry.autoDiscovered) continue
      if (!agents[sessionId]) {
        log('inbox-watcher', `pruning stale auto-discovered watcher: ${sessionId}`)
        if (entry.pollActive) { try { unwatchFile(entry.inboxPath) } catch {} }
        this.sessions.delete(sessionId)
      }
    }

    for (const [agentId, agent] of Object.entries(agents)) {
      if (this.sessions.has(agentId)) continue
      if (agentId === 'kitty-app') continue

      // Only auto-discover agents whose parent session we're already watching
      const parentId = this.findParentSession(agentId)
      if (!parentId) continue

      this.tryAutoDiscoverAgent(agentId)
    }
  }

  /**
   * Try to auto-discover and watch a single agent by ID.
   */
  private tryAutoDiscoverAgent(agentId: string): void {
    if (this.sessions.has(agentId)) return

    const agents = this.readAgentsJson()
    if (!agents || !agents[agentId]) return

    const agent = agents[agentId]

    // Prefer tmuxPane from agents.json — it's the actual pane ID (e.g. "%5")
    // set by the MCP server process, far more reliable than cwd-based resolution.
    if (agent.tmuxPane) {
      const tmuxName = agent.tmuxName || ''
      if (!tmuxName) {
        const parentId = this.findParentSession(agentId)
        const parentEntry = parentId ? this.sessions.get(parentId) : null
        if (!parentEntry) {
          log('inbox-watcher', `auto-discover ${agentId}: no tmuxName and no parent`)
          return
        }
        this.autoWatch(agentId, parentEntry.tmuxName, agent.tmuxPane, agent.tool || 'claude')
      } else {
        this.autoWatch(agentId, tmuxName, agent.tmuxPane, agent.tool || 'claude')
      }
      return
    }

    // Fallback: no tmuxPane recorded — use cwd-based resolution
    const tmuxName = agent.tmuxName || ''
    if (!tmuxName) {
      const parentId = this.findParentSession(agentId)
      if (!parentId) return
      const parentEntry = this.sessions.get(parentId)
      if (!parentEntry) return

      const paneTarget = this.resolvePaneTarget(parentEntry.tmuxName, agent.cwd || '')
      if (!paneTarget) {
        log('inbox-watcher', `auto-discover ${agentId}: could not resolve pane target`)
        return
      }

      this.autoWatch(agentId, parentEntry.tmuxName, paneTarget, agent.tool || 'claude')
      return
    }

    // Agent has tmuxName — resolve pane target
    const paneTarget = this.resolvePaneTarget(tmuxName, agent.cwd || '')
    this.autoWatch(agentId, tmuxName, paneTarget || `${tmuxName}:0.0`, agent.tool || 'claude')
  }

  private autoWatch(agentId: string, tmuxName: string, paneTarget: string, tool: string): void {
    const inboxPath = join(this.busDir, `${agentId}.inbox.jsonl`)
    let offset: number
    if (this.persistedOffsets.has(agentId)) {
      offset = this.persistedOffsets.get(agentId)!
      try {
        const size = statSync(inboxPath).size
        if (offset > size) offset = 0
      } catch { /* ignore */ }
    } else {
      offset = 0
      try {
        offset = statSync(inboxPath).size
      } catch { /* file may not exist yet */ }
      this.updatePersistedOffset(agentId, offset)
    }

    const entry: WatchedSession = {
      sessionId: agentId,
      tmuxName,
      paneTarget,
      tool,
      inboxPath,
      offset,
      lastInjectBySender: new Map(),
      autoDiscovered: true,
    }
    this.sessions.set(agentId, entry)
    this.watchFile(entry)
    log('inbox-watcher', `auto-discovered ${agentId} → ${paneTarget} (offset ${offset})`)
    if (this.persistedOffsets.has(agentId)) {
      this.onInboxChange(agentId)
    }
  }

  /**
   * Find the parent session ID for a pane agent.
   * Pane agent IDs follow the pattern: parentId-suffix (e.g., "f6c40b8a-feat-branch-name").
   */
  private findParentSession(agentId: string): string | null {
    // Try each watched session as a potential parent
    for (const sessionId of this.sessions.keys()) {
      if (agentId.startsWith(sessionId + '-')) {
        return sessionId
      }
    }
    return null
  }

  /**
   * Resolve which tmux pane an agent is in by matching its cwd.
   * Returns a pane target like "%42" or "session:0.1".
   */
  private resolvePaneTarget(tmuxName: string, agentCwd: string): string | null {
    if (!tmuxName || !agentCwd) return null
    try {
      const output = execSync(
        `${TMUX} list-panes -t "${tmuxName}" -F "#{pane_id}:#{pane_current_path}"`,
        { encoding: 'utf-8', timeout: 3000 }
      ).trim()
      const panes: Array<{ id: string; cwd: string }> = []
      for (const line of output.split('\n')) {
        const idx = line.indexOf(':')
        if (idx < 0) continue
        panes.push({ id: line.slice(0, idx), cwd: line.slice(idx + 1) })
      }
      // Prefer exact cwd match
      const exact = panes.find(p => p.cwd === agentCwd)
      if (exact) return exact.id
      // Fall back: pane cwd is under agent cwd (agent opened a subfolder)
      const child = panes.find(p => p.cwd.startsWith(agentCwd + '/'))
      if (child) return child.id
      // Fall back: agent cwd is under pane cwd (worktree inside project)
      // But skip the first pane (main pane :0.0) to avoid hitting parent session
      const sub = panes.slice(1).find(p => agentCwd.startsWith(p.cwd + '/'))
      if (sub) return sub.id
      return null
    } catch { /* tmux command failed */ }
    return null
  }

  private readAgentsJson(): Record<string, AgentEntry> | null {
    const agentsFile = join(this.busDir, 'agents.json')
    try {
      return JSON.parse(readFileSync(agentsFile, 'utf-8'))
    } catch {
      return null
    }
  }

  // --- Message handling ---

  private onInboxChange(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return

    let buf: Buffer
    try {
      buf = readFileSync(entry.inboxPath)
    } catch { return }

    // File was truncated/rewritten — reset offset
    if (buf.length < entry.offset) {
      entry.offset = 0
      this.updatePersistedOffset(sessionId, 0)
    }

    if (buf.length <= entry.offset) return

    const newBuf = buf.slice(entry.offset)
    // Only consume up to the last complete line (ending with \n)
    const lastNewline = newBuf.lastIndexOf(0x0a) // '\n'
    if (lastNewline < 0) {
      // No complete line yet — don't advance offset
      return
    }
    const completeBuf = newBuf.slice(0, lastNewline + 1)
    const newContent = completeBuf.toString('utf-8')
    if (!newContent.trim()) {
      entry.offset = entry.offset + completeBuf.length
      return
    }

    const lines = newContent.trim().split('\n').filter(Boolean)
    const oldOffset = entry.offset
    entry.offset = entry.offset + completeBuf.length
    this.updatePersistedOffset(sessionId, entry.offset)
    log('inbox-watcher', `processed ${sessionId}: ${lines.length} lines, offset ${oldOffset}→${entry.offset}`)

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

      // Notify renderer UI
      if (this.onMessageCallback) {
        this.onMessageCallback({
          sessionId: entry.sessionId,
          from: msg.from,
          fromId: msg.fromId,
          message: msg.message,
          done: msg.done,
          ts: msg.ts,
        })
      }
    }
  }

  private injectMessage(entry: WatchedSession, msg: InboxMessage): void {
    const target = entry.paneTarget

    // Check pane is alive
    try {
      execSync(`${TMUX} display-message -p -t "${target}" ""`, { stdio: 'ignore' })
    } catch {
      // For auto-discovered agents, try re-resolving the pane target
      if (entry.autoDiscovered) {
        const agents = this.readAgentsJson()
        const agent = agents?.[entry.sessionId]
        if (agent) {
          // Prefer tmuxPane from agents.json over cwd-based resolution
          const newTarget = agent.tmuxPane || this.resolvePaneTarget(entry.tmuxName, agent.cwd || '')
          if (newTarget && newTarget !== target) {
            entry.paneTarget = newTarget
            log('inbox-watcher', `re-resolved pane target for ${entry.sessionId}: ${newTarget}`)
            // Retry with new target
            try {
              execSync(`${TMUX} display-message -p -t "${newTarget}" ""`, { stdio: 'ignore' })
            } catch {
              log('inbox-watcher', `skip inject for ${entry.sessionId}: pane not alive`)
              return
            }
          } else {
            log('inbox-watcher', `skip inject for ${entry.sessionId}: pane not alive`)
            return
          }
        } else {
          log('inbox-watcher', `skip inject for ${entry.sessionId}: pane not alive`)
          return
        }
      } else {
        log('inbox-watcher', `skip inject for ${entry.sessionId}: pane not alive`)
        return
      }
    }

    const text = this.formatNotification(msg)
    const actualTarget = entry.paneTarget
    try {
      // Use tmux load-buffer + paste-buffer to avoid shell escaping issues,
      // then send Enter separately. This ensures special chars ($, `, \, etc.)
      // don't get mangled by shell expansion.
      execSync(`${TMUX} load-buffer -`, { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
      execSync(`${TMUX} paste-buffer -t "${actualTarget}"`, { stdio: 'ignore' })
      execSync(`${TMUX} send-keys -t "${actualTarget}" Enter`, { stdio: 'ignore' })
      log('inbox-watcher', `injected message from ${msg.from} to ${entry.sessionId}`)
    } catch (err) {
      log('inbox-watcher', `inject failed for ${entry.sessionId}:`, err)
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
