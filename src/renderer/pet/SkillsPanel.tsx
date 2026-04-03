import { useState, useEffect, useCallback } from 'react'
import * as ipc from '../lib/ipc'
import type { SkillCategory, GroupInfo, SearchResult } from '@shared/types/skills'

interface Props {
  sessionId: string
  onClose: () => void
  onSay: (text: string, duration?: number) => void
  onDance: () => void
}

const C = {
  variant: '#23233f', container: '#17172f',
  text: '#e5e3ff', textDim: '#aaa8c3',
  primary: '#a7a5ff', primaryDim: '#645efb',
  outline: '#46465c', green: '#10b981', red: '#e11d48',
}

export default function SkillsPanel({ sessionId, onClose, onSay, onDance }: Props) {
  const [categories, setCategories] = useState<SkillCategory[]>([])
  const [groups, setGroups] = useState<GroupInfo[]>([])
  const [deployed, setDeployed] = useState<Set<string>>(new Set())
  const [available, setAvailable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [operating, setOperating] = useState<string | null>(null)

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)

  // Collapsed groups
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await ipc.listSkills(sessionId)
      setAvailable(data.available)
      setCategories(data.categories)
      setGroups(data.groups)
      setDeployed(new Set(data.deployed))
    } catch { /* ignore */ }
    setLoading(false)
  }, [sessionId])

  useEffect(() => { refresh() }, [refresh])

  const toggleSkill = async (skillName: string) => {
    setOperating(skillName)
    onDance()
    try {
      if (deployed.has(skillName)) {
        const res = await ipc.removeSkill(sessionId, skillName)
        onSay(res.success ? `${skillName} 已移除` : res.message, 3000)
      } else {
        const res = await ipc.addSkill(sessionId, skillName)
        onSay(res.success ? `${skillName} 已部署` : res.message, 3000)
      }
      await refresh()
    } catch (err: any) {
      onSay(err?.message || '操作失败', 3000)
    }
    setOperating(null)
  }

  const handleSearch = async () => {
    const q = searchQuery.trim()
    if (!q) { setSearchResults(null); return }
    setSearching(true)
    try {
      const { results } = await ipc.searchSkills(q)
      setSearchResults(results)
    } catch {
      setSearchResults([])
    }
    setSearching(false)
  }

  const handleInstall = async (name: string) => {
    setInstalling(name)
    onDance()
    try {
      const res = await ipc.installSkill(name)
      onSay(res.success ? `${name} 已安装` : res.message, 3000)
      if (res.success) await refresh()
    } catch (err: any) {
      onSay(err?.message || '安装失败', 3000)
    }
    setInstalling(null)
  }

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  // Collect all installed skill names for search result dedup
  const installedNames = new Set<string>()
  for (const cat of categories) {
    for (const s of cat.skills) installedNames.add(s)
  }

  return (
    <div style={{
      background: `${C.variant}f5`, backdropFilter: 'blur(32px)', WebkitBackdropFilter: 'blur(32px)',
      borderRadius: 16, padding: 14, width: 280, maxHeight: 400, overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      boxShadow: `0 12px 48px rgba(0,0,0,0.6), inset 0 1px 0 ${C.outline}20`,
      fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", color: C.text,
    }}>
      {/* Header */}
      <div data-drag-handle style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, cursor: 'grab', flexShrink: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>📦 技能管理</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textDim, cursor: 'pointer', fontSize: 16 }}>✕</button>
      </div>

      {/* Search */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexShrink: 0 }}>
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }}
          placeholder="搜索 registry..."
          style={{
            flex: 1, padding: '5px 10px', borderRadius: 8,
            border: `1px solid ${C.outline}33`, background: `${C.container}cc`,
            color: C.text, fontSize: 11, outline: 'none', fontFamily: 'inherit',
          }}
        />
        <button onClick={handleSearch} disabled={searching}
          style={{
            padding: '5px 10px', borderRadius: 8, border: 'none',
            background: `${C.primaryDim}`, color: '#fff', fontSize: 11,
            cursor: 'pointer', fontFamily: 'inherit', opacity: searching ? 0.5 : 1,
          }}
        >{searching ? '...' : '🔍'}</button>
      </div>

      {/* Scrollable content */}
      <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>

        {!available && (
          <div style={{ padding: 12, borderRadius: 8, background: `${C.red}22`, fontSize: 11, color: C.red, marginBottom: 8 }}>
            ⚠ skillsmgr 未安装<br />
            <span style={{ color: C.textDim }}>npm install -g skillsmgr</span>
          </div>
        )}

        {loading && available && (
          <div style={{ fontSize: 11, color: C.textDim, textAlign: 'center', padding: 20 }}>加载中...</div>
        )}

        {/* Search results */}
        {searchResults && searchResults.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: C.textDim, marginBottom: 4 }}>── 搜索结果 ──</div>
            {searchResults.map((r) => (
              <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name} <span style={{ color: C.textDim, fontSize: 10 }}>v{r.version}</span></div>
                  <div style={{ fontSize: 9, color: C.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description}</div>
                </div>
                {installedNames.has(r.name) ? (
                  <span style={{ fontSize: 9, color: C.green, flexShrink: 0 }}>已安装</span>
                ) : (
                  <button onClick={() => handleInstall(r.name)} disabled={installing === r.name}
                    style={{
                      padding: '2px 8px', borderRadius: 6, border: 'none',
                      background: C.green, color: '#fff', fontSize: 10,
                      cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
                      opacity: installing === r.name ? 0.5 : 1,
                    }}
                  >{installing === r.name ? '...' : '安装'}</button>
                )}
              </div>
            ))}
          </div>
        )}
        {searchResults && searchResults.length === 0 && (
          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 10 }}>无搜索结果</div>
        )}

        {/* Skill categories */}
        {!loading && categories.map((cat) => {
          const isCollapsed = collapsed.has(cat.category)
          return (
            <div key={cat.category} style={{ marginBottom: 6 }}>
              <div
                onClick={() => toggleCollapse(cat.category)}
                style={{ fontSize: 10, color: C.primaryDim, cursor: 'pointer', padding: '2px 0', userSelect: 'none' }}
              >
                {isCollapsed ? '▸' : '▾'} {cat.category} <span style={{ color: C.textDim }}>({cat.skills.length})</span>
              </div>
              {!isCollapsed && cat.skills.map((skill) => (
                <SkillRow
                  key={skill}
                  name={skill}
                  deployed={deployed.has(skill)}
                  operating={operating === skill}
                  onClick={() => toggleSkill(skill)}
                />
              ))}
            </div>
          )
        })}

        {/* Groups */}
        {!loading && groups.map((g) => {
          const key = `group:${g.name}`
          const isCollapsed = collapsed.has(key)
          return (
            <div key={key} style={{ marginBottom: 6 }}>
              <div
                onClick={() => toggleCollapse(key)}
                style={{ fontSize: 10, color: '#d97706', cursor: 'pointer', padding: '2px 0', userSelect: 'none' }}
              >
                {isCollapsed ? '▸' : '▾'} {g.name} <span style={{ color: C.textDim }}>(group · {g.skills.length})</span>
              </div>
              {!isCollapsed && g.skills.map((skill) => (
                <SkillRow
                  key={skill}
                  name={skill}
                  deployed={deployed.has(skill)}
                  operating={operating === skill}
                  onClick={() => toggleSkill(skill)}
                />
              ))}
            </div>
          )
        })}

        {!loading && available && categories.length === 0 && groups.length === 0 && (
          <div style={{ fontSize: 11, color: C.textDim, textAlign: 'center', padding: 16 }}>
            没有已安装的技能<br />
            <span style={{ fontSize: 10 }}>试试搜索 registry 安装</span>
          </div>
        )}
      </div>
    </div>
  )
}

function SkillRow({ name, deployed, operating, onClick }: {
  name: string; deployed: boolean; operating: boolean; onClick: () => void
}) {
  return (
    <div
      onClick={(e) => { e.stopPropagation(); if (!operating) onClick() }}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '3px 8px', cursor: operating ? 'wait' : 'pointer',
        borderRadius: 6, fontSize: 11, color: C.text,
        opacity: operating ? 0.5 : 1,
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `${C.primaryDim}22` }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none' }}
    >
      <span style={{ color: deployed ? C.green : C.textDim, fontSize: 12 }}>{deployed ? '●' : '○'}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
    </div>
  )
}
