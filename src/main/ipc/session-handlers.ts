import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { IPC } from '@shared/types/ipc'
import { createDirectoryPickResult } from '@shared/directory-session'
import { readdirSync, existsSync, statSync, lstatSync, mkdirSync, symlinkSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { execSync, spawn } from 'child_process'
import { v4 as uuid } from 'uuid'
import { log } from '../logger'
import * as tmux from '../tmux/session-manager'
import { generateLaunchScript, type LaunchMode, isToolInstalled, getInstallHint, getNtfyTopic, setNtfyTopic, getCodexHiveBridge, setCodexHiveBridge, needsDevChannelAutoAccept, generateCodexRemoteScript, generateOpenCodeAttachScript, injectHiveIdentity, injectSessionEnv, injectOpenCodeMemory } from '../tmux/cli-wrapper'
import { registerCodexAgent, codexPaneWs, codexSetThread, renameAgent, hiveSupportsSwitchTool } from '../hive-codex'
import { openCodePaneServer, openCodePromptAsync, openCodeSetSession, type OpenCodePaneServerResult } from '../hive-opencode'
import * as sessionRepo from '../db/session-repo'
import { getDB } from '../db/database'
import * as ntfy from '../ntfy'
import { getProvider } from '../sessions'
import { clearNeedsInput, getPendingInput, isJsonlInCwd, claudeJsonlPath } from '../wakeup'
import { markCleared, isCleared, clearMark } from '../session-clear-state'
import { buildCodexHandoff, buildClaudeRecentHandoff, scanClaudeMessageTokens } from '../codex-rollout'
import { buildClaudeMemoryStartupPrompt, findClaudeMemoryForProject } from '../claude-memory'
import { syncManagedMcpsToTool } from '../mcps/mcps-manager'
import { getPetWindow } from '../windows/pet-window'
import type { SessionInfo } from '@shared/types/session'

/**
 * Fire-and-forget kitty-hive CLI call. If hive isn't installed or the command fails,
 * we silently ignore — hive is optional and kitty must keep running without it.
 */
function hiveCli(args: string[]): void {
  try {
    const child = spawn('kitty-hive', args, {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
    })
    const timeout = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 3000)
    child.on('exit', () => clearTimeout(timeout))
    child.on('error', () => { /* hive not installed / PATH miss — ignore */ })
    child.unref()
  } catch { /* ignore */ }
}

/**
 * Path B preparation for a fresh codex session. If the codex hive bridge is
 * enabled, register the agent with hive (so the supervisor spawns a codex
 * app-server daemon), then poll `codex-pane ws --key` until ready and return
 * a launch script that runs `codex --remote <ws>` inside the pane.
 *
 * Returns null when the bridge is off, hive isn't reachable, or any step
 * fails — callers fall back to a normal launch script. We log every failure
 * so the user can correlate "bridge toggle on but pane is bare codex".
 */
async function tryPrepareCodexRemoteScript(args: {
  kittyId: string
  title: string
  projectDir?: string
}): Promise<{ script: string; hiveAgentId: string; threadId?: string } | null> {
  if (!getCodexHiveBridge()) return null
  try {
    const reg = await registerCodexAgent({
      key: args.kittyId,
      displayName: args.title,
      projectDir: args.projectDir,
    })
    if (!reg.success || !reg.agentId) {
      log('codex-bridge', `register failed: ${reg.error}`)
      return null
    }
    const ws = await codexPaneWs({ key: args.kittyId, timeoutMs: 10000 })
    if (ws.status !== 'ready' || !ws.ws_url) {
      log('codex-bridge', `ws not ready (status=${ws.status}): ${ws.error || ''}`)
      return null
    }
    return { script: generateCodexRemoteScript(ws.ws_url, ws.thread_id, args.projectDir), hiveAgentId: reg.agentId, threadId: ws.thread_id }
  } catch (err) {
    log('codex-bridge', 'unexpected:', err)
    return null
  }
}

/**
 * Register an OpenCode agent with Hive and attach Kitty's visible TUI to the
 * exact supervised session that receives push events. A plain remote MCP is
 * insufficient: OpenCode does not turn MCP logging notifications into chat.
 */
async function tryPrepareOpenCodeAttachScript(args: {
  kittyId: string
  title: string
  projectDir: string
  desiredSessionId?: string | null
  initialPrompt?: string
  launchArgs?: string
  switchTool?: boolean
}): Promise<{ script: string; hiveAgentId: string; sessionId: string } | null> {
  try {
    const reg = await registerCodexAgent({
      key: args.kittyId,
      displayName: args.title,
      projectDir: args.projectDir,
      tool: 'opencode',
      switchTool: args.switchTool,
    })
    if (!reg.success || !reg.agentId) {
      log('opencode-bridge', `register failed: ${reg.error}`)
      return null
    }

    let pane: OpenCodePaneServerResult = await openCodePaneServer({ key: args.kittyId, timeoutMs: 15_000 })
    if (pane.status !== 'ready') {
      log('opencode-bridge', `server not ready (status=${pane.status}): ${pane.error || ''}`)
      return null
    }

    const shouldSwitch = args.desiredSessionId === null
      || (typeof args.desiredSessionId === 'string' && args.desiredSessionId !== pane.session_id)
    if (shouldSwitch) {
      const switched = await openCodeSetSession(reg.agentId, args.desiredSessionId ?? null)
      if (switched.kind !== 'ok') {
        log('opencode-bridge', `session switch failed (${switched.kind}): ${switched.message}`)
        return null
      }
      pane = switched.pane
    }

    if (!pane.server_url || !pane.session_id || !pane.server_username || !pane.server_password) {
      log('opencode-bridge', 'server returned incomplete attach credentials')
      return null
    }
    if (args.initialPrompt) {
      const sent = await openCodePromptAsync(pane, args.initialPrompt)
      if (!sent.success) {
        log('opencode-bridge', `initial prompt failed: ${sent.error}`)
        return null
      }
    }
    return {
      script: generateOpenCodeAttachScript({
        serverUrl: pane.server_url,
        sessionId: pane.session_id,
        username: pane.server_username,
        password: pane.server_password,
      }, args.projectDir, args.launchArgs),
      hiveAgentId: reg.agentId,
      sessionId: pane.session_id,
    }
  } catch (err) {
    log('opencode-bridge', 'unexpected:', err)
    return null
  }
}

/**
 * Tear down a session's tmux presence without harming its siblings.
 * When a session shares its tmux_name with other rows (group pane host),
 * killing the whole tmux session would take all siblings' panes down with it.
 * In that case kill only this row's own pane; only fall back to kill-session
 * when this is the last/only occupant of that tmux session.
 */
/**
 * 按会话当前 tool 解析 per-session 启动参数。
 * 新格式: JSON {"claude":"...","codex":"..."} —— Alt+X 变身后两套 CLI 的 flag
 * 集完全不同(claude 的 --model/--dangerously-* 塞给 codex 会直接报错)。
 * 旧格式(裸字符串)视为 claude 的参数(历史配置基本都是给 claude 配的)。
 */
function launchArgsFor(session: { tool: string; launchArgs: string }): string | undefined {
  const raw = (session.launchArgs || '').trim()
  if (!raw) return undefined
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>
      const v = (parsed?.[session.tool] || '').trim()
      return v || undefined
    } catch { return undefined }
  }
  return session.tool === 'claude' ? raw : undefined
}

/** Alt+X transfer 防重入(import 大 jsonl 可能要跑一阵)。 */
const transferring = new Set<string>()

/**
 * 全量 import 的对话量上限(估算 token)。官方 import 不做窗口截断,超窗导入的
 * thread 直接废(连 /compact 都发不出,实测卡死)。用户实测窗口 ≈258k:120k 导入
 * 后只剩一半,体感差 → 80k(导入后约剩 69%)。
 */
const TRANSFER_TOKEN_CAP = 80_000
/** jsonl 超过此值必超窗,跳过预扫直接降级。 */
const TRANSFER_SIZE_SHORTCUT = 50 * 1024 * 1024

/**
 * Alt+X 进度阶段推给 renderer(气泡心跳用)。真实百分比拿不到(官方 import
 * 是黑盒单步 RPC),只推诚实的阶段:scan/transfer/handoff/restart。
 */
function sendTransferProgress(sessionId: string, stage: 'scan' | 'transfer' | 'handoff' | 'daemon' | 'restart'): void {
  const win = getPetWindow()
  if (win && !win.isDestroyed()) win.webContents.send('transfer:progress', { sessionId, stage })
}

/**
 * 变身后同步项目级规则:目标工具的规则文件(AGENTS.md/CLAUDE.md)不存在时,
 * 软链到源工具的——内容永远同步,且绝不覆盖已有文件。相对 symlink,repo 可移植。
 * 全局规则(~/.claude/CLAUDE.md ↔ ~/.codex/AGENTS.md)是用户级配置,影响所有
 * 会话,不在变身时自动改动。
 */
function linkProjectRules(cwd: string, toTool: 'codex' | 'claude' | 'opencode'): void {
  if (!cwd) return
  const claudeMd = join(cwd, 'CLAUDE.md')
  const agentsMd = join(cwd, 'AGENTS.md')
  const [src, dst] = toTool === 'claude' ? [agentsMd, claudeMd] : [claudeMd, agentsMd]
  try {
    if (existsSync(src) && !existsSync(dst)) {
      symlinkSync(basename(src), dst)
      log('transfer', `rules: linked ${basename(dst)} → ${basename(src)} (${cwd})`)
    }
  } catch { /* ignore */ }
  linkSkillsBridge(cwd, toTool)
}

/**
 * skills 桥同步:skillsmgr 把 skill 部署进 <cwd>/.agents/skills,但只给部署
 * 时选中的工具建桥(如 .claude/skills → .agents/skills)。变身后另一侧没桥,
 * skill 全部隐身(管家 flyai/pptx 对 codex 不可见)。.agents/skills 存在而
 * 目标侧桥缺失时补一条相对软链;已有任何东西(含悬空链)一律不碰。
 */
function linkSkillsBridge(cwd: string, toTool: 'codex' | 'claude' | 'opencode'): void {
  const agentsSkills = join(cwd, '.agents', 'skills')
  try {
    if (!existsSync(agentsSkills)) return
    // OpenCode reads .agents/skills natively; no tool-specific bridge needed.
    if (toTool === 'opencode') return
    const bridgeDir = join(cwd, toTool === 'codex' ? '.codex' : '.claude')
    const bridge = join(bridgeDir, 'skills')
    try { lstatSync(bridge); return } catch { /* 不存在 → 补桥 */ }
    mkdirSync(bridgeDir, { recursive: true })
    symlinkSync(join('..', '.agents', 'skills'), bridge)
    log('transfer', `skills: linked ${toTool}/skills → .agents/skills (${cwd})`)
  } catch { /* ignore */ }
}

/** Prepare repo-level rules and dynamic Claude Auto Memory for a tool launch. */
function prepareProjectForTool(cwd: string, tool: string, launchScript: string): void {
  if (!cwd || !launchScript) return
  if (tool === 'claude' || tool === 'codex' || tool === 'opencode') {
    linkProjectRules(cwd, tool)
  }
  if (tool === 'opencode') {
    injectOpenCodeMemory(launchScript, findClaudeMemoryForProject(cwd))
  }
}

/** 找已安装 codex 插件里支持 transfer 的最高版本 companion 脚本。 */
function findCodexCompanion(): string | null {
  const base = join(homedir(), '.claude', 'plugins', 'cache', 'openai-codex', 'codex')
  try {
    const versions = readdirSync(base).filter((v) => existsSync(join(base, v, 'commands', 'transfer.md')))
    if (!versions.length) return null
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    return join(base, versions[0], 'scripts', 'codex-companion.mjs')
  } catch {
    return null
  }
}

/** 调插件 companion 的 transfer 子命令,把 claude jsonl 导入成 codex thread。 */
function runCodexTransfer(companion: string, sourceJsonl: string, cwd: string): Promise<{ threadId?: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [companion, 'transfer', '--source', sourceJsonl, '--cwd', cwd, '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (b: Buffer) => { out += b.toString() })
    child.stderr.on('data', (b: Buffer) => { err += b.toString() })
    // 大 jsonl(几十 MB)的导入可能要跑一阵,给足 3 分钟
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 180_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        return resolve({ error: (err || out).trim().slice(0, 300) || `transfer exited ${code}` })
      }
      try {
        const payload = JSON.parse(out.trim())
        if (payload?.threadId) return resolve({ threadId: payload.threadId })
        resolve({ error: 'transfer 输出缺少 threadId' })
      } catch {
        resolve({ error: `transfer 输出解析失败: ${out.trim().slice(0, 200)}` })
      }
    })
    child.on('error', (e) => { clearTimeout(timer); resolve({ error: String(e) }) })
  })
}

