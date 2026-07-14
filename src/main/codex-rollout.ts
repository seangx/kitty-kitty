/**
 * codex rollout 解析 —— Alt+X 混合 transfer 的"增量回传"一环。
 *
 * codex 把每个 thread 的完整历史落在
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl
 * 事件行结构: { timestamp, type:'response_item', payload:{ type:'message',
 * role:'user'|'assistant'|'developer', content:[{text}] } }。
 *
 * 变回 claude 时没有官方的 codex→claude transfer,这里退而求其次:提取
 * transfer 之后新增的对话生成移交 markdown,注入 claude 作为工作记录。
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const SESSIONS_DIR = join(homedir(), '.codex', 'sessions')
const PER_MSG_CAP = 8000 // 单条消息截断,防单条粘贴大文件撑爆移交文档
const HANDOFF_TTL_MS = 7 * 24 * 3600_000 // 移交文档保留 7 天

/** 清理过期的移交文档(生成新文档时顺手做,失败不阻断)。 */
function pruneOldHandoffs(dir: string): void {
  try {
    const now = Date.now()
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('codex-') || !f.endsWith('.md')) continue
      const p = join(dir, f)
      try {
        if (now - statSync(p).mtimeMs > HANDOFF_TTL_MS) unlinkSync(p)
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** 按 threadId 找 rollout 文件(文件名以 -<threadId>.jsonl 结尾)。 */
export function findRolloutFile(threadId: string): string | null {
  const walk = (dir: string, depth: number): string | null => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return null }
    // 新的在后:倒序扫,先命中最近日期
    for (const e of entries.sort().reverse()) {
      const p = join(dir, e)
      if (e.endsWith(`-${threadId}.jsonl`)) return p
      if (depth > 0 && !e.includes('.')) {
        const hit = walk(p, depth - 1)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(SESSIONS_DIR, 3) // sessions/年/月/日
}

export interface CodexHandoff {
  file: string
  turns: number
}

/**
 * 生成 sinceIso 之后 codex 对话的移交 markdown 文件。
 * 无 rollout / 无新增对话返回 null(变回时不注入)。
 */
export function buildCodexHandoff(threadId: string, sinceIso: string): CodexHandoff | null {
  const rollout = findRolloutFile(threadId)
  if (!rollout) return null
  const since = Date.parse(sinceIso) || 0

  const parts: string[] = []
  let turns = 0
  let raw: string
  try { raw = readFileSync(rollout, 'utf-8') } catch { return null }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let d: { timestamp?: string; type?: string; payload?: { type?: string; role?: string; content?: Array<{ text?: string }> } }
    try { d = JSON.parse(line) } catch { continue }
    if (d?.type !== 'response_item') continue
    if ((Date.parse(d.timestamp || '') || 0) <= since) continue
    const p = d.payload
    if (p?.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant')) continue
    let text = (p.content || []).map((c) => c?.text || '').join('\n').trim()
    // 跳过 environment_context / permissions 等注入的系统块
    if (!text || text.startsWith('<')) continue
    if (text.length > PER_MSG_CAP) text = `${text.slice(0, PER_MSG_CAP)}\n…(截断)`
    turns++
    parts.push(`## ${p.role === 'user' ? '👤 User' : '🤖 Codex'}\n\n${text}`)
  }
  if (!turns) return null

  const md = [
    '# Codex 期间的工作记录',
    '',
    `> 本会话曾转交给 Codex。以下是转交期间的对话,按时间排序;工具调用/推理过程已省略,只保留双方消息。`,
    `> 想回看完整过程(含工具调用):\`codex resume ${threadId}\``,
    '',
    parts.join('\n\n'),
    '',
  ].join('\n')

  const dir = join(homedir(), '.kitty-kitty', 'handoff')
  mkdirSync(dir, { recursive: true })
  pruneOldHandoffs(dir)
  const file = join(dir, `codex-${threadId.slice(0, 8)}-${Date.now()}.md`)
  writeFileSync(file, md)
  return { file, turns }
}

// ─── 大会话降级:claude → codex 的"近期上下文交接" ───────────────────
// 巨型 claude 会话(几十 MB jsonl)全量 import 会撑爆 codex 上下文。降级为:
// 提取近期对话 + 项目文档指引,生成交接文档,起全新 codex thread 读它接手。

const RECENT_CHAR_BUDGET = 300_000 // ≈10 万 token(粗按 3 chars/token)
const JSONL_HARD_CAP = 500 * 1024 * 1024 // 超过 500MB 连解析都不做

/** 从 claude jsonl 行提取纯文本(过滤 thinking/tool 块与系统注入)。 */
function textOfClaudeLine(d: { type?: string; message?: { content?: unknown } }): string {
  const ct = d?.message?.content
  let text = ''
  if (typeof ct === 'string') text = ct
  else if (Array.isArray(ct)) {
    text = ct
      .filter((b: { type?: string }) => b?.type === 'text')
      .map((b: { text?: string }) => b.text || '')
      .join('\n')
  }
  text = text.trim()
  if (!text || text.startsWith('<')) return '' // system-reminder / command 包裹块
  return text
}

/** 项目文档指引:README/HANDOFF 等常见文件 + docs/ 两层内 .md,按 mtime 取前 10。 */
function listProjectDocs(cwd: string): string[] {
  const hits: Array<{ p: string; mtime: number }> = []
  const push = (p: string): void => {
    try { hits.push({ p, mtime: statSync(p).mtimeMs }) } catch { /* ignore */ }
  }
  for (const f of ['README.md', 'HANDOFF.md', 'CLAUDE.md', 'AGENTS.md']) {
    const p = join(cwd, f)
    try { if (statSync(p).isFile()) push(p) } catch { /* ignore */ }
  }
  const scanDir = (dir: string, depth: number): void => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules') continue
      const p = join(dir, e)
      try {
        const st = statSync(p)
        if (st.isFile() && e.endsWith('.md')) hits.push({ p, mtime: st.mtimeMs })
        else if (st.isDirectory() && depth > 0) scanDir(p, depth - 1)
      } catch { /* ignore */ }
    }
  }
  scanDir(join(cwd, 'docs'), 2)
  hits.sort((a, b) => b.mtime - a.mtime)
  return [...new Set(hits.map((h) => h.p))].slice(0, 10)
}

/**
 * 大会话降级交接:提取 claude jsonl 尾部 ~10 万 token 的对话 + 项目文档指引,
 * 生成交接文档。返回 null 表示无法生成(文件过大/无可用对话)。
 */
export function buildClaudeRecentHandoff(jsonlPath: string, cwd: string): CodexHandoff | null {
  let size = 0
  try { size = statSync(jsonlPath).size } catch { return null }
  if (size > JSONL_HARD_CAP) return null

  let raw: string
  try { raw = readFileSync(jsonlPath, 'utf-8') } catch { return null }
  const lines = raw.split('\n')

  // 从尾往前收集,直到吃满预算;再反转回时间正序
  const collected: string[] = []
  let used = 0
  let turns = 0
  for (let i = lines.length - 1; i >= 0 && used < RECENT_CHAR_BUDGET; i--) {
    if (!lines[i].trim()) continue
    let d: { type?: string; message?: { content?: unknown } }
    try { d = JSON.parse(lines[i]) } catch { continue }
    if (d?.type !== 'user' && d?.type !== 'assistant') continue
    let text = textOfClaudeLine(d)
    if (!text) continue
    if (text.length > PER_MSG_CAP) text = `${text.slice(0, PER_MSG_CAP)}\n…(截断)`
    collected.push(`## ${d.type === 'user' ? '👤 User' : '🤖 Claude'}\n\n${text}`)
    used += text.length
    turns++
  }
  if (!turns) return null
  collected.reverse()

  const docs = listProjectDocs(cwd)
  const md = [
    '# 会话交接(来自 Claude Code)',
    '',
    `> 原会话历史过大,无法全量导入,以下是**最近的对话记录**(${turns} 条,时间正序)。`,
    `> 完整历史(供人工回查): \`${jsonlPath}\``,
    '',
    ...(docs.length
      ? ['## 项目文档(按需阅读,承载长期上下文)', '', ...docs.map((p) => `- \`${p}\``), '']
      : []),
    '## 近期对话',
    '',
    collected.join('\n\n'),
    '',
  ].join('\n')

  const dir = join(homedir(), '.kitty-kitty', 'handoff')
  mkdirSync(dir, { recursive: true })
  pruneOldHandoffs(dir)
  const file = join(dir, `claude-recent-${Date.now()}.md`)
  writeFileSync(file, md)
  return { file, turns }
}
