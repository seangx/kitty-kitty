/**
 * Skills Manager — bridges skillsmgr CLI into kitty-kitty
 *
 * All operations go through the skillsmgr CLI.
 * Text parsers are isolated functions, replaceable with JSON parsing
 * once skillsmgr adds --json support.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { log } from '../logger'
import type { SkillCategory, GroupInfo, SearchResult, NativeSkill } from '@shared/types/skills'

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

// ─── JSON Parsers ─────────────────────────────────────

function parseJson<T>(stdout: string, fallback: T): T {
  try {
    return JSON.parse(stdout)
  } catch {
    log('skills', `JSON parse failed: ${stdout.slice(0, 200)}`)
    return fallback
  }
}

function jsonToCategories(data: any): SkillCategory[] {
  if (!data?.skills || !Array.isArray(data.skills)) return []
  // Group by source/category
  const catMap = new Map<string, SkillCategory>()
  for (const s of data.skills) {
    const cat = s.source || s.category || 'unknown'
    if (!catMap.has(cat)) catMap.set(cat, { category: cat, skills: [] })
    catMap.get(cat)!.skills.push(s.name)
  }
  return [...catMap.values()].filter(c => c.skills.length > 0)
}

function jsonToDeployed(data: any): string[] {
  if (!data?.skills || !Array.isArray(data.skills)) return []
  return data.skills.map((s: any) => s.name || s).filter(Boolean)
}

function jsonToSearchResults(data: any): SearchResult[] {
  if (!data?.results || !Array.isArray(data.results)) return []
  return data.results.map((r: any) => ({
    name: r.name || '',
    version: r.version || '',
    description: r.description || '',
  }))
}

// ─── Operation Interfaces (all async) ──────────────────

const TOOL_AGENT_MAP: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex',
  shell: 'claude-code',
}

export async function listSkills(): Promise<{ categories: SkillCategory[]; groups: GroupInfo[] }> {
  const [listResult, groupListResult] = await Promise.all([
    runSkillsMgr(['list', '--json']),
    runSkillsMgr(['group', 'list']), // group subcommand doesn't support --json yet
  ])

  const categories = listResult.success
    ? jsonToCategories(parseJson(listResult.stdout, null))
    : []

  let groups: GroupInfo[] = []
  if (groupListResult.success) {
    // Try JSON first, fallback to text parsing
    try {
      const data = JSON.parse(groupListResult.stdout)
      groups = (data.groups || []).map((g: any) => ({
        name: g.name || '',
        skills: Array.isArray(g.skills) ? g.skills.map((s: any) => s.name || s) : [],
      }))
    } catch {
      // Text fallback: "groupName (N)"
      for (const line of groupListResult.stdout.split('\n')) {
        const match = line.match(/^(\S+)\s+\(\d+\)$/)
        if (match) groups.push({ name: match[1], skills: [] })
      }
    }
  }

  return { categories, groups }
}

export async function listDeployed(cwd: string): Promise<string[]> {
  const result = await runSkillsMgr(['list', '--deployed', '--json'], cwd)
  return result.success ? jsonToDeployed(parseJson(result.stdout, null)) : []
}

export async function addSkill(cwd: string, name: string, tool: string): Promise<{ success: boolean; message: string }> {
  const safeName = validateName(name)
  let result = await runSkillsMgr(['add', safeName, '--same-agents', '--json'], cwd)
  if (!result.success) {
    const agent = TOOL_AGENT_MAP[tool] || 'claude-code'
    result = await runSkillsMgr(['add', safeName, '-a', agent, '--json'], cwd)
  }
  if (result.success) {
    const data = parseJson<any>(result.stdout, null)
    return { success: true, message: data?.deployed?.[0]?.name ? `${data.deployed[0].name} 已部署` : `${safeName} 已部署` }
  }
  const errData = parseJson<any>(result.stdout || result.stderr, null)
  return { success: false, message: errData?.error || result.stderr.trim() || '部署失败' }
}

export async function removeSkill(cwd: string, name: string): Promise<{ success: boolean; message: string }> {
  const safeName = validateName(name)
  const result = await runSkillsMgr(['remove', safeName, '--same-agents', '--json'], cwd)
  if (result.success) {
    return { success: true, message: `${safeName} 已移除` }
  }
  const errData = parseJson<any>(result.stdout || result.stderr, null)
  return { success: false, message: errData?.error || result.stderr.trim() || '移除失败' }
}

export async function searchSkills(query: string): Promise<SearchResult[]> {
  const safeQuery = validateName(query)
  const result = await runSkillsMgr(['search', '--json', safeQuery])
  return result.success ? jsonToSearchResults(parseJson(result.stdout, null)) : []
}

export async function installSkill(name: string): Promise<{ success: boolean; message: string }> {
  const safeName = validateName(name)
  const result = await runSkillsMgr(['install', safeName, '--all', '--json'])
  if (result.success) {
    const data = parseJson<any>(result.stdout, null)
    return { success: true, message: data?.installed?.[0]?.name ? `${data.installed[0].name} 已安装` : `${safeName} 已安装` }
  }
  const errData = parseJson<any>(result.stdout || result.stderr, null)
  return { success: false, message: errData?.error || result.stderr.trim() || '安装失败' }
}

// ─── Native Skills Scanner ────────────────────────────

function scanDir(dir: string, ext: string): string[] {
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter(f => f.endsWith(ext)).map(f => basename(f, ext))
  } catch { return [] }
}

export function listNativeSkills(tool: string, cwd: string): NativeSkill[] {
  const skills: NativeSkill[] = []

  if (tool === 'claude' || tool === 'shell') {
    const home = homedir()

    // Global commands: ~/.claude/commands/*.md
    const globalCmds = join(home, '.claude', 'commands')
    for (const name of scanDir(globalCmds, '.md')) {
      skills.push({ name, source: 'command', path: join(globalCmds, name + '.md') })
    }

    // Project commands: <cwd>/.claude/commands/*.md
    if (cwd) {
      const projCmds = join(cwd, '.claude', 'commands')
      for (const name of scanDir(projCmds, '.md')) {
        skills.push({ name, source: 'project-command', path: join(projCmds, name + '.md') })
      }
    }

    // Plugins from installed_plugins.json
    const pluginsFile = join(home, '.claude', 'plugins', 'installed_plugins.json')
    try {
      if (existsSync(pluginsFile)) {
        const data = JSON.parse(readFileSync(pluginsFile, 'utf-8'))
        const settingsFile = join(home, '.claude', 'settings.json')
        let enabledPlugins: Record<string, boolean> = {}
        try {
          if (existsSync(settingsFile)) {
            const settings = JSON.parse(readFileSync(settingsFile, 'utf-8'))
            enabledPlugins = settings.enabledPlugins || {}
          }
        } catch { /* ignore */ }

        for (const [key, entries] of Object.entries(data.plugins || {})) {
          const entry = Array.isArray(entries) ? entries[0] : null
          if (!entry) continue
          const installPath = (entry as any).installPath || ''
          // Scan skills/ subdirectory inside plugin
          let children: string[] = []
          try {
            const skillsDir = join(installPath, 'skills')
            if (existsSync(skillsDir)) {
              children = readdirSync(skillsDir).filter(f => {
                try { return require('fs').statSync(join(skillsDir, f)).isDirectory() } catch { return false }
              })
            }
          } catch { /* ignore */ }
          skills.push({
            name: key,
            source: 'plugin',
            path: installPath,
            enabled: enabledPlugins[key] ?? false,
            children: children.length > 0 ? children : undefined,
          })
        }
      }
    } catch { /* ignore */ }
  }

  // TODO: add codex/aichat native skill scanning when directory structure is known

  return skills
}