function killSessionTmux(session: sessionRepo.SessionRow): void {
  const siblings = sessionRepo.listSessions().filter(
    (s) => s.id !== session.id && s.tmuxName === session.tmuxName,
  )
  const hostAlive = tmux.isSessionAlive(session.tmuxName)
  if (siblings.length > 0 && hostAlive && session.paneId) {
    // Other rows live in this tmux session — only remove our pane.
    try {
      execSync(`${tmux.TMUX} kill-pane -t ${session.paneId}`, { stdio: 'ignore' })
      if (tmux.getPaneCount(session.tmuxName) > 1) {
        tmux.applyMainVerticalLayout(session.tmuxName)
      }
    } catch {
      // pane id stale — last resort, but only if no sibling actually has a pane
      try { tmux.killSession(session.tmuxName) } catch { /* ignore */ }
    }
    return
  }
  tmux.killSession(session.tmuxName)
}

/** List recent on-disk CLI sessions for the given tool, started from `projectDir`. */
function findExternalSessions(tool: string, projectDir: string): Array<{ id: string; summary: string; date: string; tool: string }> {
  const provider = getProvider(tool)
  if (!provider) return []
  try { return provider.findSessions(projectDir).map((e) => ({ ...e, tool })) } catch { return [] }
}

/** List recent sessions across ALL supported tools, sorted by date desc (string sort, ISO-ish). */
function findAllExternalSessions(projectDir: string): Array<{ id: string; summary: string; date: string; tool: string }> {
  const merged: Array<{ id: string; summary: string; date: string; tool: string }> = []
  for (const tool of ['claude', 'codex', 'opencode']) {
    merged.push(...findExternalSessions(tool, projectDir))
  }
  return merged.sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 8)
}

let statusBarsInitialized = false

function ensureReady(tool: string): void {
  if (!tmux.hasTmux()) {
    log('session', 'ensureReady failed: tmux not found')
    throw new Error('tmux 未安装。请先安装: brew install tmux')
  }
  if (!isToolInstalled(tool)) {
    log('session', `ensureReady failed: ${tool} not found`)
    throw new Error(`${tool} 未安装。${getInstallHint(tool)}`)
  }
}

