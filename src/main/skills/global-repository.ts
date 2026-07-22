import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

interface GlobalSkillPaths {
  home?: string
  codexHome?: string
}

/** Directories owned by skillsmgr's user-level deployment for each tool. */
export function globalSkillDirs(tool: string, paths: GlobalSkillPaths = {}): string[] {
  const home = paths.home || homedir()
  if (tool === 'codex') {
    const codexHome = paths.codexHome || process.env.CODEX_HOME?.trim() || join(home, '.codex')
    return [join(codexHome, 'skills')]
  }
  if (tool === 'opencode') return [join(home, '.config', 'opencode', 'skills')]
  return [join(home, '.claude', 'skills')]
}

/** Read the real managed deployment state, accepting both skill filename cases. */
export function listGlobalDeployedSkills(tool: string, paths: GlobalSkillPaths = {}): string[] {
  const names = new Set<string>()
  for (const dir of globalSkillDirs(tool, paths)) {
    if (!existsSync(dir)) continue
    try {
      for (const name of readdirSync(dir)) {
        const skillDir = join(dir, name)
        if (existsSync(join(skillDir, 'SKILL.md')) || existsSync(join(skillDir, 'skill.md'))) names.add(name)
      }
    } catch { /* optional user directory */ }
  }
  return [...names].sort()
}
