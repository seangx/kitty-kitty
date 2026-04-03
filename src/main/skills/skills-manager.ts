/**
 * Skills Manager — bridges skillsmgr CLI into kitty-kitty
 *
 * All operations go through the skillsmgr CLI.
 * Text parsers are isolated functions, replaceable with JSON parsing
 * once skillsmgr adds --json support.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { log } from '../logger'
import type { SkillCategory, GroupInfo, SearchResult } from '@shared/types/skills'

const execFileAsync = promisify(execFile)

// ─── Input validation ──────────────────────────────────

const SAFE_NAME = /^[a-zA-Z0-9_@/.:-]+$/

function validateName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed || !SAFE_NAME.test(trimmed)) {
    throw new Error(`无效的技能名: ${trimmed}`)
  }
  return trimmed
}

// ─── CLI Runner (async, no shell) ──────────────────────

interface CliResult {
  success: boolean
  stdout: string
  stderr: string
}

let skillsMgrPath: string | null = null
let lastAvailableCheck = 0
const AVAILABLE_CHECK_TTL = 60_000 // re-check every 60s

async function resolveSkillsMgr(): Promise<string | null> {
  if (skillsMgrPath && Date.now() - lastAvailableCheck < AVAILABLE_CHECK_TTL) {
    return skillsMgrPath
  }
  try {
    const { stdout } = await execFileAsync('which', ['skillsmgr'], { encoding: 'utf-8' })
    skillsMgrPath = stdout.trim() || null
  } catch {
    skillsMgrPath = null
  }
  lastAvailableCheck = Date.now()
  return skillsMgrPath
}

export async function isAvailable(): Promise<boolean> {
  return (await resolveSkillsMgr()) !== null
}

async function runSkillsMgr(args: string[], cwd?: string): Promise<CliResult> {
  const bin = await resolveSkillsMgr()
  if (!bin) {
    return { success: false, stdout: '', stderr: 'skillsmgr 未安装。请运行: npm install -g skillsmgr' }
  }
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd,
      encoding: 'utf-8',
      timeout: 30000,
    })
    log('skills', `ok: skillsmgr ${args.join(' ')}`)
    return { success: true, stdout: stdout || '', stderr: stderr || '' }
  } catch (err: any) {
    const stdout = String(err?.stdout || '')
    const stderr = String(err?.stderr || err?.message || 'Unknown error')
    log('skills', `fail: skillsmgr ${args.join(' ')} → ${stderr.slice(0, 200)}`)
    return { success: false, stdout, stderr }
  }
}

// ─── Text Parsers (replace with JSON when available) ───

/**
 * Parse `skillsmgr list` output.
 *
 * Format:
 *   ── official (12 skills) ──
 *     anthropic (12)
 *       claude-api
 *       pdf
 *   ── custom (1 skill) ──
 *     example-skill
 */
export function parseList(stdout: string): SkillCategory[] {
  const catMap = new Map<string, SkillCategory>()
  let currentCategory = ''

  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd()

    // Category header: ── official (12 skills) ──
    const catMatch = line.match(/^──\s+(\S+)\s+\(\d+\s+skills?\)\s+──$/)
    if (catMatch) {
      currentCategory = catMatch[1]
      if (!catMap.has(currentCategory)) {
        catMap.set(currentCategory, { category: currentCategory, skills: [] })
      }
      continue
    }

    if (!currentCategory) continue

    // Source header (2-space indent): "  anthropic (12)" — skip, just a grouping label
    if (line.match(/^  \S+\s+\(\d+\)$/)) continue

    // Skill name (4-space indent under source)
    const skill4 = line.match(/^    (\S+)$/)
    if (skill4) {
      catMap.get(currentCategory)!.skills.push(skill4[1])
      continue
    }

    // Skill name (2-space indent, for categories without source like custom)
    const skill2 = line.match(/^  (\S+)$/)
    if (skill2 && !line.includes('(')) {
      catMap.get(currentCategory)!.skills.push(skill2[1])
      continue
    }
  }

  return [...catMap.values()].filter((c) => c.skills.length > 0)
}

/**
 * Parse `skillsmgr list --deployed` output.
 */
