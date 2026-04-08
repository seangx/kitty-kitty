import { watch, watchFile, unwatchFile, readFileSync, statSync, type FSWatcher } from 'fs'
import { execSync } from 'child_process'
import { join, basename } from 'path'
import { log } from '../logger'
import { TMUX } from '../tmux/session-manager'

interface WatchedSession {
  sessionId: string
  tmuxName: string
  tool: string
  inboxPath: string
  offset: number
  /** Throttle: last inject timestamp per sender */
  lastInjectBySender: Map<string, number>
  /** Per-file watcher */
  fileWatcher?: FSWatcher | null
  pollActive?: boolean
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

  constructor(busDir: string) {
    this.busDir = busDir
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
      existing.tool = tool
      return
    }

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
      lastInjectBySender: new Map(),
    }
    this.sessions.set(sessionId, entry)

    // Watch the individual inbox file for changes (append)
    this.watchFile(entry)

    this.ensureDirWatcher()
    log('inbox-watcher', `watching ${sessionId}`)
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
    }
  }

  /**
   * Stop all watchers.
   */
  unwatchAll(): void {
    this.sessions.clear()
    this.stopDirWatcher()
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
    // Also set up per-file polling for all current sessions
    for (const entry of this.sessions.values()) {
      watchFile(entry.inboxPath, { interval: 2000 }, () => {
        this.onInboxChange(entry.sessionId)
      })
    }
    log('inbox-watcher', 'fallback polling active')
  }

  private checkAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.onInboxChange(sessionId)
    }
  }

  private onInboxChange(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return

    let content: string
    try {
      content = readFileSync(entry.inboxPath, 'utf-8')
    } catch { return }

    // File was truncated/rewritten — reset offset
    if (content.length < entry.offset) {
      entry.offset = 0
    }
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
    const target = `${entry.tmuxName}:0.0`

    // Check pane is running an agent process (not bare shell)
    if (!this.isPaneRunningAgent(target)) {
      log('inbox-watcher', `skip inject for ${entry.sessionId}: pane not running agent`)
      return
    }

    const text = this.formatNotification(msg)
    const escaped = text.replace(/"/g, '\\"')
    try {
      execSync(`${TMUX} send-keys -t "${target}" "${escaped}" Enter`, { stdio: 'ignore' })
      log('inbox-watcher', `injected message from ${msg.from} to ${entry.sessionId}`)
    } catch (err) {
      log('inbox-watcher', `inject failed for ${entry.sessionId}:`, err)
    }
  }

  private isPaneRunningAgent(tmuxTarget: string): boolean {
    try {
      // Just verify the pane exists and is alive
      execSync(`${TMUX} display-message -p -t "${tmuxTarget}" ""`, { stdio: 'ignore' })
      return true
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