export function registerSessionHandlers(): void {
  // Open a path in Finder
  ipcMain.handle('shell:open-path', (_event, p: string) => shell.openPath(p))

  // Create new tmux session and open terminal
  ipcMain.handle(IPC.SESSION_CREATE, async (_event, tool: string, firstMessage?: string) => {
    const t = tool || 'claude'
    ensureReady(t)

    let script: string
    let hiveAgentId = ''
    if (t === 'codex') {
      // We don't yet have a stable kitty id — generate one first so hive can
      // map back to it. tmux.createTmuxSession will reuse the id we pass via
      // the script env injection below.
      const provisional = uuid().slice(0, 8)
      const bridged = await tryPrepareCodexRemoteScript({ kittyId: provisional, title: firstMessage?.slice(0, 40) || provisional })
      if (bridged) {
        script = bridged.script
        hiveAgentId = bridged.hiveAgentId
        const session = tmux.createTmuxSession(t, firstMessage, undefined, script, provisional)
        sessionRepo.saveSession(session)
        if (hiveAgentId) sessionRepo.updateSessionHiveAgentId(session.id, hiveAgentId)
        if (bridged.threadId) sessionRepo.updateSessionExternalId(session.id, bridged.threadId)
        tmux.attachSession(session.tmuxName)
        return toSessionInfo(session)
      }
    }
    if (t === 'opencode') {
      const provisional = uuid().slice(0, 8)
      const projectDir = join(homedir(), '.kitty-kitty', 'sessions', provisional)
      mkdirSync(projectDir, { recursive: true })
      const title = firstMessage?.slice(0, 40) || provisional
      const bridged = await tryPrepareOpenCodeAttachScript({
        kittyId: provisional,
        title,
        projectDir,
        initialPrompt: firstMessage,
      })
      if (bridged) {
        script = bridged.script
        prepareProjectForTool(projectDir, t, script)
        const session = tmux.createTmuxSession(t, firstMessage, projectDir, script, provisional)
        sessionRepo.saveSession(session)
        sessionRepo.updateSessionHiveAgentId(session.id, bridged.hiveAgentId)
        sessionRepo.updateSessionExternalId(session.id, bridged.sessionId)
        tmux.attachSession(session.tmuxName)
        return toSessionInfo(session)
      }
    }
    // Pre-bind a session id for claude so its jsonl is identifiable up front
    // (lets multiple claude sessions share one cwd without cross-assignment).
    const claudeSid = t === 'claude' ? uuid() : undefined
    // Bare OpenCode fallback supports an initial prompt as a real CLI flag;
    // do not paste it into the live TUI after startup.
    script = generateLaunchScript(t, 'new', undefined, undefined, claudeSid, undefined, t === 'opencode' ? firstMessage : undefined)
    const session = tmux.createTmuxSession(t, firstMessage, undefined, script)
    sessionRepo.saveSession(session)
    if (claudeSid) sessionRepo.updateSessionExternalId(session.id, claudeSid)
    tmux.attachSession(session.tmuxName)
    return toSessionInfo(session)
  })

  // Step 1: Pick a directory. Tool readiness is checked only after the user
  // explicitly selects a tool in the confirmation UI.
  ipcMain.handle(IPC.SESSION_CREATE_IN_DIR, async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const result = win
      ? await dialog.showOpenDialog(win, { title: '选择项目目录', properties: ['openDirectory', 'showHiddenFiles'] })
      : await dialog.showOpenDialog({ title: '选择项目目录', properties: ['openDirectory', 'showHiddenFiles'] })

    if (result.canceled || result.filePaths.length === 0) return null

    const dir = result.filePaths[0]
    // Always show ALL tools' history in this dir so the user can pick a codex
    // session even when their default tool is claude (and vice versa).
    const existingSessions = findAllExternalSessions(dir)
    const isGitRepo = isGitRepository(dir)

    return createDirectoryPickResult(dir, existingSessions, isGitRepo)
  })

  // Step 2: Start session in dir with optional resume
  ipcMain.handle('session:create-in-dir-confirm', async (_event, tool: string, dir: string, resumeId?: string) => {
    let mode: 'new' | 'continue' | 'resume'
    if (resumeId === '__new__') mode = 'new'
    else if (resumeId) mode = 'resume'
    else mode = 'continue'

    const t = tool || 'claude'
    ensureReady(t)
    await syncManagedMcpsToTool(dir, t)
    let script: string
    let hiveAgentId = ''
    let presetId: string | undefined
    let bridgedThreadId: string | undefined
    let claudeSid: string | undefined
    // Path B applies only to NEW codex sessions — we can't `codex --remote`
    // into an arbitrary pre-existing thread, hive's daemon thread is fresh.
    if (t === 'codex' && mode === 'new') {
      const provisional = uuid().slice(0, 8)
      const bridged = await tryPrepareCodexRemoteScript({ kittyId: provisional, title: basename(dir), projectDir: dir })
      if (bridged) {
        script = bridged.script
        hiveAgentId = bridged.hiveAgentId
        bridgedThreadId = bridged.threadId
        presetId = provisional
      } else {
        script = generateLaunchScript(t, mode)
      }
    } else if (t === 'opencode') {
      const provisional = uuid().slice(0, 8)
      // Resolve continue BEFORE registering: registration starts a fresh Hive
      // session, which would otherwise become OpenCode's newest local row.
      const desiredSessionId = mode === 'resume'
        ? resumeId
        : mode === 'continue'
          ? findExternalSessions('opencode', dir)[0]?.id
          : undefined
      const bridged = await tryPrepareOpenCodeAttachScript({
        kittyId: provisional,
        title: basename(dir),
        projectDir: dir,
        desiredSessionId,
      })
      if (bridged) {
        script = bridged.script
        hiveAgentId = bridged.hiveAgentId
        bridgedThreadId = bridged.sessionId
        presetId = provisional
      } else {
        script = generateLaunchScript(t, mode, resumeId === '__new__' ? undefined : resumeId || undefined)
      }
    } else {
      // Pre-bind a session id only for a genuinely NEW claude session.
      claudeSid = (t === 'claude' && mode === 'new') ? uuid() : undefined
      script = generateLaunchScript(t, mode, resumeId === '__new__' ? undefined : resumeId || undefined, undefined, claudeSid)
    }
    prepareProjectForTool(dir, t, script)
    const session = tmux.createTmuxSession(t, undefined, dir, script, presetId)
    sessionRepo.saveSession(session)
    if (hiveAgentId) sessionRepo.updateSessionHiveAgentId(session.id, hiveAgentId)
    if (bridgedThreadId) sessionRepo.updateSessionExternalId(session.id, bridgedThreadId)
    if (claudeSid) sessionRepo.updateSessionExternalId(session.id, claudeSid)
    tmux.attachSession(session.tmuxName)
    return toSessionInfo(session)
  })

  // List all sessions with live status sync
  ipcMain.handle(IPC.SESSION_LIST, () => {
    return syncAndList()
  })

  // Re-attach to existing session (skip if already attached via kitty)
  ipcMain.handle(IPC.SESSION_ATTACH, (_event, id: string) => {
    // Whatever the outcome, the user took action on this session — the
    // wakeup badge has done its job, clear it.
    clearNeedsInput(id)
    const rows = sessionRepo.listSessions()
    const session = rows.find((s) => s.id === id)
    if (!session) throw new Error('Session not found')

    if (!tmux.isSessionAlive(session.tmuxName)) {
      // This session may exist as a pane in its group's host session
      if (session.groupId) {
        const groupSessions = sessionRepo.listSessionsByGroup(session.groupId)
          .filter(s => tmux.isSessionAlive(s.tmuxName))
        const hostSession = groupSessions[0]
        if (hostSession) {
          tmux.focusSession(hostSession.tmuxName)
          return true
        }
      }
      // tmux gone — try to restore on the fly before giving up. Only mark dead
      // when the cwd is missing or tmux itself refuses to spawn the session.
      if (tryRestoreSession(session)) {
        tmux.attachSession(session.tmuxName)
        return true
      }
      sessionRepo.updateSessionStatus(id, 'dead')
      return false
    }

    if (tmux.isSessionAttached(session.tmuxName)) {
      log('session', `attach ${id}: already attached, focusing`)
      tmux.focusSession(session.tmuxName)
      return true
    }

    if (tmux.hasAnyAttachedClient()) {
      log('session', `attach ${id}: switching client`)
      tmux.focusSession(session.tmuxName)
      return true
    }

    log('session', `attach ${id}: no client, opening new terminal`)
    tmux.attachSession(session.tmuxName)
    return true
  })

  // Drift detection is disabled.
  // - Claude has the wakeup Stop/Notification hook that auto-syncs
  //   externalSessionId with cwd validation; drift was redundant.
  // - Codex's cwd-fallback path produced false positives (the cwd recorded in
  //   a codex rollout header is where codex was launched from, not the kitty
  //   session's project dir — so strict cwd match almost always missed, and
  //   the fallback picked unrelated rollouts from other agents).
  // The real "thread changed" signal should come from hive (push-based) once
  // the planned /admin/codex-set-thread API and a paired notification arrive.
  // Until then, restartSessionPane's bridge/bypass branches handle thread
  // alignment without any UI prompt.
  ipcMain.handle('session:check-drift', () => null)

  // Rebind a session row to a different external session id.
  //   keepTmux=false (default): kill the tmux session so next attach goes
  //     through the restore path and resumes with the new id.
  //   keepTmux=true: only update the DB. The live pane keeps running the
  //     CLI's already-active session (e.g. claude after `/clear` rolled to a
  //     new jsonl); the new id only takes effect on next kitty launch.
  ipcMain.handle('session:rebind-external', (_event, id: string, newExternalId: string, keepTmux: boolean = false) => {
    const rows = sessionRepo.listSessions()
    const session = rows.find((s) => s.id === id)
    if (!session) return { success: false }
    // Reject cross-cwd rebind (claude tool only — codex has no jsonl-in-cwd
    // contract). The jsonl must physically live under the row's claimed cwd.
    if (session.tool === 'claude' && newExternalId && !isJsonlInCwd(newExternalId, session.cwd)) {
      log('session', `rebind REJECT cross-cwd: ${session.title} cwd=${session.cwd} jsonl=${newExternalId.slice(0, 8)}`)
      return { success: false, error: 'jsonl-not-in-cwd' }
    }
    if (!keepTmux) {
      try { tmux.killSession(session.tmuxName) } catch { /* ignore */ }
      sessionRepo.updateSessionStatus(id, 'detached')
    }
    sessionRepo.updateSessionExternalId(id, newExternalId)
    log('session', `rebind ${session.title} → ${newExternalId.slice(0, 8)}${keepTmux ? ' (soft)' : ''}`)
    return { success: true }
  })

  ipcMain.handle(IPC.SESSION_KILL, (_event, id: string) => {
    const rows = sessionRepo.listSessions()
    const session = rows.find((s) => s.id === id)
    if (session) {
      killSessionTmux(session)
      sessionRepo.deleteSession(id)
      hiveCli(['agent', 'remove', '--key', id, '--yes'])
    }
    return { success: true }
  })

  // Kill + delete session data files (session dir under ~/.kitty-kitty/sessions/ and claude session file)
  ipcMain.handle('session:kill-and-delete', (_event, id: string) => {
    const fs = require('fs') as typeof import('fs')
    const rows = sessionRepo.listSessions()
    const session = rows.find((s) => s.id === id)
    if (!session) return { success: true }

    killSessionTmux(session)

    // Delete session directory if under ~/.kitty-kitty/sessions/
    const kittySessionsDir = join(homedir(), '.kitty-kitty', 'sessions')
    if (session.cwd && session.cwd.startsWith(kittySessionsDir)) {
      try { fs.rmSync(session.cwd, { recursive: true, force: true }) } catch { /* ignore */ }
    }

    // Delete the on-disk CLI session file if we know its id
    if (session.externalSessionId && session.cwd) {
      const provider = getProvider(session.tool)
      if (provider) {
        try { provider.deleteSessionFile(session.externalSessionId, session.cwd) } catch { /* ignore */ }
      }
    }

    sessionRepo.deleteSession(id)
    hiveCli(['agent', 'remove', '--key', id, '--yes'])
    log('session', `kill-and-delete: ${session.title}`)
    return { success: true }
  })

  // Rename a session
  ipcMain.handle('session:rename', (_event, id: string, title: string) => {
    const session = sessionRepo.listSessions().find((row) => row.id === id)
    sessionRepo.updateSessionTitle(id, title)
    tmux.refreshAllStatusBars()
    if (session && !tmux.refreshPaneLabelForSession({
      tmuxName: session.tmuxName,
      paneId: session.paneId,
      cwd: session.cwd,
      title,
    })) {
      log('session', `rename pane label refresh missed: ${id}`)
    }
    // Sync display_name to hive so agents keep the same id but show the new title
    if (title && title.trim()) {
      hiveCli(['agent', 'register', '--key', id, '--display-name', title])
    }
    return { success: true }
  })

  ipcMain.handle('session:set-roles', (_event, id: string, roles: string) => {
    sessionRepo.updateSessionRoles(id, roles)
    return { success: true }
  })

  ipcMain.handle('session:set-expertise', (_event, id: string, expertise: string) => {
    sessionRepo.updateSessionExpertise(id, expertise)
    return { success: true }
  })

  // Wakeup state — list of session ids currently flagged "needs your input".
  ipcMain.handle('session:list-needs-input', () => getPendingInput())
  // Renderer notifies the main process that the user has handled a wakeup
  // (typically when they attach the session). Removes the badge.
  ipcMain.handle('session:clear-needs-input', (_event, id: string) => {
    clearNeedsInput(id)
    return { success: true }
  })

  // Aggregate handler: set roles + expertise, re-inject .mcp.json.
  ipcMain.handle('session:set-agent-metadata', (_event, id: string, roles: string, expertise: string) => {
    sessionRepo.updateSessionRoles(id, roles)
    sessionRepo.updateSessionExpertise(id, expertise)

    const session = sessionRepo.listSessions().find(s => s.id === id)
    if (!session) throw new Error('Session not found')

    return { success: true }
  })

  // Change a session CLI tool and restart the tmux command in-place.
  ipcMain.handle('session:set-tool', async (_event, id: string, tool: string) => {
    const nextTool = (tool || '').trim()
    if (!['claude', 'codex', 'opencode', 'shell'].includes(nextTool)) {
      throw new Error(`Unsupported tool: ${tool}`)
    }
    ensureReady(nextTool)

    const rows = sessionRepo.listSessions()
    const session = rows.find((s) => s.id === id)
    if (!session) throw new Error('Session not found')
    if (session.tool === nextTool) return { success: true }

    await syncManagedMcpsToTool(session.cwd, nextTool)
    if (nextTool === 'claude' || nextTool === 'codex' || nextTool === 'opencode') {
      linkProjectRules(session.cwd, nextTool)
    }

    // OpenCode's plugin may emit session.created immediately after respawn.
    // Commit the target tool first so wakeup accepts that exact external id;
    // roll the DB state back if respawn itself fails.
    const nextExternalId = nextTool === 'claude' ? uuid() : ''
    sessionRepo.updateSessionTool(id, nextTool)
    sessionRepo.updateSessionExternalId(id, nextExternalId)
    try {
      if (tmux.isSessionAlive(session.tmuxName)) {
        await restartSessionTool({ ...session, tool: nextTool, externalSessionId: nextExternalId }, nextTool)
      }
    } catch (err) {
      sessionRepo.updateSessionTool(id, session.tool)
      sessionRepo.updateSessionExternalId(id, session.externalSessionId)
      throw err
    }

    return { success: true }
  })

  // Restart current session agent process in-place.
  ipcMain.handle('session:restart-agent', async (_event, id: string) => {
    const rows = sessionRepo.listSessions()
    const session = rows.find((s) => s.id === id)
    if (!session) throw new Error('Session not found')
    if (!tmux.isSessionAlive(session.tmuxName)) {
      sessionRepo.updateSessionStatus(id, 'dead')
      throw new Error('Session is not running')
    }
    await restartSessionPane(session)
    return { success: true }
  })

  // Clear conversation = start a fresh thread/jsonl in the same cwd.
  // Semantics (per tool):
  //   claude  : send `/clear` to the pane; wakeup Stop hook will sync the new
  //             jsonl id back to DB after the user's next message. We also
  //             eagerly clear externalSessionId so any restart before the hook
  //             fires won't resume the old jsonl.
  //   codex   : bridge 模式通过 /admin/codex-set-thread 原地新建 thread 并
  //             重挂 pane；hive 不可用时才 fallback 到 TUI `/clear`。
  // Alt+X:claude 会话原地变身 codex(官方 transfer 导入完整历史);再按变回
  // claude(resume 原 jsonl + 通过 CLI 启动首条消息交接 codex 增量记录)。
  ipcMain.handle('session:transfer-codex', async (_event, id: string) => {
    const session = sessionRepo.listSessions().find((s) => s.id === id)
    if (!session) return { success: false, message: '会话不存在' }
    if (transferring.has(id)) return { success: false, message: '转移进行中,别急喵' }
    transferring.add(id)
    try {
      // —— 变回 claude(toggle back) ——
      // transferOrigin 有两态:in-codex 快照{tool,externalSessionId,transferredAt}
      // 和变回后的复用指纹{lastCodexThreadId,jsonlSize,jsonlMtime}。只有前者
      // 才进变回分支;指纹态要落到下面的变身分支去消费(此前误判成"快照损坏")。
      let origin: { tool?: string; externalSessionId?: string; transferredAt?: string } = {}
      try { origin = JSON.parse(session.transferOrigin || '{}') } catch { /* 当无快照 */ }
      if (origin.tool && origin.externalSessionId) {
        // codex 期间的增量 → 移交文档(先生成,session.externalSessionId 此刻还是 codex threadId)
        const codexThreadId = session.externalSessionId
        sendTransferProgress(id, 'handoff')
        let handoff: ReturnType<typeof buildCodexHandoff> = null
        try { handoff = buildCodexHandoff(codexThreadId, origin.transferredAt || '') } catch { /* 无增量不阻断 */ }
        sessionRepo.updateSessionTool(id, origin.tool)
        sessionRepo.updateSessionExternalId(id, origin.externalSessionId)
        // 留下"变回时刻"的 jsonl 指纹:下次变身时若 jsonl 未变(claude 侧零新内容,
        // 含 handoff 启动消息——消息会进入 jsonl,自动导向重新 transfer),直接复用本轮
        // codex thread,零 transfer 零新孤儿(防横跳滚雪球)。
        let backState = ''
        try {
          const jsonlBack = claudeJsonlPath(origin.externalSessionId, session.cwd)
          if (jsonlBack) {
            const st = statSync(jsonlBack)
            backState = JSON.stringify({ lastCodexThreadId: codexThreadId, jsonlSize: st.size, jsonlMtime: Math.floor(st.mtimeMs) })
          }
        } catch { /* 无指纹→下次照常 transfer */ }
        sessionRepo.updateSessionTransferOrigin(id, backState)
        linkProjectRules(session.cwd, 'claude')
        // hive tool 显式切回 claude(≥0.7.7 的 --switch-tool 防护闸开口),同时
        // 触发 hive 杀掉本会话的 codex daemon,推送路由回 claude MCP 通道。
        // 失败不阻断变回(只影响推送)。
        if (getCodexHiveBridge() && await hiveSupportsSwitchTool()) {
          await registerCodexAgent({ key: session.id, displayName: session.title, projectDir: session.cwd || undefined, tool: 'claude', switchTool: true })
        }
        const updated = sessionRepo.listSessions().find((s) => s.id === id)!
        const initialPrompt = handoff
          ? `请读 ${handoff.file} —— 这是本会话转交 Codex 期间的工作记录(${handoff.turns} 条),读完继续接手。`
          : undefined
        sendTransferProgress(id, 'restart')
        await restartSessionPane(updated, initialPrompt)
        log('transfer', `${session.title}: back to ${origin.tool} (${origin.externalSessionId.slice(0, 8)})${handoff ? ` +handoff(${handoff.turns})` : ''}`)
        return { success: true, message: handoff ? `已变回 claude,Codex 记录(${handoff.turns} 条)已随启动消息交接` : '已变回 claude 会话' }
      }
      // —— claude → codex ——
      if (session.tool !== 'claude') return { success: false, message: '只支持 claude 会话转给 codex' }
      if (!session.externalSessionId) return { success: false, message: '会话还没有对话历史,无法转移' }
      const jsonl = claudeJsonlPath(session.externalSessionId, session.cwd)
      if (!jsonl) return { success: false, message: '找不到会话历史文件(还没发过消息?)' }
      // 上次变回时的指纹仍匹配(claude 侧零新内容)→ 复用旧 thread,零 transfer
      sendTransferProgress(id, 'scan')
      let threadId = ''
      let reused = false
      let jsonlStat: { size: number; mtimeMs: number } | null = null
      try { jsonlStat = statSync(jsonl) } catch { /* stat 失败当普通路径 */ }
      try {
        const prev = JSON.parse(session.transferOrigin || '{}')
        if (jsonlStat && prev.lastCodexThreadId && prev.jsonlSize === jsonlStat.size && prev.jsonlMtime === Math.floor(jsonlStat.mtimeMs)) {
          threadId = prev.lastCodexThreadId
          reused = true
        }
      } catch { /* 指纹损坏当不匹配 */ }

      // —— 大会话降级:全量 import 会废掉 codex thread → 近期对话+项目文档交接 ——
      // 判定按消息 token 预扫(文件大小是弱指标:工具噪音占比因会话而异)
      const tooBig = !threadId && jsonlStat && (
        jsonlStat.size > TRANSFER_SIZE_SHORTCUT ||
        scanClaudeMessageTokens(jsonl, TRANSFER_TOKEN_CAP) > TRANSFER_TOKEN_CAP
      )
      if (tooBig) {
        sendTransferProgress(id, 'handoff')
        const recent = buildClaudeRecentHandoff(jsonl, session.cwd)
        if (!recent) return { success: false, message: '会话过大且无法生成交接文档' }
        sessionRepo.updateSessionTransferOrigin(id, JSON.stringify({
          tool: 'claude',
          externalSessionId: session.externalSessionId,
          transferredAt: new Date().toISOString(),
        }))
        sessionRepo.updateSessionTool(id, 'codex')
        let newThreadId = ''
        if (getCodexHiveBridge()) {
          // bridge:让 daemon 开全新 thread,restartSessionPane 直连分支即刻 attach
          const reg = await registerCodexAgent({ key: session.id, displayName: session.title, projectDir: session.cwd || undefined, switchTool: await hiveSupportsSwitchTool() })
          if (reg.success && reg.agentId) {
            sessionRepo.updateSessionHiveAgentId(id, reg.agentId)
            const r2 = await codexSetThread(reg.agentId, null)
            if (r2.kind === 'ok' || r2.kind === 'resumed_as_new') newThreadId = r2.threadId
          }
        }
        sessionRepo.updateSessionExternalId(id, newThreadId)
        // ext 为空(非 bridge / daemon 失败)时借 cleared 标记让重启走 'new',
        // 否则 restartMode 会 'continue'(codex resume --last 挂错会话)
        if (!newThreadId) markCleared(id)
        linkProjectRules(session.cwd, 'codex')
        const updatedD = sessionRepo.listSessions().find((s) => s.id === id)!
        const memoryPrompt = buildClaudeMemoryStartupPrompt(jsonl, session.cwd)
        const initialPrompt = [
          `请读 ${recent.file} —— 原 Claude 会话过大未全量导入,这是近期对话与项目文档指引,读完接手。`,
          memoryPrompt,
        ].filter(Boolean).join('\n\n')
        sendTransferProgress(id, 'restart')
        await restartSessionPane(updatedD, initialPrompt)
        // 不能立即 clearMark:新 TUI 的 rollout 未落盘前解禁,盲回填会按 mtime
        // 抢先认领 cwd 下的旧 thread(如刚废弃的全量 import)→ 重启 resume 错线程。
        // 改为轮询 pane 实况,拿到真 thread 再绑定+解禁。
        if (!newThreadId) bindFreshCodexThread(id)
        log('transfer', `${session.title}: degraded handoff (${Math.round(jsonlStat.size / 1048576)}MB jsonl, ${recent.turns} turns)`)
        return { success: true, message: `会话较大,已用近期上下文交接 Codex(${recent.turns} 条)~ 再按 Alt+X 可变回` }
      }

      if (!threadId) {
        const companion = findCodexCompanion()
        if (!companion) return { success: false, message: '未找到支持 transfer 的 codex 插件(需 ≥1.0.6)' }
        sendTransferProgress(id, 'transfer')
        log('transfer', `${session.title}: transferring ${session.externalSessionId.slice(0, 8)} → codex…`)
        const r = await runCodexTransfer(companion, jsonl, session.cwd)
        if (!r.threadId) return { success: false, message: `转移失败: ${r.error}` }
        threadId = r.threadId
      }
      sessionRepo.updateSessionTransferOrigin(id, JSON.stringify({
        tool: 'claude',
        externalSessionId: session.externalSessionId,
        transferredAt: new Date().toISOString(),
      }))
      sessionRepo.updateSessionTool(id, 'codex')
      sessionRepo.updateSessionExternalId(id, threadId)
      linkProjectRules(session.cwd, 'codex')
      // hive tool 显式切到 codex(防护闸开口),restartSessionPane 里的常规
      // register 彼时 tool 已一致不会再被闸挡;hive 同时联动拉起 daemon
      if (getCodexHiveBridge() && await hiveSupportsSwitchTool()) {
        await registerCodexAgent({ key: session.id, displayName: session.title, projectDir: session.cwd || undefined, switchTool: true })
      }
      const updated = sessionRepo.listSessions().find((s) => s.id === id)!
      const initialPrompt = buildClaudeMemoryStartupPrompt(jsonl, session.cwd)
      // bridge 开走 bridge(daemon setThread),关则 codex resume —— 全复用重启逻辑
      sendTransferProgress(id, 'restart')
      await restartSessionPane(updated, initialPrompt)
      log('transfer', `${session.title}: → codex thread ${threadId.slice(0, 8)}${reused ? ' (reused)' : ''}`)
      return { success: true, message: reused ? '已切回 Codex(复用上次线程)~ 再按 Alt+X 可变回' : '已转交给 Codex 喵~ 再按 Alt+X 可变回' }
    } finally {
      transferring.delete(id)
    }
  })

  ipcMain.handle('session:clear-conversation', async (_event, id: string) => {
    const session = sessionRepo.listSessions().find((s) => s.id === id)
    if (!session) return { success: false, message: '会话不存在' }
    if (!tmux.isSessionAlive(session.tmuxName)) {
      return { success: false, message: '会话未运行，无法清空' }
    }
    // Use the safe resolver so a cleared session with a lost pane_id doesn't
    // send /clear (or respawn) into a sibling session's pane.
    const target = resolveRestartPaneTarget(session)
      ?? resolvePaneTarget(session.tmuxName, session.mainPane || '0.0')

    if (session.tool === 'claude') {
      try {
        // C-u 先清掉输入框里的既有草稿 —— send-keys 是往输入框追加字符,若有
        // 未提交草稿,"/clear" 会拼到草稿末尾变成普通消息(不在行首=不是命令),
        // claude 实际没清空而 kitty 已清 DB + markCleared,状态分裂;此时重启
        // 会走 new 起空白会话,用户丢上下文(管家 79MB 事故的根因)。
        execSync(`${tmux.TMUX} send-keys -t "${target}" C-u`, { stdio: 'ignore' })
        execSync(`${tmux.TMUX} send-keys -t "${target}" "/clear" Enter`, { stdio: 'ignore' })
      } catch (err: any) {
        return { success: false, message: err?.message || '发送 /clear 失败' }
      }
      // Clear cache + mark as cleared. The mark stops syncExternalSessionIds
      // from backfilling the OLD jsonl (the new one isn't on disk until the
      // user's first message) and makes a pre-hook restart start fresh instead
      // of `claude -c`-ing the old one. The wakeup Stop hook lifts the mark
      // once the genuinely-new jsonl is reported.
      sessionRepo.updateSessionExternalId(session.id, '')
      markCleared(session.id)
      log('session', `clear-conversation (claude): ${session.title}`)
      return { success: true, message: '已清空对话，新 jsonl 由 hook 同步' }
    }

    if (session.tool === 'codex') {
      // Codex + bridge: call hive /admin/codex-set-thread {thread_id: null} →
      // daemon resets to a fresh thread atomically, returns new ws_url. Then
      // respawn the pane bound to the new thread via --remote. This keeps the
      // hive agent identity (agent_id, display_name, team) unchanged.
      if (getCodexHiveBridge() && session.hiveAgentId) {
        const r = await codexSetThread(session.hiveAgentId, null)
        if (r.kind === 'ok' || r.kind === 'resumed_as_new') {
          sessionRepo.updateSessionExternalId(session.id, r.threadId)
          const launch = generateCodexRemoteScript(r.wsUrl, r.threadId, session.cwd || undefined, '🔄 重置对话中…')
          let envFlags = ` -e "HIVE_AGENT_KEY=${session.id}"`
          envFlags += ` -e "HIVE_AGENT_NAME=${String(session.title || '').replace(/"/g, '\\"')}"`
          try {
            execSync(`${tmux.TMUX} respawn-pane -k${envFlags} -t "${target}" "${launch}"`, { stdio: 'ignore' })
          } catch (err: any) {
            return { success: false, message: `respawn-pane 失败: ${err?.message || err}` }
          }
          log('session', `clear-conversation (codex bridge): ${session.title} → ${r.threadId.slice(0, 8)}`)
          return { success: true, message: '已开新对话，daemon 已同步' }
        }
        if (r.kind === 'timeout') {
          log('session', `clear-conversation (codex): daemon timeout, fallback to send-keys`)
        } else {
          // 'error' — hive API likely not deployed yet (v0.7.2 pending). Fall back.
          log('session', `clear-conversation (codex): hive API error: ${r.message}, fallback to send-keys`)
        }
      }
      // Fallback: just send /clear to the TUI. Documented limitation pre-API:
      // daemon stays on old thread, hive pushes land there until next bridge
      // restart picks up daemon's actual thread_id.
      try {
        // C-u 先清草稿,防 "/clear" 拼进未提交文本变普通消息(同 claude 分支)
        execSync(`${tmux.TMUX} send-keys -t "${target}" C-u`, { stdio: 'ignore' })
        execSync(`${tmux.TMUX} send-keys -t "${target}" "/clear" Enter`, { stdio: 'ignore' })
      } catch (err: any) {
        return { success: false, message: err?.message || '发送 /clear 失败' }
      }
      log('session', `clear-conversation (codex, soft): ${session.title}`)
      return { success: true, message: '已清空（hive 端未同步，可能丢推送）' }
    }

    if (session.tool === 'opencode') {
      const previousExternalId = session.externalSessionId
      sessionRepo.updateSessionExternalId(session.id, '')
      markCleared(session.id)
      try {
        await restartSessionPane({ ...session, externalSessionId: '' })
      } catch (err: any) {
        clearMark(session.id)
        sessionRepo.updateSessionExternalId(session.id, previousExternalId)
        return { success: false, message: err?.message || '启动 OpenCode 新对话失败' }
      }
      log('session', `clear-conversation (opencode): ${session.title}`)
      return { success: true, message: '已启动 OpenCode 新对话，session id 将自动同步' }
    }

    return { success: true, message: '已清空对话' }
  })

  // Restart all alive sessions in one go
  ipcMain.handle('session:restart-all', async () => {
    const rows = sessionRepo.listSessions()
    let ok = 0, fail = 0
    for (const session of rows) {
      if (session.hidden) continue
      if (!tmux.isSessionAlive(session.tmuxName)) continue
      try {
        await restartSessionPane(session)
        ok++
      } catch (err) {
        log('session', `restart-all: failed for ${session.title}:`, err)
        fail++
      }
    }
    log('session', `restart-all: ok=${ok} fail=${fail}`)
    return { ok, fail }
  })

  // Restart all sessions in a given group
  ipcMain.handle('group:restart-sessions', async (_event, groupId: string) => {
    const rows = sessionRepo.listSessions().filter(s => s.groupId === groupId)
    let ok = 0, fail = 0
    for (const session of rows) {
      if (session.hidden) continue
      if (!tmux.isSessionAlive(session.tmuxName)) continue
      try {
        await restartSessionPane(session)
        ok++
      } catch (err) {
        log('session', `group-restart: failed for ${session.title}:`, err)
        fail++
      }
    }
    log('session', `group-restart: group=${groupId} ok=${ok} fail=${fail}`)
    return { ok, fail }
  })

  // Get session env vars (returns object)
  ipcMain.handle('session:get-env', (_event, id: string) => {
    const row = sessionRepo.listSessions().find(s => s.id === id)
    if (!row) return {}
    try {
      return row.env ? JSON.parse(row.env) : {}
    } catch {
      return {}
    }
  })

  // Set session env vars
  ipcMain.handle('session:set-env', (_event, id: string, env: Record<string, string>) => {
    sessionRepo.updateSessionEnv(id, JSON.stringify(env || {}))
    return { success: true }
  })

  // Get per-session launch args (CLI flags appended after global toolArgs)
  ipcMain.handle('session:get-launch-args', (_event, id: string) => {
    const raw = (sessionRepo.listSessions().find(s => s.id === id)?.launchArgs || '').trim()
    if (raw.startsWith('{')) {
      try {
        const p = JSON.parse(raw) as Record<string, string>
        return { claude: p?.claude || '', codex: p?.codex || '', opencode: p?.opencode || '' }
      } catch { return { claude: '', codex: '', opencode: '' } }
    }
    return { claude: raw, codex: '', opencode: '' } // 旧格式归 claude
  })

  // Set per-session launch args
  ipcMain.handle('session:set-launch-args', (_event, id: string, args: { claude?: string; codex?: string; opencode?: string }) => {
    const claude = String(args?.claude || '').trim()
    const codex = String(args?.codex || '').trim()
    const opencode = String(args?.opencode || '').trim()
    sessionRepo.updateSessionLaunchArgs(id, claude || codex || opencode ? JSON.stringify({ claude, codex, opencode }) : '')
    return { success: true }
  })

  // Delete an external CLI session file (claude / codex / ...)
  ipcMain.handle('session:delete-external-session', (_event, tool: string, projectDir: string, sessionId: string) => {
    const provider = getProvider(tool)
    if (!provider) return { success: false }
    try { provider.deleteSessionFile(sessionId, projectDir) } catch { /* ignore */ }
    return { success: true }
  })

  // Sync tmux state with DB
  ipcMain.handle(IPC.SESSION_SYNC, () => {
    return syncAndList()
  })

  // --- Group management ---
  ipcMain.handle('group:list', () => {
    return sessionRepo.listGroups()
  })

  ipcMain.handle('group:create', (_event, name: string, color?: string, parentGroupId?: string) => {

    const id = uuid().slice(0, 8)
    sessionRepo.createGroup(id, name, color, parentGroupId)
    return { id, name, color, parentGroupId }
  })

  ipcMain.handle('group:delete', (_event, groupId: string) => {
    sessionRepo.deleteGroup(groupId)
  })

  ipcMain.handle('group:rename', (_event, groupId: string, name: string) => {
    sessionRepo.renameGroup(groupId, name)
  })

  ipcMain.handle('group:set-color', (_event, groupId: string, color: string | null) => {
    sessionRepo.updateGroupColor(groupId, color)
  })

  ipcMain.handle('group:set-parent', (_event, groupId: string, parentGroupId: string | null) => {
    sessionRepo.updateGroupParent(groupId, parentGroupId)
    return { success: true }
  })

  // 归档:kill 组内全部 tmux(保留 DB 记录,status→dead),标记 archived。
  // group:list 只返回未归档 → 主界面自动收起;数据完整可恢复。
  ipcMain.handle('group:archive', (_event, groupId: string) => {
    const group = sessionRepo.getGroupById(groupId)
    if (!group) throw new Error('Group not found')
    const subtree = sessionRepo.listGroupSubtreeIds(groupId)
    let count = 0
    for (const id of subtree) {
      const rows = sessionRepo.listSessionsByGroup(id)
      count += rows.length
      for (const s of rows) {
        try { killSessionTmux(s) } catch { /* tmux 可能已死 */ }
        sessionRepo.updateSessionStatus(s.id, 'dead')
      }
      sessionRepo.setGroupArchived(id, true)
    }
    log('group', `archived subtree: ${group.name} (${count} sessions, ${subtree.length} groups)`)
    return { success: true, count }
  })

  // 取消归档:清标记 + 组内 dead→detached(dead 在主界面不渲染,detached 可见;
  // 点击 detached 会话时走现有 attach 的 on-the-fly restore 重建 tmux)
  ipcMain.handle('group:unarchive', (_event, groupId: string) => {
    for (const id of sessionRepo.listGroupSubtreeIds(groupId)) {
      sessionRepo.setGroupArchived(id, false)
      for (const s of sessionRepo.listSessionsByGroup(id)) {
        if (s.status === 'dead') sessionRepo.updateSessionStatus(s.id, 'detached')
      }
    }
    return { success: true }
  })

  ipcMain.handle('group:list-archived', () => {
    return sessionRepo.listArchivedGroups().map((g) => ({
      ...g,
      sessionCount: sessionRepo.listGroupSubtreeIds(g.id)
        .reduce((total, id) => total + sessionRepo.listSessionsByGroup(id).length, 0),
    }))
  })

  ipcMain.handle('session:set-group', (_event, sessionId: string, groupId: string | null) => {
    const rows = sessionRepo.listSessions()
    const session = rows.find((s) => s.id === sessionId)
    if (!session) throw new Error('Session not found')

    const oldGroupId = session.groupId

    // Find the actual tmux session hosting this session's pane
    let hostTmux = session.tmuxName
    if (!tmux.isSessionAlive(hostTmux) && oldGroupId) {
      const oldGroupSessions = sessionRepo.listSessionsByGroup(oldGroupId)
        .filter(s => tmux.isSessionAlive(s.tmuxName))
      if (oldGroupSessions.length > 0) hostTmux = oldGroupSessions[0].tmuxName
    }

    // Detach the row from its current pane and start it as a fresh standalone
    // tmux session. Used when ungrouping or when a join target doesn't exist.
    // We can't safely `tmux break-pane` into a new session (break-pane defaults
    // to same-session new-window), so we kill the pane and restore from cwd.
    const detachAsStandalone = (sourcePaneId: string): void => {
      const newName = `kitty_${uuid().slice(0, 8)}`
      if (sourcePaneId) {
        try { execSync(`${tmux.TMUX} kill-pane -t ${sourcePaneId}`, { stdio: 'ignore' }) } catch { /* ignore */ }
      }
      const db = getDB()
      db.prepare("UPDATE sessions SET tmux_name = ?, pane_id = ? WHERE id = ?").run(newName, '', sessionId)
      const refreshed = sessionRepo.listSessions().find(s => s.id === sessionId)
      if (refreshed) tryRestoreSession(refreshed)
    }

    if (tmux.isSessionAlive(hostTmux)) {
      // Use stored paneId for precise matching
      const sourcePaneId = session.paneId || ''

      try {
        if (sourcePaneId && groupId) {
          const targetGroupSessions = sessionRepo.listSessionsByGroup(groupId)
            .filter(s => !s.hidden && s.id !== sessionId && tmux.isSessionAlive(s.tmuxName))
          const targetHost = targetGroupSessions[0]

          if (targetHost) {
            const targetPanes = execSync(
              `${tmux.TMUX} list-panes -t "${targetHost.tmuxName}" -F '#{pane_id}'`,
              { encoding: 'utf-8' }
            ).trim().split('\n')
            const targetLastPane = targetPanes[targetPanes.length - 1]
            execSync(`${tmux.TMUX} join-pane -s ${sourcePaneId} -t ${targetLastPane} -v`, { stdio: 'ignore' })
            const newPanes = execSync(
              `${tmux.TMUX} list-panes -t "${targetHost.tmuxName}" -F '#{pane_id}'`,
              { encoding: 'utf-8' }
            ).trim().split('\n')
            sessionRepo.updateSessionPaneId(sessionId, newPanes[newPanes.length - 1])
            const db = getDB()
            db.prepare("UPDATE sessions SET tmux_name = ? WHERE id = ?").run(targetHost.tmuxName, sessionId)
            tmux.applyMainVerticalLayout(targetHost.tmuxName)
            if (tmux.isSessionAlive(hostTmux) && tmux.getPaneCount(hostTmux) > 1) {
              tmux.applyMainVerticalLayout(hostTmux)
            }
          } else {
            // Target group has no live host yet — promote this row to a fresh standalone
            // session so it later acts as the host once siblings join.
            detachAsStandalone(sourcePaneId)
          }
        } else if (sourcePaneId && !groupId) {
          // Plain ungroup
          detachAsStandalone(sourcePaneId)
        } else if (!sourcePaneId && groupId && tmux.isSessionAlive(session.tmuxName)) {
          // Standalone session (no pane_id), join it whole into the target group
          const targetGroupSessions = sessionRepo.listSessionsByGroup(groupId)
            .filter(s => !s.hidden && s.id !== sessionId && tmux.isSessionAlive(s.tmuxName))
          const targetHost = targetGroupSessions[0]
          if (targetHost) {
            tmux.joinSessionAsPane(session.tmuxName, targetHost.tmuxName)
            const newPanes = execSync(
              `${tmux.TMUX} list-panes -t "${targetHost.tmuxName}" -F '#{pane_id}'`,
              { encoding: 'utf-8' }
            ).trim().split('\n')
            sessionRepo.updateSessionPaneId(sessionId, newPanes[newPanes.length - 1])
            const db = getDB()
            db.prepare("UPDATE sessions SET tmux_name = ? WHERE id = ?").run(targetHost.tmuxName, sessionId)
            tmux.applyMainVerticalLayout(targetHost.tmuxName)
          }
          // No target host: leave the standalone session as-is, it'll be promoted
          // to host on next group action.
        }
      } catch (err) {
        // tmux operation failed — DON'T flip group_id, otherwise DB says "moved"
        // while tmux still has the pane in the old group. Bubble up to renderer.
        log('pane-mode', `move pane between groups failed:`, err)
        throw err
      }
    }

    // Commit DB group_id only after tmux ops succeeded (or were trivially skipped).
    sessionRepo.updateSessionGroup(sessionId, groupId)
    tmux.refreshAllStatusBars()
  })

  ipcMain.handle('session:set-hidden', (_event, sessionId: string, hidden: boolean) => {
    const session = sessionRepo.listSessions().find(s => s.id === sessionId)
    sessionRepo.updateSessionHidden(sessionId, hidden)

    // Kill/restore the corresponding pane
    if (session) {
      if (hidden) {
        const groupSessions = session.groupId
          ? sessionRepo.listSessionsByGroup(session.groupId).filter(s => tmux.isSessionAlive(s.tmuxName))
          : []
        const hostTmux = groupSessions[0]?.tmuxName || session.tmuxName
        if (tmux.isSessionAlive(hostTmux)) {
          let targetPane = session.paneId || ''
          // Fallback: match by cwd if paneId not stored
          if (!targetPane && session.cwd) {
            try {
              const panes = execSync(
                `${tmux.TMUX} list-panes -t "${hostTmux}" -F '#{pane_id} #{pane_current_path}'`,
                { encoding: 'utf-8' }
              ).trim().split('\n')
              for (const line of panes) {
                const [pid, ...pp] = line.split(' ')
                if (pp.join(' ') === session.cwd) { targetPane = pid; break }
              }
            } catch { /* ignore */ }
          }
          if (targetPane) {
            try {
              execSync(`${tmux.TMUX} kill-pane -t ${targetPane}`, { stdio: 'ignore' })
              if (tmux.getPaneCount(hostTmux) > 1) {
                tmux.applyMainVerticalLayout(hostTmux)
              }
            } catch { /* ignore */ }
          }
        }
      } else {
        // Unhide: restore pane in background so IPC returns fast for UI refresh
        const sid = sessionId
        const sCwd = session.cwd
        const sTool = session.tool
        const sTmuxName = session.tmuxName
        const gid = session.groupId
        const sLaunchArgs = launchArgsFor(session)
        const sEnv = session.env
        const sTitle = session.title
        setTimeout(() => {
          try {
            if (gid) {
              // Grouped: re-join as a pane in the group's host session
              const groupSessions = sessionRepo.listSessionsByGroup(gid)
                .filter(s => s.id !== sid && !s.hidden && tmux.isSessionAlive(s.tmuxName))
              const hostTmux = groupSessions[0]?.tmuxName
              if (hostTmux && sCwd && existsSync(sCwd)) {
                const tempName = `kitty_tmp_${Date.now()}`
                const script = generateLaunchScript(sTool || 'claude', 'restore', undefined, undefined, undefined, sLaunchArgs)
                prepareProjectForTool(sCwd, sTool || 'claude', script)
                injectHiveIdentity(script, sid, sTitle || '')
                injectSessionEnv(script, sEnv)
                execSync(
                  `${tmux.TMUX} new-session -d -s "${tempName}" -c "${sCwd}" "${script}"`,
                  { stdio: 'ignore', env: tmux.tmuxSpawnEnv() }
                )
                tmux.joinSessionAsPane(tempName, hostTmux)
                const newPanes = execSync(
                  `${tmux.TMUX} list-panes -t "${hostTmux}" -F '#{pane_id}'`,
                  { encoding: 'utf-8' }
                ).trim().split('\n')
                sessionRepo.updateSessionPaneId(sid, newPanes[newPanes.length - 1])
                getDB().prepare("UPDATE sessions SET tmux_name = ? WHERE id = ?").run(hostTmux, sid)
                sessionRepo.updateSessionStatus(sid, 'detached')
                tmux.applyMainVerticalLayout(hostTmux)
              }
            } else {
              // Ungrouped: rebuild standalone tmux session if the old one is gone
              if (sTmuxName && !tmux.isSessionAlive(sTmuxName) && sCwd && existsSync(sCwd)) {
                const script = generateLaunchScript(sTool || 'claude', 'restore', undefined, undefined, undefined, sLaunchArgs)
                prepareProjectForTool(sCwd, sTool || 'claude', script)
                injectHiveIdentity(script, sid, sTitle || '')
                injectSessionEnv(script, sEnv)
                execSync(
                  `${tmux.TMUX} new-session -d -s "${sTmuxName}" -c "${sCwd}" "${script}"`,
                  { stdio: 'ignore', env: tmux.tmuxSpawnEnv() }
                )
                tmux.applyKittyStatusBar(sTmuxName)
                sessionRepo.updateSessionStatus(sid, 'detached')
              } else if (tmux.isSessionAlive(sTmuxName)) {
                sessionRepo.updateSessionStatus(sid, 'detached')
              }
            }
          } catch (err) {
            log('pane-mode', `unhide restore failed:`, err)
          }
        }, 0)
      }
    }

    tmux.refreshAllStatusBars()
  })

  // --- Ntfy ---
  ipcMain.handle(IPC.NTFY_TOPIC_GET, () => {
    return getNtfyTopic()
  })

  ipcMain.handle(IPC.NTFY_TOPIC_SET, (_event, topic: string) => {
    setNtfyTopic(topic)
    ntfy.updateTopic(topic)
  })

  // --- Codex hive bridge (path B) toggle ---
  ipcMain.handle('config:codex-hive-bridge:get', () => getCodexHiveBridge())
  ipcMain.handle('config:codex-hive-bridge:set', (_event, enabled: boolean) => {
    setCodexHiveBridge(!!enabled)
    return { success: true }
  })

  ipcMain.handle(IPC.SESSION_CREATE_IN_GROUP, (_event, groupId: string) => {
    ensureReady('claude')

    const group = sessionRepo.getGroupById(groupId)
    if (!group) throw new Error('Group not found')

    // Pick an ALIVE, non-hidden host session in the group to split into.
    // Prefer the group's main session; fall back to any other alive one.
    const allGroupSessions = sessionRepo.listSessionsByGroup(groupId)
    const aliveGroupSessions = allGroupSessions.filter(s => !s.hidden && tmux.isSessionAlive(s.tmuxName))
    const hostSession = aliveGroupSessions.find(s => s.id === group.mainSessionId) || aliveGroupSessions[0]

    // Use a fresh session dir so claude starts a new conversation
    const freshId = uuid().slice(0, 8)
    const freshCwd = join(homedir(), '.kitty-kitty', 'sessions', freshId)
    mkdirSync(freshCwd, { recursive: true })

    const script = generateLaunchScript('claude', 'new')

    if (hostSession) {
      // Split into the group's tmux session
      const hostTmuxName = hostSession.tmuxName
      const isFirstSplit = tmux.getPaneCount(hostTmuxName) === 1
      const title = `${group.name} agent`
      const paneId = tmux.createPaneInSession(
        hostTmuxName,
        script,
        isFirstSplit,
        freshCwd,
        { key: freshId, name: title },
      )

      const session: tmux.TmuxSession = {
        id: freshId,
        tmuxName: hostTmuxName,
        title,
        tool: 'claude',
        cwd: freshCwd,
        status: 'running',
        createdAt: new Date().toISOString(),
      }
      sessionRepo.saveSession(session)
      sessionRepo.updateSessionPaneId(freshId, paneId)
      sessionRepo.updateSessionGroup(freshId, groupId)

      if (!group.mainSessionId) {
        sessionRepo.setGroupMainSession(groupId, hostSession.id)
      }

      try { tmux.applyMainVerticalLayout(hostTmuxName) } catch { /* ignore */ }
      tmux.focusSession(hostTmuxName)
      tmux.refreshAllStatusBars()
      return toSessionInfo(session)
    }

    // No alive host in the group: create a standalone tmux session and attach it to the group
    const session = tmux.createTmuxSession('claude', undefined, freshCwd, script)
    sessionRepo.saveSession(session)
    try {
      const newPaneId = execSync(
        `${tmux.TMUX} list-panes -t "${session.tmuxName}" -F '#{pane_id}'`,
        { encoding: 'utf-8' }
      ).trim().split('\n')[0]
      if (newPaneId) sessionRepo.updateSessionPaneId(session.id, newPaneId)
    } catch { /* ignore */ }
    sessionRepo.updateSessionGroup(session.id, groupId)

    if (!group.mainSessionId) {
      sessionRepo.setGroupMainSession(groupId, session.id)
    }

    tmux.applyKittyStatusBar(session.tmuxName)
    tmux.attachSession(session.tmuxName)
    tmux.refreshAllStatusBars()
    return toSessionInfo(session)
  })

  ipcMain.handle(IPC.GROUP_SET_MAIN_SESSION, (_event, groupId: string, sessionId: string) => {
    sessionRepo.setGroupMainSession(groupId, sessionId)

    syncPaneIds()
    const session = sessionRepo.listSessions().find(s => s.id === sessionId)
    if (!session?.paneId || !tmux.isSessionAlive(session.tmuxName)) return { success: true }

    try {
      tmux.swapMainPane(session.tmuxName, session.paneId)
      tmux.applyMainVerticalLayout(session.tmuxName)
    } catch (err) {
      log('pane-mode', `swap main pane failed:`, err)
    }
    return { success: true }
  })
}