export function parseDeployed(stdout: string): string[] {
  const deployed: string[] = []
  for (const line of stdout.split('\n')) {
    const match = line.match(/◉\s+(\S+)/)
    if (match) {
      deployed.push(match[1])
    }
  }
  return deployed
}

/**
 * Parse `skillsmgr search` output.
 */
export function parseSearch(stdout: string): SearchResult[] {
  const results: SearchResult[] = []
  const lines = stdout.split('\n')
  let started = false
  for (const line of lines) {
    if (line.startsWith('NAME')) { started = true; continue }
    if (!started) continue
    if (!line.trim() || line.match(/^\d+ of \d+ results/)) break
    const parts = line.trim().split(/\s{2,}/)
    if (parts.length >= 2) {
      results.push({
        name: parts[0],
        version: parts[1],
        description: parts.slice(2).join(' '),
      })
    }
  }
  return results
}

/**
 * Parse `skillsmgr group list` output.
 */
export function parseGroupList(stdout: string): GroupInfo[] {
  const groups: GroupInfo[] = []
  for (const line of stdout.split('\n')) {
    const match = line.match(/^(\S+)\s+\(\d+\)$/)
    if (match) {
      groups.push({ name: match[1], skills: [] })
    }
  }
  return groups
}

export function parseGroupDetail(stdout: string): string[] {
  const skills: string[] = []
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s+(\S+)\s+\(/)
    if (match) {
      skills.push(match[1])
    }
  }
  return skills
}

// ─── Operation Interfaces (all async) ──────────────────

const TOOL_AGENT_MAP: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex',
  shell: 'claude-code',
}

export async function listSkills(): Promise<{ categories: SkillCategory[]; groups: GroupInfo[] }> {
  // Run list + group list in parallel
  const [listResult, groupListResult] = await Promise.all([
    runSkillsMgr(['list']),
    runSkillsMgr(['group', 'list']),
  ])

  const categories = listResult.success ? parseList(listResult.stdout) : []

  let groups: GroupInfo[] = []
  if (groupListResult.success) {
    groups = parseGroupList(groupListResult.stdout)
    // Fetch all group details in parallel
    if (groups.length > 0) {
      const details = await Promise.all(
        groups.map((g) => runSkillsMgr(['group', 'list', g.name]))
      )
      for (let i = 0; i < groups.length; i++) {
        if (details[i].success) {
          groups[i].skills = parseGroupDetail(details[i].stdout)
        }
      }
    }
  }

  return { categories, groups }
}

export async function listDeployed(cwd: string): Promise<string[]> {
  const result = await runSkillsMgr(['list', '--deployed'], cwd)
  return result.success ? parseDeployed(result.stdout) : []
}

export async function addSkill(cwd: string, name: string, tool: string): Promise<{ success: boolean; message: string }> {
  const safeName = validateName(name)
  // Try --same-agents first
  let result = await runSkillsMgr(['add', safeName, '--same-agents', '-y'], cwd)
  if (!result.success) {
    // Fallback: use mapped agent
    const agent = TOOL_AGENT_MAP[tool] || 'claude-code'
    result = await runSkillsMgr(['add', safeName, '-a', agent, '-y'], cwd)
  }
  return {
    success: result.success,
    message: result.success ? (result.stdout.trim() || `${safeName} 已部署`) : (result.stderr.trim() || '部署失败'),
  }
}

export async function removeSkill(cwd: string, name: string): Promise<{ success: boolean; message: string }> {
  const safeName = validateName(name)
  const result = await runSkillsMgr(['remove', safeName, '--same-agents', '-y'], cwd)
  return {
    success: result.success,
    message: result.success ? (result.stdout.trim() || `${safeName} 已移除`) : (result.stderr.trim() || '移除失败'),
  }
}

export async function searchSkills(query: string): Promise<SearchResult[]> {
  const safeQuery = validateName(query)
  const result = await runSkillsMgr(['search', safeQuery])
  return result.success ? parseSearch(result.stdout) : []
}

export async function installSkill(name: string): Promise<{ success: boolean; message: string }> {
  const safeName = validateName(name)
  const result = await runSkillsMgr(['install', safeName, '--all'])
  return {
    success: result.success,
    message: result.success ? (result.stdout.trim() || `${safeName} 已安装`) : (result.stderr.trim() || '安装失败'),
  }
}
