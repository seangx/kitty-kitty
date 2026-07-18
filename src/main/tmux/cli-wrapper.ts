import { writeFileSync, chmodSync, existsSync, readFileSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir, homedir } from 'os'

/** Common binary directories not in GUI app's PATH */
const EXTRA_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.opencode', 'bin'),
  join(homedir(), '.npm-global', 'bin'),
]

function findBinary(name: string): string | null {
  for (const dir of EXTRA_BIN_DIRS) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  try {
    return execSync(`which ${name}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

/**
 * CLI wrapper layer: generates shell scripts that handle continue/new/restore
 * logic for each supported AI CLI tool.
 *
 * Modes:
 *  - 'continue'  → try to continue most recent session, fallback to new
 *  - 'new'       → start fresh session
 *  - 'resume'    → resume a specific session by ID
 *  - 'restore'   → best-effort restore (try continue, then new, then shell)
 */

export type LaunchMode = 'continue' | 'new' | 'resume' | 'restore'

interface ToolConfig {
  /** Base command */
  cmd: string
  /** Default arguments appended to every invocation */
  defaultArgs?: string
  /** Flag to continue most recent session */
  continueFlag?: string
  /** Flag to resume a specific session, followed by session ID */
  resumeFlag?: string
  /** Flag to start a NEW session with a caller-provided id (claude: --session-id) */
  sessionIdFlag?: string
  /** Flag placed before an initial prompt (opencode: --prompt). Omit for positional prompts. */
  promptFlag?: string
}

/**
 * User config file: ~/.kitty-kitty/config.json
 *
 * Example:
 * {
 *   "toolArgs": {
 *     "claude": "--dangerously-skip-permissions",
 *     "codex": "--some-flag"
 *   }
 * }
 */
const CONFIG_PATH = join(homedir(), '.kitty-kitty', 'config.json')

interface KittyConfig {
  toolArgs?: Record<string, string>
  ntfyTopic?: string
  /** Path B: route codex pane spawn through hive supervisor (codex --remote ws). */
  codexHiveBridge?: boolean
}

function loadConfig(): KittyConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    }
  } catch { /* ignore parse errors */ }
  // Create default config if missing
  const defaultConfig: KittyConfig = { toolArgs: { claude: '' } }
  try {
    mkdirSync(join(homedir(), '.kitty-kitty'), { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2))
  } catch { /* ignore */ }
  return defaultConfig
}

export function getUserToolArgs(tool: string): string {
  const config = loadConfig()
  return config.toolArgs?.[tool] ?? ''
}

export function getNtfyTopic(): string {
  const config = loadConfig()
  return config.ntfyTopic ?? ''
}

export function setNtfyTopic(topic: string): void {
  const config = loadConfig()
  config.ntfyTopic = topic
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

export function getCodexHiveBridge(): boolean {
  const config = loadConfig()
  return Boolean(config.codexHiveBridge)
}

export function setCodexHiveBridge(enabled: boolean): void {
  const config = loadConfig()
  config.codexHiveBridge = enabled
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

const TOOLS: Record<string, ToolConfig> = {
  claude: {
    cmd: 'claude',
    continueFlag: '-c',
    resumeFlag: '--resume',
    sessionIdFlag: '--session-id',
  },
  codex: {
    cmd: 'codex',
    continueFlag: 'resume --last',
    resumeFlag: 'resume',
  },
  opencode: {
    cmd: 'opencode',
    continueFlag: '--continue',
    resumeFlag: '--session',
    promptFlag: '--prompt',
  },
  shell: {
    cmd: '$SHELL',
  },
}

/**
 * Check if a CLI tool is installed. Returns true if available.
 */
export function isToolInstalled(tool: string): boolean {
  const config = TOOLS[tool]
  if (!config) return false
  if (tool === 'shell') return true
  return findBinary(config.cmd) !== null
}

/**
 * Get human-readable install instructions for a tool.
 */
export function getInstallHint(tool: string): string {
  switch (tool) {
    case 'claude': return '安装方法: npm install -g @anthropic-ai/claude-code'
    case 'codex': return '安装方法: npm install -g @openai/codex'
    case 'opencode': return '安装方法: brew install anomalyco/tap/opencode（或 npm install -g opencode-ai）'
    default: return `请先安装 ${tool}`
  }
}

/**
 * Generate a wrapper shell script for launching a CLI tool.
 * Returns the path to the generated script.
 */
export function generateLaunchScript(
  tool: string,
  mode: LaunchMode,
  resumeId?: string,
  cwd?: string,
  sessionId?: string,
  extraArgs?: string,
  initialPrompt?: string,
): string {
  const config = TOOLS[tool] || { cmd: tool }
  const scriptPath = join(tmpdir(), `kitty_launch_${Date.now()}.sh`)

  let script: string

  switch (mode) {
    case 'continue':
      script = buildContinueScript(config, extraArgs, initialPrompt)
      break
    case 'new':
      script = buildNewScript(config, sessionId, extraArgs, initialPrompt)
      break
    case 'resume':
      script = buildResumeScript(config, resumeId!, extraArgs, initialPrompt)
      break
    case 'restore':
      script = buildRestoreScript(config, extraArgs, initialPrompt)
      break
  }

  if (cwd) script = prefixCwd(script, cwd)

  writeFileSync(scriptPath, script)
  chmodSync(scriptPath, '755')
  return scriptPath
}

/**
 * Force the script to cd into the row's intended cwd before running anything.
 * `tmux respawn-pane` inherits the pane's current working directory, which can
 * drift away from the row's cwd if the user manually cd'd inside the pane or
 * if a prior corruption put it elsewhere. Without this guard, `claude -c`
 * would pick up the WRONG project's most-recent jsonl.
 */
function prefixCwd(script: string, cwd: string): string {
  return script.replace(
    /^#!\/bin\/bash\n/,
    `#!/bin/bash\ncd ${shellQuoteForSh(cwd)} 2>/dev/null || true\n`,
  )
}

/**
 * 把 hive 身份(HIVE_AGENT_KEY / NAME)焊进已生成的 launch script 本体,
 * 紧跟 PATH 之后。幂等。
 *
 * 背景:HIVE_AGENT_KEY 原本只靠 kitty 在 tmux `new-session`/`split-window`/
 * `respawn-pane` 上附的 `-e` 注入,而 `-e` 只是「这一次进程启动」的 ephemeral
 * 环境,tmux 不会持久化它。一旦 pane 经「app 重启原地恢复 / claude 退出落到
 * `exec $SHELL` 后重跑脚本 / 手动操作」等不走 kitty `-e` 的途径再次拉起,key
 * 就永久丢失,hive MCP 随即 fallback 到按 name 注册 → 同 cwd 多会话错绑/串号。
 * 写进脚本本体后,无论脚本被怎样重跑,身份都在。
 */
export function injectHiveIdentity(scriptPath: string, key: string, name: string): void {
  if (!scriptPath || !key || !scriptPath.endsWith('.sh')) return
  try {
    if (!existsSync(scriptPath)) return
    let script = readFileSync(scriptPath, 'utf-8')
    if (script.includes('HIVE_AGENT_KEY=') && script.includes('KITTY_SESSION_ID=')) return // 已注入,幂等
    const exportLines =
      `export KITTY_SESSION_ID=${shellQuoteForSh(key)}\n` +
      `export KITTY_SESSION_NAME=${shellQuoteForSh(name || '')}\n` +
      `export HIVE_AGENT_KEY=${shellQuoteForSh(key)}\n` +
      `export HIVE_AGENT_NAME=${shellQuoteForSh(name || '')}`
    script = script.includes(PATH_PREAMBLE)
      ? script.replace(PATH_PREAMBLE, `${PATH_PREAMBLE}\n${exportLines}`)
      : script.replace(/^#!\/bin\/bash\n/, `#!/bin/bash\n${exportLines}\n`)
    writeFileSync(scriptPath, script)
  } catch { /* best-effort:注入失败不阻断 spawn */ }
}

/**
 * 把 per-session 环境变量焊进 launch script 本体(PATH 之后)。幂等。
 *
 * 与 injectHiveIdentity 同理:env 原本只在部分重建路径靠 tmux `-e` 注入,而
 * app 重启自动恢复(tryRestoreSession)/unhide 等路径不注入 → 设过的 env 丢失。
 * 写进脚本本体后无论怎样重跑都带上。只接受合法 shell 变量名,跳过非法 key。
 */
export function injectSessionEnv(scriptPath: string, envJson: string): void {
  if (!scriptPath || !envJson || !scriptPath.endsWith('.sh')) return
  try {
    if (!existsSync(scriptPath)) return
    let env: Record<string, string>
    try { env = JSON.parse(envJson) } catch { return }
    const keys = Object.keys(env || {}).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    if (!keys.length) return
    let script = readFileSync(scriptPath, 'utf-8')
    if (script.includes('# kitty:session-env')) return // 已注入,幂等
    const exportLines =
      '# kitty:session-env\n' +
      keys.map((k) => `export ${k}=${shellQuoteForSh(String(env[k]))}`).join('\n')
    script = script.includes(PATH_PREAMBLE)
      ? script.replace(PATH_PREAMBLE, `${PATH_PREAMBLE}\n${exportLines}`)
      : script.replace(/^#!\/bin\/bash\n/, `#!/bin/bash\n${exportLines}\n`)
    writeFileSync(scriptPath, script)
  } catch { /* best-effort */ }
}

/** Attach the repo-scoped Claude memory file to an OpenCode launch. */
export function injectOpenCodeMemory(scriptPath: string, memoryFile: string | null | undefined): void {
  if (!scriptPath || !memoryFile || !scriptPath.endsWith('.sh')) return
  try {
    if (!existsSync(scriptPath)) return
    let script = readFileSync(scriptPath, 'utf8')
    if (script.includes('# kitty:opencode-memory')) return
    const exportLine =
      `# kitty:opencode-memory\n` +
      `export KITTY_CLAUDE_MEMORY_FILE=${shellQuoteForSh(memoryFile)}`
    script = script.includes(PATH_PREAMBLE)
      ? script.replace(PATH_PREAMBLE, `${PATH_PREAMBLE}\n${exportLine}`)
      : script.replace(/^#!\/bin\/bash\n/, `#!/bin/bash\n${exportLine}\n`)
    writeFileSync(scriptPath, script)
  } catch { /* best-effort: memory bridge must not block launching OpenCode */ }
}

/**
 * Get the raw command string for a tool (for simple cases).
 */
export function getToolCommand(tool: string): string {
  return TOOLS[tool]?.cmd || tool
}

/**
 * Path B: codex TUI client attached to a hive-managed ws app-server.
 * No fallback to bare `codex` — caller decides whether to retry / fallback
 * before spawning the pane.
 *
 * IMPORTANT: pass `threadId` from `hive_codex_pane_ws` — without it, the TUI
 * defaults to `thread/start` and opens a brand-new thread, missing all DMs
 * the daemon has already pushed into its own thread. With `resume <threadId>
 * --remote <ws>` the TUI binds to the daemon's actual thread.
 */
export function generateCodexRemoteScript(
  wsUrl: string,
  threadId?: string,
  cwd?: string,
  bannerText?: string,
  initialPrompt?: string,
): string {
  const scriptPath = join(tmpdir(), `kitty_launch_${Date.now()}.sh`)
  const promptArg = initialPrompt ? ` ${shellQuoteForSh(initialPrompt)}` : ''
  const cmd = threadId
    ? `codex resume ${shellQuoteForSh(threadId)} --remote ${shellQuoteForSh(wsUrl)}${promptArg}`
    : `codex --remote ${shellQuoteForSh(wsUrl)}${promptArg}`
  // Banner: when set, runs before codex spawns. `clear` wipes the previous
  // pane content (e.g. the WebSocket reset error printed by the old codex
  // client when hive SIGTERM'd its daemon) so the user's first visible glimpse
  // is the friendly "重置对话中" message, not a red error.
  const banner = bannerText
    ? `clear\nprintf '\\033[36m%s\\033[0m\\n' ${shellQuoteForSh(bannerText)}\n`
    : ''
  let script = `#!/bin/bash
${PATH_PREAMBLE}
${banner}${cmd}
# Keep shell alive when TUI exits so the pane doesn't vanish silently
exec $SHELL
`
  if (cwd) script = prefixCwd(script, cwd)
  writeFileSync(scriptPath, script)
  chmodSync(scriptPath, '755')
  return scriptPath
}

/** Launch a visible OpenCode TUI attached to the Hive-supervised session. */
export function generateOpenCodeAttachScript(
  pane: {
    serverUrl: string
    sessionId: string
    username: string
    password: string
  },
  cwd?: string,
  extraArgs?: string,
): string {
  const scriptPath = join(tmpdir(), `kitty_launch_${Date.now()}.sh`)
  const args = extraArgs?.trim() ? ` ${extraArgs.trim()}` : ''
  let script = `#!/bin/bash
${PATH_PREAMBLE}
opencode attach ${shellQuoteForSh(pane.serverUrl)} --session ${shellQuoteForSh(pane.sessionId)} --username ${shellQuoteForSh(pane.username)} --password ${shellQuoteForSh(pane.password)}${args}
# Keep shell alive when TUI exits so the pane doesn't vanish silently
exec $SHELL
`
  if (cwd) script = prefixCwd(script, cwd)
  writeFileSync(scriptPath, script)
  // The attach password is embedded in this short-lived script. Keep it
  // executable by the current user without exposing it to other local users.
  chmodSync(scriptPath, '700')
  return scriptPath
}

function shellQuoteForSh(s: string): string {
  // Single-quote escape: ' → '\''
  return `'${s.replace(/'/g, "'\\''")}'`
}

// --- Script builders ---

const PATH_PREAMBLE = 'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.opencode/bin:$PATH"'

/** Build the full base command: cmd + hardcoded defaultArgs + 全局 toolArgs + per-session extraArgs(追加在最后,可覆盖前面的 flag) */
function baseCmd(config: ToolConfig, extraArgs?: string): string {
  const parts = [config.cmd]
  if (config.defaultArgs) parts.push(config.defaultArgs)
  const userArgs = getUserToolArgs(config.cmd)
  if (userArgs) parts.push(userArgs)
  if (extraArgs && extraArgs.trim()) parts.push(extraArgs.trim())
  return parts.join(' ')
}

/**
 * Check whether the current claude toolArgs includes the dev-channels flag.
 * Used by the main process to decide whether to start an auto-accept poller.
 */
export function needsDevChannelAutoAccept(tool: string): boolean {
  if (tool !== 'claude') return false
  const userArgs = getUserToolArgs(tool)
  return userArgs.includes('--dangerously-load-development-channels')
}

function promptArg(config: ToolConfig, initialPrompt?: string): string {
  if (!initialPrompt) return ''
  const value = shellQuoteForSh(initialPrompt)
  return config.promptFlag ? ` ${config.promptFlag} ${value}` : ` ${value}`
}

function buildContinueScript(config: ToolConfig, extraArgs?: string, initialPrompt?: string): string {
  if (!config.continueFlag) return buildNewScript(config, undefined, extraArgs, initialPrompt)
  const cmd = baseCmd(config, extraArgs)
  const prompt = promptArg(config, initialPrompt)

  return `#!/bin/bash
${PATH_PREAMBLE}
# Try to continue most recent session, fallback to new
${cmd} ${config.continueFlag}${prompt} 2>/dev/null
EXIT=$?
if [ $EXIT -ne 0 ]; then
  echo "No session to continue, starting new..."
  ${cmd}${prompt}
fi
# Keep shell alive if tool exits
exec $SHELL
`
}

function buildNewScript(config: ToolConfig, sessionId?: string, extraArgs?: string, initialPrompt?: string): string {
  let cmd = baseCmd(config, extraArgs)
  // Pre-bind the session id when the tool supports it (claude --session-id).
  // Lets kitty know the jsonl name up front instead of claiming by cwd later,
  // so multiple sessions can share one cwd without cross-assignment.
  if (sessionId && config.sessionIdFlag) cmd += ` ${config.sessionIdFlag} ${sessionId}`
  cmd += promptArg(config, initialPrompt)
  return `#!/bin/bash
${PATH_PREAMBLE}
${cmd}
# Keep shell alive if tool exits
exec $SHELL
`
}

function buildResumeScript(config: ToolConfig, resumeId: string, extraArgs?: string, initialPrompt?: string): string {
  if (!config.resumeFlag) return buildNewScript(config, undefined, extraArgs, initialPrompt)
  const cmd = baseCmd(config, extraArgs)
  const prompt = promptArg(config, initialPrompt)
  const fallback = config.continueFlag
    ? `${cmd} ${config.continueFlag}${prompt}`
    : `${cmd}${prompt}`

  return `#!/bin/bash
${PATH_PREAMBLE}
# Resume specific session, fallback to continue, then new
${cmd} ${config.resumeFlag} "${resumeId}"${prompt} 2>/dev/null
EXIT=$?
if [ $EXIT -ne 0 ]; then
  echo "Resume failed, trying continue..."
  ${fallback} 2>/dev/null || ${cmd}${prompt}
fi
# Keep shell alive if tool exits
exec $SHELL
`
}

function buildRestoreScript(config: ToolConfig, extraArgs?: string, initialPrompt?: string): string {
  const cmd = baseCmd(config, extraArgs)
  const prompt = promptArg(config, initialPrompt)
  // Best-effort: try continue → new → shell
  if (!config.continueFlag) {
    return `#!/bin/bash
${PATH_PREAMBLE}
${cmd}${prompt} 2>/dev/null || exec $SHELL
`
  }

  return `#!/bin/bash
${PATH_PREAMBLE}
# Restore: try continue, then new, then fallback to shell
${cmd} ${config.continueFlag}${prompt} 2>/dev/null
EXIT=$?
if [ $EXIT -ne 0 ]; then
  ${cmd}${prompt} 2>/dev/null || true
fi
# Keep shell alive if tool exits
exec $SHELL
`
}
