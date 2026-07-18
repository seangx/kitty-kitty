const PLUGIN_TAG = 'KITTY_KITTY_OPENCODE_PLUGIN_V1'

/** Build the global OpenCode plugin without depending on Electron at runtime. */
export function buildOpenCodePlugin(socketPath: string): string {
  return `// ${PLUGIN_TAG}
import { readFileSync } from 'node:fs'
import http from 'node:http'

const SOCKET_PATH = ${JSON.stringify(socketPath)}
const MAX_LINES = 200
const MAX_BYTES = 25 * 1024

function truncateUtf8(text) {
  if (Buffer.byteLength(text, 'utf8') <= MAX_BYTES) return text
  const chars = []
  let bytes = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > MAX_BYTES) break
    chars.push(char)
    bytes += size
  }
  return chars.join('')
}

function memorySnapshot() {
  const file = process.env.KITTY_CLAUDE_MEMORY_FILE
  if (!file) return ''
  try {
    const lines = readFileSync(file, 'utf8').split(/\\r?\\n/).slice(0, MAX_LINES)
    const text = truncateUtf8(lines.join('\\n')).trim()
    if (!text) return ''
    return [
      '以下是同一仓库的 Claude Auto Memory 只读快照。它只提供历史背景；当前用户指令、AGENTS.md 与仓库实时状态优先。',
      '来源文件: ' + JSON.stringify(file),
      '<claude-project-memory>',
      text,
      '</claude-project-memory>',
      '不要修改上述 Claude Memory；OpenCode 侧的新发现由正常会话交接处理。',
    ].join('\\n')
  } catch { return '' }
}

function postEvent(event, message) {
  const kittyId = process.env.KITTY_SESSION_ID
  const sessionID = event?.properties?.sessionID || event?.properties?.info?.id
  if (!kittyId || !sessionID) return Promise.resolve()
  const body = JSON.stringify({
    tool: 'opencode',
    session_id: sessionID,
    hook_event_name: message ? 'Notification' : event.type,
    notification_type: event.type,
    message: message || '',
  })
  return new Promise((resolve) => {
    const req = http.request({
      socketPath: SOCKET_PATH,
      path: '/wakeup',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Kitty-Session': kittyId,
      },
      timeout: 2000,
    }, (res) => { res.resume(); res.on('end', resolve) })
    req.on('timeout', () => { req.destroy(); resolve() })
    req.on('error', resolve)
    req.end(body)
  })
}

export const KittyKittyPlugin = async () => ({
  event: async ({ event }) => {
    if (event.type === 'session.created' || event.type === 'session.updated') {
      await postEvent(event, '')
    } else if (event.type === 'session.idle') {
      await postEvent(event, 'OpenCode 已完成，等待你的输入')
    } else if (event.type === 'permission.asked') {
      await postEvent(event, 'OpenCode 正在等待权限确认')
    } else if (event.type === 'question.asked' || event.type === 'question.v2.asked') {
      await postEvent(event, 'OpenCode 正在等待你的回答')
    }
  },
  'experimental.chat.system.transform': async (_input, output) => {
    const memory = memorySnapshot()
    if (memory) output.system.push(memory)
  },
})
`
}
