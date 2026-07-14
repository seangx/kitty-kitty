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
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const SESSIONS_DIR = join(homedir(), '.codex', 'sessions')
const PER_MSG_CAP = 8000 // 单条消息截断,防单条粘贴大文件撑爆移交文档

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
    `> 本会话曾转交给 Codex(thread \`${threadId.slice(0, 8)}…\`)。以下是转交期间的对话,按时间排序;工具调用/推理过程已省略,只保留双方消息。`,
    '',
    parts.join('\n\n'),
    '',
  ].join('\n')

  const dir = join(homedir(), '.kitty-kitty', 'handoff')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `codex-${threadId.slice(0, 8)}-${Date.now()}.md`)
  writeFileSync(file, md)
  return { file, turns }
}
