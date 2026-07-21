import { useState, useEffect, useCallback, useRef } from 'react'
import * as ipc from '../lib/ipc'
import type { SkillCategory, GroupInfo, SearchResult, NativeSkill } from '@shared/types/skills'
import type { McpServerInfo } from '@shared/types/mcps'

interface Props {
  sessionId: string
  onClose: () => void
  onSay: (text: string, duration?: number) => void
  onDance: () => void
}

interface Toast {
  id: number
  text: string
  tone: 'info' | 'success' | 'error'
}

import { T, popover } from './ui-tokens'

// Neutral palette mapped onto the legacy token names used below — the layout
// and handlers are unchanged; only the color channels moved to ui-tokens.
const C = {
  variant: T.surface, container: T.well,
  text: T.text, textDim: T.faint,
  primary: '#8fe0d4', primaryDim: T.accent,
  outline: T.border, green: T.success, red: T.danger,
}

type Tab = 'skills' | 'mcps'

export default function SkillsPanel({ sessionId, onClose, onSay, onDance }: Props) {
  const [tab, setTab] = useState<Tab>('skills')
  const [categories, setCategories] = useState<SkillCategory[]>([])
  const [groups, setGroups] = useState<GroupInfo[]>([])
  const [deployed, setDeployed] = useState<Set<string>>(new Set())
  const [native, setNative] = useState<NativeSkill[]>([])
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

  // Inline toast so feedback reaches the user even when this panel is a detached window
  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notify = useCallback((text: string, tone: Toast['tone'] = 'info', duration = 3000) => {
    onSay(text, duration)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ id: Date.now(), text, tone })
    toastTimer.current = setTimeout(() => setToast(null), duration)
  }, [onSay])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await ipc.listSkills(sessionId)
      setAvailable(data.available)
      setCategories(data.categories)
      setGroups(data.groups)
      setDeployed(new Set(data.deployed))
      setNative(data.native || [])
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
        notify(res?.success ? `${skillName} 已移除` : (res?.message || '移除失败'), res?.success ? 'success' : 'error')
      } else {
        const res = await ipc.addSkill(sessionId, skillName)
        notify(res?.success ? `${skillName} 已部署` : (res?.message || '部署失败'), res?.success ? 'success' : 'error')
      }
      await refresh()
    } catch (err: any) {
      notify(err?.message || '操作失败', 'error')
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
    notify(`安装 ${name} 中…`, 'info', 15000)
    try {
      // `add` = 从 registry 拉取 + 部署到当前会话（install 只下载到仓库不部署）。
      const res = await ipc.addSkill(sessionId, name)
      if (!res) { notify('安装失败', 'error'); return }
      notify(res.success ? `${name} 已安装并部署` : (res.message || '安装失败'), res.success ? 'success' : 'error', 5000)
      if (res.success) await refresh()
    } catch (err: any) {
      notify(err?.message || '安装失败', 'error')
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

  const toggleGroup = async (skills: string[]) => {
    const allDeployed = skills.every((s) => deployed.has(s))
    setOperating('__group__')
    onDance()
    try {
      for (const skill of skills) {
        if (allDeployed) {
          await ipc.removeSkill(sessionId, skill)
        } else if (!deployed.has(skill)) {
          await ipc.addSkill(sessionId, skill)
        }
      }
      notify(allDeployed ? '已全部移除' : '已全部部署', 'success')
      await refresh()
    } catch (err: any) {
      notify(err?.message || '批量操作失败', 'error')
    }
    setOperating(null)
  }

  // Collect all installed skill names for search result dedup
  const installedNames = new Set<string>()
  for (const cat of categories) {
    for (const s of cat.skills) installedNames.add(s)
  }

  // ─── MCP tab state ─────────────────────────────────
  const [mcpAvailable, setMcpAvailable] = useState(true)
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpCentral, setMcpCentral] = useState<McpServerInfo[]>([])
  const [mcpDeployed, setMcpDeployed] = useState<Set<string>>(new Set())
  const [mcpOperating, setMcpOperating] = useState<string | null>(null)
  const [mcpInput, setMcpInput] = useState('')
  const [mcpManualOpen, setMcpManualOpen] = useState(false)
  const [mcpManualText, setMcpManualText] = useState('')

  const refreshMcps = useCallback(async () => {
    setMcpLoading(true)
    try {
      const data = await ipc.listMcps(sessionId)
      setMcpAvailable(data.available)
      setMcpCentral(data.central || [])
      setMcpDeployed(new Set(data.deployed || []))
    } catch { /* ignore */ }
    setMcpLoading(false)
  }, [sessionId])

  useEffect(() => { if (tab === 'mcps') refreshMcps() }, [tab, refreshMcps])

  const toggleMcp = async (name: string) => {
    setMcpOperating(name)
    onDance()
    try {
      const res = mcpDeployed.has(name)
        ? await ipc.removeMcp(sessionId, name)
        : await ipc.addMcp(sessionId, name)
      notify(res?.message || (res?.success ? '完成' : '失败'), res?.success ? 'success' : 'error')
      await refreshMcps()
    } catch (err: any) {
      notify(err?.message || '操作失败', 'error')
    }
    setMcpOperating(null)
  }

  const submitMcpManual = async () => {
    const txt = mcpManualText.trim()
    if (!txt) return
    setMcpOperating('__manual__')
    onDance()
    try {
      const res = await ipc.writeManualMcp(sessionId, txt)
      notify(res?.message || (res?.success ? '已写入' : '写入失败'), res?.success ? 'success' : 'error', 5000)
      if (res?.success) {
        setMcpManualText('')
        setMcpManualOpen(false)
        await refreshMcps()
      }
    } catch (err: any) {
      notify(err?.message || '写入失败', 'error')
    }
    setMcpOperating(null)
  }

  const addMcpFromInput = async () => {
    const src = mcpInput.trim()
    if (!src) return
    setMcpOperating(src)
    onDance()
    notify(`安装 ${src} 中…`, 'info', 15000)
    try {
      const res = await ipc.addMcp(sessionId, src)
      notify(res?.message || (res?.success ? '已添加' : '添加失败'), res?.success ? 'success' : 'error', 5000)
      if (res?.success) {
        setMcpInput('')
        await refreshMcps()
      }
    } catch (err: any) {
      notify(err?.message || '添加失败', 'error')
    }
    setMcpOperating(null)
  }

  return (
    <div style={{
      ...popover({ alpha: 'f5', radius: 16 }), padding: 18, overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div data-drag-handle style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, cursor: 'grab', flexShrink: 0 }}>
        <span style={{ fontSize: 18, fontWeight: 600 }}>📦 {tab === 'skills' ? '技能管理' : 'MCP 管理'}</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textDim, cursor: 'pointer', fontSize: 20 }}>✕</button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexShrink: 0 }}>
        {(['skills', 'mcps'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1, padding: '6px 10px', borderRadius: 8,
              border: `1px solid ${tab === t ? C.primaryDim : C.outline}66`,
              background: tab === t ? `${C.primaryDim}33` : 'transparent',
              color: tab === t ? C.primary : C.textDim,
              fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >{t === 'skills' ? '技能 (skillsmgr)' : 'MCP (mcpsmgr)'}</button>
        ))}
      </div>

      {/* Inline toast (survives in popup window where cat bubble isn't reachable) */}
      {toast && (
        <div
          key={toast.id}
          onClick={() => setToast(null)}
          style={{
            marginBottom: 10, padding: '8px 12px', borderRadius: 8,
            fontSize: 13, lineHeight: 1.4, cursor: 'pointer',
            background: toast.tone === 'success' ? `${C.green}22` : toast.tone === 'error' ? `${C.red}22` : `${C.primaryDim}22`,
            border: `1px solid ${toast.tone === 'success' ? C.green : toast.tone === 'error' ? C.red : C.primaryDim}66`,
            color: toast.tone === 'success' ? C.green : toast.tone === 'error' ? C.red : C.primary,
            wordBreak: 'break-word',
          }}
          title="点击关闭"
        >{toast.text}</div>
      )}

      {tab === 'skills' && <>
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
            color: C.text, fontSize: 14, outline: 'none', fontFamily: 'inherit',
          }}
        />
        <button onClick={handleSearch} disabled={searching}
          style={{
            padding: '5px 10px', borderRadius: 8, border: 'none',
            background: `${C.primaryDim}`, color: T.accentText, fontSize: 14,
            cursor: 'pointer', fontFamily: 'inherit', opacity: searching ? 0.5 : 1,
          }}
        >{searching ? '...' : '🔍'}</button>
      </div>

      {/* Scrollable content */}
      <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>

        {!available && (
          <div style={{ padding: 12, borderRadius: 8, background: `${C.red}22`, fontSize: 14, color: C.red, marginBottom: 8 }}>
            ⚠ skillsmgr 未安装<br />
            <span style={{ color: C.textDim }}>npm install -g skillsmgr</span>
          </div>
        )}

        {loading && available && (
          <div style={{ fontSize: 14, color: C.textDim, textAlign: 'center', padding: 20 }}>加载中...</div>
        )}

        {/* Search results */}
        {searchResults && searchResults.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 13, color: C.textDim, marginBottom: 6 }}>── 搜索结果 ──</div>
            {searchResults.map((r) => (
              <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name} <span style={{ color: C.textDim, fontSize: 12 }}>v{r.version}</span></div>
                  <div style={{ fontSize: 12, color: C.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description}</div>
                </div>
                {installedNames.has(r.name) ? (
                  <span style={{ fontSize: 12, color: C.green, flexShrink: 0 }}>已安装</span>
                ) : (
                   <button onClick={() => handleInstall(r.name)} disabled={installing === r.name}
                    style={{
                      padding: '4px 12px', borderRadius: 6, border: 'none',
                      background: C.green, color: T.accentText, fontSize: 13,
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
          <div style={{ fontSize: 14, color: C.textDim, marginBottom: 10 }}>无搜索结果</div>
        )}

        {/* Skill categories */}
        {!loading && categories.map((cat) => {
          const isCollapsed = collapsed.has(cat.category)
          const allDeployed = cat.skills.length > 0 && cat.skills.every((s) => deployed.has(s))
          const noneDeployed = cat.skills.every((s) => !deployed.has(s))
          return (
            <div key={cat.category} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0' }}>
                <div
                  onClick={() => toggleCollapse(cat.category)}
                  style={{ fontSize: 14, color: C.primaryDim, cursor: 'pointer', userSelect: 'none', flex: 1 }}
                >
                  {isCollapsed ? '▸' : '▾'} {cat.category} <span style={{ color: C.textDim }}>({cat.skills.length})</span>
                </div>
                {cat.skills.length > 1 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleGroup(cat.skills) }}
                    disabled={operating === '__group__'}
                    style={{
                      padding: '2px 8px', borderRadius: 6, border: `1px solid ${C.outline}44`,
                      background: allDeployed ? `${C.red}22` : `${C.green}22`,
                      color: allDeployed ? C.red : C.green,
                      fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
                      opacity: operating === '__group__' ? 0.5 : 1,
                    }}
                  >{operating === '__group__' ? '...' : allDeployed ? '全部移除' : noneDeployed ? '全部部署' : '补全部署'}</button>
                )}
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
          const allDeployed = g.skills.length > 0 && g.skills.every((s) => deployed.has(s))
          const noneDeployed = g.skills.every((s) => !deployed.has(s))
          return (
            <div key={key} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0' }}>
                <div
                  onClick={() => toggleCollapse(key)}
                  style={{ fontSize: 14, color: T.warning, cursor: 'pointer', userSelect: 'none', flex: 1 }}
                >
                  {isCollapsed ? '▸' : '▾'} {g.name} <span style={{ color: C.textDim }}>(group · {g.skills.length})</span>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); toggleGroup(g.skills) }}
                  disabled={operating === '__group__'}
                  style={{
                    padding: '2px 8px', borderRadius: 6, border: `1px solid ${C.outline}44`,
                    background: allDeployed ? `${C.red}22` : `${C.green}22`,
                    color: allDeployed ? C.red : C.green,
                    fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
                    opacity: operating === '__group__' ? 0.5 : 1,
                  }}
                >{operating === '__group__' ? '...' : allDeployed ? '全部移除' : noneDeployed ? '全部部署' : '补全部署'}</button>
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

        {/* Native skills (read-only) */}
        {!loading && native.length > 0 && (() => {
          const bySource: Record<string, NativeSkill[]> = {}
          for (const s of native) {
            const key =
              s.source === 'plugin' ? 'plugins'
              : s.source === 'skill' ? 'skills'
              : s.source === 'project-skill' ? 'project skills'
              : s.source === 'project-command' ? 'project commands'
              : 'commands'
            ;(bySource[key] ||= []).push(s)
          }
          return Object.entries(bySource).map(([source, items]) => {
            const key = `native:${source}`
            const isCollapsed = collapsed.has(key)
            return (
              <div key={key} style={{ marginBottom: 6 }}>
                <div
                  onClick={() => toggleCollapse(key)}
                  style={{ fontSize: 14, color: T.info, cursor: 'pointer', padding: '4px 0', userSelect: 'none' }}
                >
                  {isCollapsed ? '▸' : '▾'} {source} <span style={{ color: C.textDim }}>({items.length})</span>
                </div>
                {!isCollapsed && items.map((s) => {
                  const pluginKey = `native:plugin:${s.name}`
                  const pluginCollapsed = collapsed.has(pluginKey)
                  const displayName = s.name.replace(/@.*$/, '')
                  return (
                    <div key={s.name}>
                      <div
                        onClick={s.children?.length ? () => toggleCollapse(pluginKey) : undefined}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '5px 10px', fontSize: 14, color: C.text, borderRadius: 6,
                          cursor: s.children?.length ? 'pointer' : 'default',
                        }}
                      >
                        <span style={{ color: s.enabled !== false ? T.info : C.textDim, fontSize: 14 }}>
                          {s.enabled !== false ? '◆' : '◇'}
                        </span>
                        {s.children?.length
                          ? <span>{pluginCollapsed ? '▸' : '▾'} {displayName} <span style={{ fontSize: 12, color: C.textDim }}>({s.children.length})</span></span>
                          : <span>{displayName}</span>
                        }
                      </div>
                      {s.children && !pluginCollapsed && s.children.map((child) => (
                        <div key={child} style={{
                          padding: '3px 10px 3px 34px', fontSize: 13, color: C.textDim,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {child}
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            )
          })
        })()}

        {!loading && available && categories.length === 0 && groups.length === 0 && native.length === 0 && (
          <div style={{ fontSize: 14, color: C.textDim, textAlign: 'center', padding: 20 }}>
            没有已安装的技能<br />
            <span style={{ fontSize: 13 }}>试试搜索 registry 安装</span>
          </div>
        )}
      </div>
      </>}

      {tab === 'mcps' && <>
        {/* MCP add input */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexShrink: 0 }}>
          <input
            value={mcpInput}
            onChange={(e) => setMcpInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addMcpFromInput() }}
            placeholder="central 名 / owner/repo / GitHub URL"
            style={{
              flex: 1, padding: '5px 10px', borderRadius: 8,
              border: `1px solid ${C.outline}33`, background: `${C.container}cc`,
              color: C.text, fontSize: 14, outline: 'none', fontFamily: 'inherit',
            }}
          />
          <button
            onClick={addMcpFromInput}
            disabled={!!mcpOperating || !mcpInput.trim()}
            style={{
              padding: '5px 12px', borderRadius: 8, border: 'none',
              background: C.green, color: T.accentText, fontSize: 14,
              cursor: 'pointer', fontFamily: 'inherit',
              opacity: !!mcpOperating || !mcpInput.trim() ? 0.5 : 1,
            }}
          >添加</button>
        </div>

        {/* Manual paste JSON */}
        <div style={{ marginBottom: 10, flexShrink: 0 }}>
          <div
            onClick={() => setMcpManualOpen((v) => !v)}
            style={{ fontSize: 12, color: C.textDim, cursor: 'pointer', userSelect: 'none', padding: '2px 0' }}
          >
            {mcpManualOpen ? '▾' : '▸'} ✏️ 手动粘贴 JSON 写入项目配置
          </div>
          {mcpManualOpen && (
            <div style={{ marginTop: 6 }}>
              <textarea
                value={mcpManualText}
                onChange={(e) => setMcpManualText(e.target.value)}
                placeholder={'粘贴一段 mcpServers JSON，例如:\n{\n  "my-server": {\n    "command": "npx",\n    "args": ["-y", "..."]\n  }\n}\n\n也接受外层包 "mcpServers": { ... }'}
                spellCheck={false}
                style={{
                  width: '100%', minHeight: 140, padding: 8, borderRadius: 6,
                  border: `1px solid ${C.outline}55`, background: `${C.container}cc`,
                  color: C.text, fontSize: 12, fontFamily: 'ui-monospace, Menlo, monospace',
                  outline: 'none', resize: 'vertical', boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
                <button
                  onClick={submitMcpManual}
                  disabled={!!mcpOperating || !mcpManualText.trim()}
                  style={{
                    padding: '4px 12px', borderRadius: 6, border: 'none',
                    background: C.primaryDim, color: T.accentText, fontSize: 13,
                    cursor: 'pointer', fontFamily: 'inherit',
                    opacity: !!mcpOperating || !mcpManualText.trim() ? 0.5 : 1,
                  }}
                >{mcpOperating === '__manual__' ? '写入中…' : '写入'}</button>
                <span style={{ fontSize: 11, color: C.textDim }}>
                  目标:
                  同步写入 .mcp.json、.codex/config.toml 与 opencode.json
                </span>
              </div>
            </div>
          )}
        </div>

        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {!mcpAvailable && (
            <div style={{ padding: 12, borderRadius: 8, background: `${C.red}22`, fontSize: 14, color: C.red, marginBottom: 8 }}>
              ⚠ mcpsmgr 未安装<br />
              <span style={{ color: C.textDim }}>npm install -g mcpsmgr</span>
            </div>
          )}

          {mcpLoading && mcpAvailable && (
            <div style={{ fontSize: 14, color: C.textDim, textAlign: 'center', padding: 20 }}>加载中...</div>
          )}

          {!mcpLoading && mcpDeployed.size > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 13, color: C.textDim, marginBottom: 6 }}>── 当前项目已部署 ──</div>
              {[...mcpDeployed].map((name) => (
                <McpRow
                  key={`d:${name}`}
                  name={name}
                  deployed
                  operating={mcpOperating === name}
                  onClick={() => toggleMcp(name)}
                />
              ))}
            </div>
          )}

          {!mcpLoading && mcpCentral.length > 0 && (
            <div>
              <div style={{ fontSize: 13, color: C.textDim, marginBottom: 6 }}>── 中央仓库 ({mcpCentral.length}) ──</div>
              {mcpCentral.map((s) => (
                <McpRow
                  key={`c:${s.name}`}
                  name={s.name}
                  description={s.description}
                  deployed={mcpDeployed.has(s.name)}
                  operating={mcpOperating === s.name}
                  onClick={() => toggleMcp(s.name)}
                />
              ))}
            </div>
          )}

          {!mcpLoading && mcpAvailable && mcpCentral.length === 0 && mcpDeployed.size === 0 && (
            <div style={{ fontSize: 14, color: C.textDim, textAlign: 'center', padding: 20 }}>
              还没有任何 MCP server<br />
              <span style={{ fontSize: 13 }}>用上面的输入框添加 owner/repo</span>
            </div>
          )}
        </div>
      </>}
    </div>
  )
}

function McpRow({ name, description, deployed, operating, onClick }: {
  name: string; description?: string; deployed: boolean; operating: boolean; onClick: () => void
}) {
  return (
    <div
      onClick={(e) => { e.stopPropagation(); if (!operating) onClick() }}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', cursor: operating ? 'wait' : 'pointer',
        borderRadius: 6, fontSize: 14, color: C.text,
        opacity: operating ? 0.5 : 1,
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `${C.primaryDim}22` }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none' }}
    >
      <span style={{ color: deployed ? C.green : C.textDim, fontSize: 14, flexShrink: 0 }}>{deployed ? '●' : '○'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        {description && (
          <div style={{ fontSize: 12, color: C.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{description}</div>
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
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '5px 10px', cursor: operating ? 'wait' : 'pointer',
        borderRadius: 6, fontSize: 14, color: C.text,
        opacity: operating ? 0.5 : 1,
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `${C.primaryDim}22` }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none' }}
    >
      <span style={{ color: deployed ? C.green : C.textDim, fontSize: 14 }}>{deployed ? '●' : '○'}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
    </div>
  )
}
