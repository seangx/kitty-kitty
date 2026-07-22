import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'

interface CliOutput {
  stdout: string
  stderr: string
  errorMessage?: string
}

export interface CentralMcpInfo {
  name: string
  description?: string
  source: 'central'
}

/** Return only a missing JSON definition path contained by centralDir. */
export function missingCentralDefinitionPath(result: CliOutput, centralDir: string): string | null {
  const output = `${result.stderr}\n${result.stdout}\n${result.errorMessage || ''}`
  const match = output.match(/ENOENT:[^\n]*open ['"]([^'"]+\.json)['"]/)
  if (!match) return null
  const target = resolve(match[1])
  const rel = relative(resolve(centralDir), target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return target
}

/** Scan both flat mcpsmgr definitions and nested scoped names. */
export function listCentralFromFs(centralDir: string): CentralMcpInfo[] {
  if (!existsSync(centralDir)) return []
  const out: CentralMcpInfo[] = []
  const scan = (dir: string, prefix = ''): void => {
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (name.startsWith('.')) continue
      const p = join(dir, name)
      const relativeName = prefix ? `${prefix}/${name}` : name
      try {
        const stat = statSync(p)
        if (stat.isFile() && name.endsWith('.json')) {
          const json = JSON.parse(readFileSync(p, 'utf-8'))
          const infoName = typeof json?.name === 'string'
            ? json.name
            : relativeName.slice(0, -5)
          const description = typeof json?.description === 'string'
            ? json.description.slice(0, 160)
            : undefined
          if (infoName) out.push({ name: infoName, description, source: 'central' })
        } else if (stat.isDirectory()) {
          const manifestPath = join(p, 'mcpsmgr.json')
          if (existsSync(manifestPath)) {
            const json = JSON.parse(readFileSync(manifestPath, 'utf-8'))
            const description = typeof json?.description === 'string'
              ? json.description.slice(0, 160)
              : undefined
            out.push({ name: relativeName, description, source: 'central' })
          } else {
            scan(p, relativeName)
          }
        }
      } catch { /* skip malformed entry */ }
    }
  }
  scan(centralDir)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
