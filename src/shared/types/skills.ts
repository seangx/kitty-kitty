export interface SkillCategory {
  category: string       // "official", "community", "custom", "registry"
  skills: string[]
}

export interface GroupInfo {
  name: string
  skills: string[]
}

export interface SearchResult {
  name: string
  version: string
  description: string
}

export interface NativeSkill {
  name: string
  source: 'command' | 'plugin' | 'project-command'
  path?: string
  enabled?: boolean
  children?: string[]   // sub-skills inside a plugin
}

export interface SkillsListResult {
  available: boolean           // whether skillsmgr CLI is installed
  categories: SkillCategory[]
  groups: GroupInfo[]
  deployed: string[]
  native: NativeSkill[]        // skills from agent's own directories
}

export interface SkillOpResult {
  success: boolean
  message: string
}