function migrateToPane(): void {
  const groups = sessionRepo.listGroups()
  for (const group of groups) {
    // Only consider visible, alive sessions with unique tmux names
    const sessions = sessionRepo.listSessionsByGroup(group.id)
      .filter(s => !s.hidden && tmux.isSessionAlive(s.tmuxName))
    const uniqueSessions = sessions.filter((s, i, arr) =>
      arr.findIndex(x => x.tmuxName === s.tmuxName) === i
    )
    if (uniqueSessions.length <= 1) continue

    const mainSession = uniqueSessions.find(s => s.id === group.mainSessionId) || uniqueSessions[0]
    const others = uniqueSessions.filter(s => s.tmuxName !== mainSession.tmuxName)

    // Kill extra panes on main session first
    const mainPanes = tmux.getPaneCount(mainSession.tmuxName)
    if (mainPanes > 1) {
      try {
        const panes = execSync(
          `${tmux.TMUX} list-panes -t "${mainSession.tmuxName}" -F '#{pane_id}'`,
          { encoding: 'utf-8' }
        ).trim().split('\n')
        for (let p = panes.length - 1; p >= 1; p--) {
          try { execSync(`${tmux.TMUX} kill-pane -t ${panes[p]}`, { stdio: 'ignore' }) } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }

    const joinedIds: string[] = []
    for (const other of others) {
      try {
        // Kill extra panes in source session first (keep only the main pane 0.0)
        const srcPaneCount = tmux.getPaneCount(other.tmuxName)
        if (srcPaneCount > 1) {
          const srcPanes = execSync(
            `${tmux.TMUX} list-panes -t "${other.tmuxName}" -F '#{pane_id}'`,
            { encoding: 'utf-8' }
          ).trim().split('\n')
          for (let p = srcPanes.length - 1; p >= 1; p--) {
            try { execSync(`${tmux.TMUX} kill-pane -t ${srcPanes[p]}`, { stdio: 'ignore' }) } catch { /* ignore */ }
          }
        }
        tmux.joinSessionAsPane(other.tmuxName, mainSession.tmuxName)
        const db = getDB()
        // Update by row id only — `WHERE tmux_name = ?` previously could cross-update
        // sessions in OTHER groups that happened to share the same tmux_name.
        db.prepare("UPDATE sessions SET tmux_name = ? WHERE id = ?").run(mainSession.tmuxName, other.id)
        joinedIds.push(other.id)
      } catch (err) {
        log('pane-mode', `join failed for ${other.tmuxName}:`, err)
      }
    }

    // Record pane IDs for all sessions after join
    try {
      const allPanes = execSync(
        `${tmux.TMUX} list-panes -t "${mainSession.tmuxName}" -F '#{pane_id}'`,
        { encoding: 'utf-8' }
      ).trim().split('\n')
      // First pane = main session
      sessionRepo.updateSessionPaneId(mainSession.id, allPanes[0])
      // Subsequent panes = joined sessions (in order)
      for (let i = 0; i < joinedIds.length && i + 1 < allPanes.length; i++) {
        sessionRepo.updateSessionPaneId(joinedIds[i], allPanes[i + 1])
      }
    } catch (err) {
      log('pane-mode', `record pane IDs failed for ${mainSession.tmuxName}:`, err)
    }

    tmux.applyMainVerticalLayout(mainSession.tmuxName)

    if (!group.mainSessionId) {
      sessionRepo.setGroupMainSession(group.id, mainSession.id)
    }
  }
}

/**
 * Sync pane_id for ALL non-hidden sessions from actual tmux state.
 * Builds a map of tmux pane_id → cwd, then matches each DB session.
 * Called after every migration and on every sync cycle in pane mode.
 */
function syncPaneIds(): void {
  // Build a global map: pane_id → cwd from all alive tmux sessions
  const paneMap = new Map<string, { tmuxName: string; cwd: string }>()
  for (const s of tmux.listTmuxSessions()) {
    try {
      const panes = execSync(
        `${tmux.TMUX} list-panes -t "${s.name}" -F '#{pane_id} #{pane_current_path}'`,
        { encoding: 'utf-8' }
      ).trim().split('\n')
      for (const line of panes) {
        const [paneId, ...pp] = line.split(' ')
        paneMap.set(paneId, { tmuxName: s.name, cwd: pp.join(' ') })
      }
    } catch { /* ignore */ }
  }

  for (const session of sessionRepo.listSessions()) {
    if (session.hidden || !session.paneId) continue

    // Validate: does this pane_id still exist in tmux?
    if (paneMap.has(session.paneId)) {
      // Pane alive — sync tmux_name if it moved to a different session
      const info = paneMap.get(session.paneId)!
      if (session.tmuxName !== info.tmuxName) {
        getDB().prepare("UPDATE sessions SET tmux_name = ? WHERE id = ?").run(info.tmuxName, session.id)
      }
    } else {
      // Pane gone — clear stale pane_id
      sessionRepo.updateSessionPaneId(session.id, '')
    }
  }
}

/**
 * Spawn a fresh tmux session for `row` and run the appropriate launch script.
 * Returns true on success. Caller decides what to do on failure — never sets
 * `dead` from here; a failed restore is recoverable on next attempt.
 */
function tryRestoreSession(row: sessionRepo.SessionRow): boolean {
  if (!row.cwd || !existsSync(row.cwd)) return false
  try {
    let script: string
    const extraArgs = launchArgsFor(row)
    if (row.externalSessionId) {
      // prebind 会在 jsonl 从未落盘时把 resume 降级为 new+同 id(--session-id),
      // 避免 claude --resume 报 "No conversation found"
      const { sid, mode } = prebindClaudeRelaunch(row, 'resume')
      script = generateLaunchScript(row.tool, mode, mode === 'resume' ? row.externalSessionId : undefined, row.cwd, sid, extraArgs)
    } else {
      // No bound jsonl to resume — pre-bind a fresh id for claude so this restore
      // can't grab a sibling's transcript when the cwd is shared.
      const { sid, mode } = prebindClaudeRelaunch(row, 'restore')
      script = generateLaunchScript(row.tool, mode, undefined, row.cwd, sid, extraArgs)
    }
    prepareProjectForTool(row.cwd, row.tool, script)
    injectHiveIdentity(script, row.id, row.title || '')
    injectSessionEnv(script, row.env)
    execSync(
      `${tmux.TMUX} new-session -d -s "${row.tmuxName}" -c "${row.cwd}" "${script}"`,
      { stdio: ['ignore', 'ignore', 'pipe'], env: tmux.tmuxSpawnEnv() }
    )
    tmux.applyKittyStatusBar(row.tmuxName)
    sessionRepo.updateSessionStatus(row.id, 'detached')
    log('restore', `rebuilt ${row.title} (${row.tmuxName})`)
    return true
  } catch (err) {
    log('restore', `failed for ${row.tmuxName}:`, err)
    return false
  }
}

/**
 * Sync tmux session states with our DB and return updated list.
 * On first sync, auto-restore sessions that were previously alive.
 */
function syncAndList(): SessionInfo[] {
  const liveSessions = tmux.listAllTmuxSessions()
  const liveNames = new Set(liveSessions.map((s) => s.name))
  const liveAttached = new Map(liveSessions.map((s) => [s.name, s.attached]))

  const dbSessions = sessionRepo.listSessions()

  // On first sync, restore sessions that were previously alive
  if (!statusBarsInitialized) {
    statusBarsInitialized = true

    // Reset DB tmux_name to per-row `kitty_<id>` whenever a row's claimed
    // tmux_name doesn't have an actual pane backing it. Two failure modes:
    //   1) Host tmux is gone entirely → all sharers must reset, then restore.
    //   2) Host tmux is alive but its pane count is smaller than the number of
    //      DB rows pointing at it (e.g. user opened in a dir → claude crash →
    //      first-launch only resurrected ONE pane for the whole group). In
    //      that case keep ONE row mapped to the host and reset the rest.
    // After this reset, the per-row restore loop spawns missing tmux sessions
    // and migrateToPane() re-merges siblings back into panes of the host.
    {
      const db = getDB()
      const sharedNames = new Map<string, sessionRepo.SessionRow[]>()
      for (const row of dbSessions) {
        if (row.hidden) continue
        ;(sharedNames.get(row.tmuxName) || sharedNames.set(row.tmuxName, []).get(row.tmuxName)!).push(row)
      }
      for (const [name, rows] of sharedNames) {
        const alivePaneCount = liveNames.has(name) ? tmux.getPaneCount(name) : 0
        if (alivePaneCount >= rows.length) continue  // healthy: each row has a pane
        // Decide which row keeps the existing tmux_name. If host is alive,
        // prefer the group's main session (so the user's pinned host stays
        // attached to the live pane). Otherwise reset everyone.
        let keepId: string | null = null
        if (alivePaneCount > 0) {
          const groupId = rows[0].groupId
          if (groupId) {
            const grp = sessionRepo.getGroupById(groupId)
            const mainId = grp?.mainSessionId
            keepId = mainId && rows.some((r) => r.id === mainId) ? mainId : rows[0].id
          } else {
            keepId = rows[0].id
          }
        }
        for (const row of rows) {
          if (row.id === keepId) continue
          const expected = `kitty_${row.id}`
          if (row.tmuxName !== expected) {
            db.prepare('UPDATE sessions SET tmux_name = ?, pane_id = ? WHERE id = ?').run(expected, '', row.id)
          }
        }
      }
    }

    // Re-read rows now that tmux_name may have been reset
    const rowsForRestore = sessionRepo.listSessions()
    // 归档组的会话不自动复活(归档=kill tmux 留记录,重启必须保持归档态)
    const archivedGroupIds = new Set(sessionRepo.listArchivedGroups().map((g) => g.id))
    for (const row of rowsForRestore) {
      if (row.groupId && archivedGroupIds.has(row.groupId)) continue
      if (!liveNames.has(row.tmuxName) && row.cwd && existsSync(row.cwd) && !row.hidden) {
        if (tryRestoreSession(row)) liveNames.add(row.tmuxName)
      }
    }

    // Merge sessions of the same group into panes
    migrateToPane()
    syncPaneIds()

    // Apply status bar to all live sessions
    for (const name of liveNames) {
      tmux.applyKittyStatusBar(name)
    }
    // Bind global keys once after all status bars are applied
    tmux.refreshAllStatusBars()
  }

  // Normal sync: update status based on tmux state
  // tmux gone → keep as 'detached' (restorable on next launch), NOT 'dead'
  // Only user-initiated kill sets 'dead'
  const refreshedLive = tmux.listAllTmuxSessions()
  const refreshedNames = new Set(refreshedLive.map((s) => s.name))
  const refreshedAttached = new Map(refreshedLive.map((s) => [s.name, s.attached]))

  for (const row of sessionRepo.listSessions()) {
    if (refreshedNames.has(row.tmuxName)) {
      // tmux session is alive — always update status from tmux state
      if (refreshedAttached.get(row.tmuxName)) {
        sessionRepo.updateSessionStatus(row.id, 'running')
      } else {
        sessionRepo.updateSessionStatus(row.id, 'detached')
      }
    } else if (row.status === 'running') {
      // Was running but tmux gone — mark detached (restorable), not dead
      sessionRepo.updateSessionStatus(row.id, 'detached')
    }
    // dead or detached without tmux: keep as-is
  }

  // Keep pane_ids in sync with actual tmux state
  syncPaneIds()

  // Sync external CLI session IDs (claude/codex/...) for live sessions missing them
  syncExternalSessionIds()

  const result = sessionRepo.listSessions().map((row) => ({
    id: row.id,
    tmuxName: row.tmuxName,
    title: row.title,
    tool: row.tool,
    cwd: row.cwd,
    paneId: row.paneId || '',
    status: row.status as SessionInfo['status'],
    createdAt: row.createdAt,
    groupId: row.groupId || undefined,
    groupName: row.groupName || undefined,
    groupColor: row.groupColor || undefined,
    hidden: !!row.hidden,
    roles: row.roles || '',
    expertise: row.expertise || '',
    isGitRepo: row.cwd ? isGitRepository(row.cwd) : false,
  }))
  log('sync', result.map(r => `${r.title}:${r.status}`).join(', '))
  return result
}

/**
 * Backfill `external_session_id` for live sessions that don't have one yet, by
 * asking each tool's provider to find the most-recent on-disk session file
 * matching the session's cwd. Skips sessions whose tool has no on-disk store
 * (e.g. `shell`).
 */
function syncExternalSessionIds(): void {
  const sessions = sessionRepo.listSessions()
  // Skip sessions just cleared (新对话): their new jsonl isn't on disk yet, so
  // backfilling would resurrect the OLD jsonl. The mark is lifted by the
  // wakeup Stop hook once the real new jsonl appears.
  const needsSync = sessions.filter(s => !s.externalSessionId && s.cwd && getProvider(s.tool) && !isCleared(s.id))
  if (needsSync.length === 0) return

  // Already-claimed ids across ALL sessions (avoid double-assignment within kitty)
  const claimed = new Set(sessions.map(s => s.externalSessionId).filter(Boolean))

  // Defense: blind mtime-based claiming can't tell apart >1 unbound session that
  // share one cwd — it would cross-assign their jsonls. Skip those cwds entirely
  // and let the wakeup hook bind them by header instead. (New claude sessions are
  // pre-bound via --session-id, so they normally never reach needsSync at all.)
  const unboundPerCwd = new Map<string, number>()
  for (const s of needsSync) unboundPerCwd.set(s.cwd, (unboundPerCwd.get(s.cwd) || 0) + 1)

  for (const row of needsSync) {
    if ((unboundPerCwd.get(row.cwd) || 0) > 1) {
      log('sync', `skip blind claim: ${unboundPerCwd.get(row.cwd)} unbound sessions share cwd ${row.cwd} (${row.title})`)
      continue
    }
    const provider = getProvider(row.tool)
    if (!provider) continue
    try {
      const id = provider.findUnclaimedSessionId(row.cwd, claimed)
      if (id) {
        sessionRepo.updateSessionExternalId(row.id, id)
        claimed.add(id)
        log('sync', `${row.tool} session ID: ${row.title} → ${id.slice(0, 8)}`)
      }
    } catch { /* ignore */ }
  }
}

function isGitRepository(dir: string): boolean {
  try {
    execSync(`git -C "${dir}" rev-parse --git-dir`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function toSessionInfo(s: tmux.TmuxSession): SessionInfo {
  return {
    id: s.id,
    tmuxName: s.tmuxName,
    title: s.title,
    tool: s.tool,
    cwd: s.cwd,
    paneId: '',
    status: s.status,
    createdAt: s.createdAt,
    isGitRepo: s.cwd ? isGitRepository(s.cwd) : false,
  }
}

/**
 * Pick the launch mode when restarting a pane with no/known external id:
 *   - has externalSessionId          → 'resume' that exact id
 *   - just cleared (新对话), no id    → 'new' — DON'T `claude -c`, which would
 *     resume the OLD jsonl (the cleared session's new jsonl isn't on disk yet)
 *   - otherwise no id                → 'continue' (pick up the latest in cwd,
 *     the normal "reattach to my project" behaviour)
 */
function restartMode(session: sessionRepo.SessionRow): 'resume' | 'new' | 'continue' {
  if (session.externalSessionId) return 'resume'
  if (isCleared(session.id)) return 'new'
  return 'continue'
}

/**
 * For a claude session about to relaunch WITHOUT an exact jsonl to resume
 * (new/continue/restore), pre-bind a fresh --session-id so its transcript is
 * identifiable up front — this is what keeps multiple claude sessions sharing one
 * cwd from cross-assigning each other's history on restart. Returns {sid, mode}
 * to feed straight into generateLaunchScript.
 *
 * A LONE session in its cwd keeps continue/restore (so it still recovers its own
 * most-recent history). Only a cleared session (genuinely new) or a session that
 * shares its cwd with others is forced onto a fresh id — there `claude -c` would
 * otherwise grab a sibling's transcript.
 */
function prebindClaudeRelaunch(
  session: sessionRepo.SessionRow,
  mode: LaunchMode,
): { sid?: string; mode: LaunchMode } {
  if (session.tool !== 'claude') return { mode }
  if (mode === 'resume') {
    // --session-id 预绑定后一条消息都没发过 → jsonl 从未落盘,--resume 必报
    // "No conversation found"。改走 new 并复用同一个 id:不报错,且未来 jsonl
    // 落盘时文件名仍是 DB 里的 id,绑定不破。
    if (session.externalSessionId && session.cwd && !isJsonlInCwd(session.externalSessionId, session.cwd)) {
      log('sync', `resume→new: jsonl ${session.externalSessionId.slice(0, 8)} never landed (${session.title})`)
      return { sid: session.externalSessionId, mode: 'new' }
    }
    return { mode }
  }
  const shareCwd = sessionRepo.listSessions().filter(s => s.cwd === session.cwd).length > 1
  if (mode === 'new' || shareCwd) {
    const sid = uuid()
    sessionRepo.updateSessionExternalId(session.id, sid)
    log('sync', `prebind claude id for ${session.title}: ${sid.slice(0, 8)} (mode ${mode}→new, shareCwd=${shareCwd})`)
    return { sid, mode: 'new' }
  }
  return { mode }
}

const ROLLOUT_UUID_RE = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

/** lsof a pid list and return the open rollout thread ids (newest mtime first). */
function openRolloutThreads(pids: string[]): string[] {
  if (pids.length === 0) return []
  let raw = ''
  try {
    raw = execSync(`lsof -a -p ${pids.join(',')} -Fn`, {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    })
  } catch { return [] }
  const hits = new Map<string, number>()
  for (const line of raw.split('\n')) {
    if (!line.startsWith('n')) continue
    const p = line.slice(1)
    if (!p.includes('/.codex/sessions/') || !p.endsWith('.jsonl')) continue
    const m = p.match(ROLLOUT_UUID_RE)
    if (!m) continue
    let mtime = 0
    try { mtime = statSync(p).mtimeMs } catch { /* ignore */ }
    if ((hits.get(m[1]) ?? -1) < mtime) hits.set(m[1], mtime)
  }
  return [...hits.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0])
}

/**
 * Ground-truth probe: which codex thread is the pane ACTUALLY on right now?
 *
 * The DB's externalSessionId can drift from reality — codex creates threads
 * kitty never hears about (plain `codex` launch, /new or /clear typed in the
 * TUI, soft-clear fallback), and the blind mtime backfill in
 * syncExternalSessionIds can claim a sibling rollout during the gap before a
 * fresh TUI writes its file (管家 事故:降级交接后 sync 认领了废弃的全量
 * import thread,重启 resume 错线程 → 一晚上的对话"消失").
 *
 * Truth sources, in reliability order:
 *   1. The rollout file held OPEN (write fd) by the codex process. For plain
 *      panes that's a descendant of pane_pid; for `--remote` panes the rollout
 *      lives in the hive daemon (`codex app-server --listen <port>`), found
 *      via the ws port in the pane's argv.
 *   2. argv fallback: `codex resume <uuid>` — what the pane was told to open.
 *      Stale if the TUI switched threads afterwards, so only used when no
 *      open-file evidence exists.
 *
 * Returns '' when the pane holds no live codex (dead pane, claude pane, or
 * probe failure) — callers must treat '' as "no evidence", not "no thread".
 */
function paneCodexThread(target: string): string {
  try {
    const panePid = execSync(`${tmux.TMUX} display-message -p -t "${target}" "#{pane_pid}"`, {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!/^\d+$/.test(panePid)) return ''
    // pane 进程树:bash(launch script) → node wrapper → codex 原生二进制
    const pids: string[] = []
    let frontier = [panePid]
    for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
      const next: string[] = []
      for (const pid of frontier) {
        try {
          const kids = execSync(`pgrep -P ${pid}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
          if (kids) next.push(...kids.split('\n'))
        } catch { /* no children */ }
      }
      pids.push(...next)
      frontier = next
    }
    if (pids.length === 0) return ''
    let argvResumeId = ''
    let remotePort = ''
    try {
      const cmds = execSync(`ps -o command= -p ${pids.join(',')}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      for (const line of cmds.split('\n')) {
        if (!/\bcodex\b/.test(line)) continue
        const rm = line.match(/\bresume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/)
        if (rm) argvResumeId = rm[1]
        const pm = line.match(/--remote\s+ws:\/\/[^:\s]+:(\d+)/)
        if (pm) remotePort = pm[1]
      }
    } catch { /* ps failed — lsof below may still work */ }
    // remote pane → rollout 在 daemon 手里,按监听端口找 daemon 进程
    if (remotePort) {
      try {
        const out = execSync(`lsof -nP -iTCP:${remotePort} -sTCP:LISTEN -Fp`, {
          encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
        })
        const daemonPids = out.split('\n').filter((l) => l.startsWith('p')).map((l) => l.slice(1))
        const open = openRolloutThreads(daemonPids)
        if (open.length > 0) return open[0]
      } catch { /* daemon gone — fall through */ }
      return argvResumeId
    }
    const open = openRolloutThreads(pids)
    if (open.length > 0) return open[0]
    return argvResumeId
  } catch { return '' }
}

/**
 * 降级交接/清空后拉起的全新 codex TUI:thread id 只有 TUI 自己知道。轮询探测
 * pane 真实线程,拿到即绑定 DB 并解除 cleared 标记。此前的做法是重启一返回就
 * clearMark,而新 TUI 的 rollout 尚未落盘 → 10s 一跳的盲回填(按 mtime 认领
 * cwd 下最新 rollout)会抢先认领旧 thread,永不纠正(管家事故根因)。
 * 超时兜底 clearMark:此时 rollout 大概率已落盘,盲回填的"最新"已是正确目标。
 */
function bindFreshCodexThread(sessionId: string): void {
  const deadline = Date.now() + 90_000
  const timer = setInterval(() => {
    const s = sessionRepo.listSessions().find((x) => x.id === sessionId)
    if (!s) { clearInterval(timer); return }
    if (s.externalSessionId) { clearInterval(timer); clearMark(sessionId); return }
    const target = resolveRestartPaneTarget(s) ?? resolvePaneTarget(s.tmuxName, s.mainPane || '0.0')
    const live = target ? paneCodexThread(target) : ''
    if (live) {
      sessionRepo.updateSessionExternalId(sessionId, live)
      clearMark(sessionId)
      log('sync', `codex fresh thread bound: ${s.title} → ${live.slice(0, 8)}`)
      clearInterval(timer)
      return
    }
    if (Date.now() > deadline) {
      clearInterval(timer)
      clearMark(sessionId)
      log('sync', `codex fresh thread bind timeout: ${s.title} (fallback to blind sync)`)
    }
  }, 2000)
}

async function restartSessionPane(session: sessionRepo.SessionRow, initialPrompt?: string): Promise<void> {
  await syncManagedMcpsToTool(session.cwd, session.tool)
  // Resolve the exact pane to respawn WITHOUT clobbering a sibling session's
  // pane. Falls back to mainPane only when the tmux session is gone entirely.
  const target = resolveRestartPaneTarget(session)
    ?? resolvePaneTarget(session.tmuxName, session.mainPane || '0.0')

  // 重启前用 pane 实况纠偏 DB 线程(codex 在 TUI 里换线程 kitty 感知不到,
  // 盲回填也可能记错)。cleared 标记 = 正在刻意换新线程,此时不纠。
  if (session.tool === 'codex' && !isCleared(session.id)) {
    const live = paneCodexThread(target)
    if (live && live !== session.externalSessionId) {
      sessionRepo.updateSessionExternalId(session.id, live)
      log('sync', `codex thread drift healed: ${session.title} ${(session.externalSessionId || '∅').slice(0, 8)} → ${live.slice(0, 8)}`)
      session = { ...session, externalSessionId: live }
    }
  }

  // Codex with hive bridge: restart the hive-managed daemon app-server for the
  // target thread, then attach the pane via `codex --remote <ws>`. Restarting
  // the app-server is intentional: it refreshes Codex's MCP tool registry.
  let launch: string
  let bridgedHiveAgentId = ''
  let bridgedExternalId = ''
  if (session.tool === 'codex' && getCodexHiveBridge()) {
    // ALWAYS register on restart, not just when hiveAgentId is empty.
    // The stored hiveAgentId may point to a deleted/orphaned hive row
    // (e.g. user / admin removed it). register is idempotent — same key
    // either reuses the row or creates a fresh one — so calling every
    // restart is safe and keeps DB ↔ hive in sync.
    sendTransferProgress(session.id, 'daemon')
    const reg = await registerCodexAgent({
      key: session.id,
      displayName: session.title,
      projectDir: session.cwd || undefined,
    })
    if (reg.success && reg.agentId) bridgedHiveAgentId = reg.agentId
    const ws = await codexPaneWs({ key: session.id, timeoutMs: 10000 })
    const agentId = bridgedHiveAgentId || session.hiveAgentId
    const requestedThreadId = session.externalSessionId || ws.thread_id || ''
    if (ws.status === 'ready' && ws.ws_url && ws.thread_id && ws.thread_id === requestedThreadId) {
      // daemon 已在目标 thread 上 → 直接 attach,禁止 set-thread。
      // set-thread 语义是"切换 thread",hive 端会 SIGTERM daemon 重生;之前
      // 无条件调它导致每次重启都杀 daemon(my-game restart_count=89 事故):
      // daemon 重生走指数退避(封顶 60s),kitty 只等 30s → 永远 timeout 死循环。
      launch = generateCodexRemoteScript(ws.ws_url, ws.thread_id, session.cwd || undefined, undefined, initialPrompt)
    } else if (agentId && requestedThreadId) {
      const reset = await codexSetThread(agentId, requestedThreadId)
      if (reset.kind === 'ok' || reset.kind === 'resumed_as_new') {
        sessionRepo.updateSessionExternalId(session.id, reset.threadId)
        launch = generateCodexRemoteScript(reset.wsUrl, reset.threadId, session.cwd || undefined, undefined, initialPrompt)
      } else {
        log('codex-bridge', `daemon reset failed (${reset.kind}): ${reset.kind === 'error' ? reset.message : 'timeout'}`)
        const mode = restartMode(session)
        launch = generateLaunchScript(session.tool, mode, session.externalSessionId || undefined, session.cwd || undefined, undefined, launchArgsFor(session), initialPrompt)
      }
    } else if (ws.status === 'ready' && ws.ws_url) {
      launch = generateCodexRemoteScript(ws.ws_url, ws.thread_id, session.cwd || undefined, undefined, initialPrompt)
      if (ws.thread_id) {
        sessionRepo.updateSessionExternalId(session.id, ws.thread_id)
      }
    } else {
      log('codex-bridge', `restart fallback (ws status=${ws.status}): ${ws.error || ''}`)
      const mode = restartMode(session)
      launch = generateLaunchScript(session.tool, mode, session.externalSessionId || undefined, session.cwd || undefined, undefined, launchArgsFor(session), initialPrompt)
    }
  } else if (session.tool === 'opencode') {
    const mode = restartMode(session)
    const desiredSessionId = mode === 'new'
      ? null
      : mode === 'resume'
        ? session.externalSessionId
        : undefined
    const bridged = await tryPrepareOpenCodeAttachScript({
      kittyId: session.id,
      title: session.title,
      projectDir: session.cwd,
      desiredSessionId,
      initialPrompt,
      launchArgs: launchArgsFor(session),
      switchTool: await hiveSupportsSwitchTool(),
    })
    if (bridged) {
      launch = bridged.script
      bridgedHiveAgentId = bridged.hiveAgentId
      bridgedExternalId = bridged.sessionId
    } else {
      launch = generateLaunchScript(session.tool, mode, session.externalSessionId || undefined, session.cwd || undefined, undefined, launchArgsFor(session), initialPrompt)
    }
  } else {
    const { sid, mode } = prebindClaudeRelaunch(session, restartMode(session))
    launch = generateLaunchScript(session.tool, mode, session.externalSessionId || undefined, session.cwd || undefined, sid, launchArgsFor(session), initialPrompt)
  }

  prepareProjectForTool(session.cwd, session.tool, launch)

  // Parse per-session env and pass via respawn-pane -e KEY=VALUE
  let envFlags = ''
  if (session.env) {
    try {
      const parsed = JSON.parse(session.env) as Record<string, string>
      for (const [k, v] of Object.entries(parsed)) {
        envFlags += ` -e "${k}=${String(v).replace(/"/g, '\\"')}"`
      }
    } catch { /* ignore bad env json */ }
  }
  // Kitty identity drives tool-local integrations (OpenCode plugin); Hive
  // identity remains optional and is carried for Claude/Codex compatibility.
  envFlags += ` -e "KITTY_SESSION_ID=${session.id}"`
  envFlags += ` -e "KITTY_SESSION_NAME=${String(session.title || '').replace(/"/g, '\\"')}"`
  envFlags += ` -e "HIVE_AGENT_KEY=${session.id}"`
  envFlags += ` -e "HIVE_AGENT_NAME=${String(session.title || '').replace(/"/g, '\\"')}"`

  //焊死 hive 身份 + per-session env 进脚本本体,防 respawn/app 重启/手动重跑丢失(根治)
  injectHiveIdentity(launch, session.id, session.title || '')
  injectSessionEnv(launch, session.env)

  execSync(`${tmux.TMUX} respawn-pane -k${envFlags} -t "${target}" "${launch}"`, { stdio: 'ignore' })
  if (bridgedHiveAgentId && bridgedHiveAgentId !== session.hiveAgentId) {
    sessionRepo.updateSessionHiveAgentId(session.id, bridgedHiveAgentId)
  }
  if (bridgedExternalId) {
    sessionRepo.updateSessionExternalId(session.id, bridgedExternalId)
    clearMark(session.id)
  }
  log('session', `restart: ${session.title}`)

  // For claude --dangerously-load-development-channels: auto-accept the prompt
  if (needsDevChannelAutoAccept(session.tool)) {
    pollAndAcceptDevChannelPrompt(target)
  }
}

/**
 * Non-blocking poller: watch the target pane and send Enter when the
 * dev-channels confirmation prompt appears. Max 5s (25 × 200ms).
 */
function pollAndAcceptDevChannelPrompt(paneTarget: string): void {
  const deadline = Date.now() + 5000
  const interval = setInterval(() => {
    if (Date.now() > deadline) { clearInterval(interval); return }
    try {
      const content = execSync(`${tmux.TMUX} capture-pane -p -t "${paneTarget}"`, {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore']
      })
      if (/development channels?|dangerously-load|trust these|continue\?/i.test(content)) {
        execSync(`${tmux.TMUX} send-keys -t "${paneTarget}" Enter`, { stdio: 'ignore' })
        clearInterval(interval)
      }
    } catch { /* pane gone, stop */ clearInterval(interval) }
  }, 200)
}

async function restartSessionTool(session: sessionRepo.SessionRow, nextTool: string): Promise<void> {
  const target = resolveRestartPaneTarget(session)
    ?? resolvePaneTarget(session.tmuxName, session.mainPane || '0.0')
  const launchArgs = launchArgsFor({ tool: nextTool, launchArgs: session.launchArgs })
  // A generic tool switch does not convert conversation history (Alt+X owns
  // that contract), so start a fresh target-tool session. Pre-bind Claude to
  // avoid accidentally continuing a sibling session that shares the cwd.
  let launch: string
  let bridgedHiveAgentId = ''
  let bridgedExternalId = ''
  if (nextTool === 'opencode') {
    const bridged = await tryPrepareOpenCodeAttachScript({
      kittyId: session.id,
      title: session.title,
      projectDir: session.cwd,
      desiredSessionId: null,
      launchArgs,
      switchTool: await hiveSupportsSwitchTool(),
    })
    if (bridged) {
      launch = bridged.script
      bridgedHiveAgentId = bridged.hiveAgentId
      bridgedExternalId = bridged.sessionId
    } else {
      launch = generateLaunchScript(nextTool, 'new', undefined, session.cwd, undefined, launchArgs)
    }
  } else {
    launch = generateLaunchScript(
      nextTool,
      'new',
      undefined,
      session.cwd,
      nextTool === 'claude' ? session.externalSessionId : undefined,
      launchArgs,
    )
  }
  prepareProjectForTool(session.cwd, nextTool, launch)
  injectHiveIdentity(launch, session.id, session.title || '')
  injectSessionEnv(launch, session.env)

  let envFlags =
    ` -e "KITTY_SESSION_ID=${session.id}"` +
    ` -e "KITTY_SESSION_NAME=${String(session.title || '').replace(/"/g, '\\"')}"` +
    ` -e "HIVE_AGENT_KEY=${session.id}"` +
    ` -e "HIVE_AGENT_NAME=${String(session.title || '').replace(/"/g, '\\"')}"`
  if (session.env) {
    try {
      const parsed = JSON.parse(session.env) as Record<string, string>
      for (const [key, value] of Object.entries(parsed)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          envFlags += ` -e "${key}=${String(value).replace(/"/g, '\\"')}"`
        }
      }
    } catch { /* ignore invalid per-session env */ }
  }
  execSync(`${tmux.TMUX} respawn-pane -k${envFlags} -t "${target}" "${launch}"`, { stdio: 'ignore' })
  if (bridgedHiveAgentId) sessionRepo.updateSessionHiveAgentId(session.id, bridgedHiveAgentId)
  if (bridgedExternalId) sessionRepo.updateSessionExternalId(session.id, bridgedExternalId)
}

function resolvePaneTarget(tmuxName: string, mainPane: string): string {
  const pane = (mainPane || '0.0').trim()
  if (!pane) return `${tmuxName}:0.0`
  if (pane.startsWith('%')) return pane
  if (pane.includes(':')) return pane
  return `${tmuxName}:${pane}`
}

/** Live pane ids (%N) of a tmux session, in order. Empty if session is gone. */
function listPaneIds(tmuxName: string): string[] {
  try {
    return execSync(`${tmux.TMUX} list-panes -t "${tmuxName}" -F '#{pane_id}'`, {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Pick the EXACT pane to respawn for a restart, never clobbering another
 * session's pane.
 *
 * The bug this fixes: in pane mode several sessions share one tmux_name (the
 * host's `kitty_<hostId>`). If a session's own pane died, its `pane_id` gets
 * cleared by syncPaneIds. A naive restart then falls back to `:0.0`, which is
 * whatever pane happens to be first — i.e. a *different* session's pane — and
 * respawn-pane -k turns that sibling into this session's tool. (Observed:
 * restarting codex turned tap-slash's pane into codex.)
 *
 * Resolution order:
 *   1. own pane_id still alive          → use it
 *   2. a live pane not claimed by any other session → adopt it
 *   3. otherwise split a brand-new pane → use it
 * In cases 2/3 the DB pane_id is updated so future restarts are stable.
 * Returns null only when the tmux session itself is gone (caller falls back).
 */
function resolveRestartPaneTarget(session: sessionRepo.SessionRow): string | null {
  const live = listPaneIds(session.tmuxName)
  if (live.length === 0) return null

  if (session.paneId && live.includes(session.paneId)) return session.paneId

  const claimed = new Set(
    sessionRepo.listSessions()
      .filter((s) => s.id !== session.id && s.tmuxName === session.tmuxName && s.paneId)
      .map((s) => s.paneId),
  )
  const free = live.find((p) => !claimed.has(p))
  if (free) {
    sessionRepo.updateSessionPaneId(session.id, free)
    log('session', `restart: ${session.title} adopted free pane ${free} (was ${session.paneId || 'none'})`)
    return free
  }

  // All panes belong to other sessions — split a new one for us.
  try {
    const cwdFlag = session.cwd ? `-c "${session.cwd}"` : ''
    const newPane = execSync(
      `${tmux.TMUX} split-window -t "${session.tmuxName}" -h ${cwdFlag} -P -F '#{pane_id}'`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], env: tmux.tmuxSpawnEnv() },
    ).trim()
    sessionRepo.updateSessionPaneId(session.id, newPane)
    tmux.applyMainVerticalLayout(session.tmuxName)
    log('session', `restart: ${session.title} created new pane ${newPane} (all panes were claimed)`)
    return newPane
  } catch (err) {
    log('session', `restart: ${session.title} split-window failed, falling back to :0.0`, err)
    return resolvePaneTarget(session.tmuxName, session.mainPane || '0.0')
  }
}
