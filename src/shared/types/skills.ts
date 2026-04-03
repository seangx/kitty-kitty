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

export interface SkillsListResult {
  available: boolean           // whether skillsmgr CLI is installed
  categories: SkillCategory[]
  groups: GroupInfo[]
  deployed: string[]
}

export interface SkillOpResult {
  success: boolean
  message: string
}
