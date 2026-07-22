import { useState, useEffect, useCallback, useRef } from 'react'
import * as ipc from '../lib/ipc'
import type { SkillCategory, GroupInfo, SearchResult, NativeSkill } from '@shared/types/skills'
import type { McpServerInfo } from '@shared/types/mcps'
import { T, btnClose, popover, popupHeader } from './ui-tokens'

interface Props {
  sessionId?: string
  onClose: () => void
  onSay: (text: string, duration?: number) => void
  onDance: () => void
}

interface Toast {
  id: number
  text: string
  tone: 'info' | 'success' | 'error'
  actionLabel?: string
  action?: () => void
}

interface ConfirmState {
  title: string
  body: string
  names?: string
  confirmLabel: string
  onConfirm: () => void
}

type Tab = 'skills' | 'mcps'

// Neutral palette mapped onto semantic names (see ui-tokens.ts).
const C = {
  text: T.text,
  textDim: T.faint,
  accent: T.accent,
  border: T.border,
  well: T.well,
  green: T.success,
  red: T.danger,
  info: T.info,
  warning: T.warning,
}

const UNDO_MS = 5000

export default function SkillsPanel({ sessionId, onClose, onSay, onDance }: Props) {
  const isGlobal = !sessionId
  const scopeSessionId = sessionId || ''
  const [tab, setTab] = useState<Tab>('skills')
  const [categories, setCategories] = useState<SkillCategory[]>([])
  const [groups, setGroups] = useState<GroupInfo[]>([])
  const [deployed, setDeployed] = useState<Set<string>>(new Set())
  const [native, setNative] = useState<NativeSkill[]>([])
  const [available, setAvailable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [operating, setOperating] = useState<string | null>(null)

  // Search mode replaces the manage list instead of mixing into it
  const [mode, setMode] = useState<'manage' | 'search'>('manage')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)

  // Collapsed groups
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  // Selected skill → pinned detail card (registry info lazy-loaded)
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedInfo, setSelectedInfo] = useState<SearchResult | null | 'loading' | 'missing'>(null)

  // Inline toast with optional undo action (survives in detached popup window)
  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notify = useCallback((text: string, tone: Toast['tone'] = 'info', duration = 3000, action?: { label: string; run: () => void }) => {
    onSay(text, duration)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ id: Date.now(), text, tone, actionLabel: action?.label, action: action?.run })
    toastTimer.current = setTimeout(() => setToast(null), duration)
  }, [onSay])

  const [confirm, setConfirm] = useState<ConfirmState | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await ipc.listSkills(scopeSessionId)
      setAvailable(data.available)
      setCategories(data.categories)
      setGroups(data.groups)
      setDeployed(new Set(data.deployed))
      setNative(data.native || [])
    } catch { /* ignore */ }
    setLoading(false)
  }, [scopeSessionId])

  useEffect(() => { refresh() }, [refresh])

  // Lazy registry lookup for the selected skill's detail card
  useEffect(() => {
    if (!selected) { setSelectedInfo(null); return }
    let cancelled = false
    setSelectedInfo('loading')
    ipc.searchSkills(selected)
      .then(({ results }) => {
        if (cancelled) return
        const exact = results.find((r) => r.name === selected)
        setSelectedInfo(exact ?? 'missing')
      })
      .catch(() => { if (!cancelled) setSelectedInfo('missing') })
    return () => { cancelled = true }
  }, [selected])

  const deploySkill = useCallback(async (skillName: string) => {
    setOperating(skillName)
    onDance()
    try {
      const res = await ipc.addSkill(scopeSessionId, skillName)
      notify(res?.success ? `${skillName} 已部署` : (res?.message || '部署失败'), res?.success ? 'success' : 'error')
      await refresh()
    } catch (err: any) {
      notify(err?.message || '操作失败', 'error')
    }
    setOperating(null)
  }, [scopeSessionId, onDance, notify, refresh])

  const removeSkillWithUndo = useCallback(async (skillName: string) => {
    setOperating(skillName)
    onDance()
    try {
      const res = await ipc.removeSkill(scopeSessionId, skillName)
      if (res?.success) {
        notify(`已移除「${skillName}」的部署`, 'success', UNDO_MS, {
          label: '撤销',
          run: () => { void deploySkill(skillName) },
        })
      } else {
        notify(res?.message || '移除失败', 'error')
      }
      await refresh()
    } catch (err: any) {
      notify(err?.message || '操作失败', 'error')
    }
    setOperating(null)
  }, [scopeSessionId, onDance, notify, refresh, deploySkill])

  const toggleSkill = useCallback((skillName: string) => {
    if (operating === skillName) return
    if (deployed.has(skillName)) void removeSkillWithUndo(skillName)
    else void deploySkill(skillName)
  }, [operating, deployed, removeSkillWithUndo, deploySkill])

  const handleSearch = async () => {
    const q = searchQuery.trim()
    if (!q) return
    setMode('search')
    setSearching(true)
    try {
      const { results } = await ipc.searchSkills(q)
      setSearchResults(results)
    } catch {
      setSearchResults([])
    }
    setSearching(false)
  }

  const exitSearch = () => {
    setMode('manage')
    setSearchQuery('')
    setSearchResults(null)
  }

  const handleInstall = async (name: string) => {
    setInstalling(name)
    onDance()
    notify(`安装 ${name} 中…`, 'info', 15000)
    try {
      const res = isGlobal
        ? await ipc.installSkill(name)
        : await ipc.addSkill(scopeSessionId, name)
      if (!res) { notify('安装失败', 'error'); return }
      notify(
        res.success ? (isGlobal ? `${name} 已安装到全局仓库` : `${name} 已安装并部署`) : (res.message || '安装失败'),
        res.success ? 'success' : 'error',
        5000,
      )
      if (res.success) await refresh()
    } catch (err: any) {
      notify(err?.message || '安装失败', 'error')
    }
    setInstalling(null)
  }

  const uninstallGlobalSkill = useCallback(async (name: string) => {
    setOperating(name)
    onDance()
    try {
      const res = await ipc.uninstallSkill(name)
      notify(res?.message || (res?.success ? '已卸载' : '卸载失败'), res?.success ? 'success' : 'error')
      if (res?.success) {
        setSelected((current) => current === name ? null : current)
        await refresh()
      }
    } catch (err: any) {
      notify(err?.message || '卸载失败', 'error')
    }
    setOperating(null)
  }, [notify, onDance, refresh])

  const confirmUninstallGlobalSkill = useCallback((name: string) => {
    setConfirm({
      title: `卸载「${name}」？`,
      body: '将从 skillsmgr 全局仓库卸载该技能，并清理它登记的全局部署。',
      confirmLabel: '卸载',
      onConfirm: () => { void uninstallGlobalSkill(name) },
    })
  }, [uninstallGlobalSkill])

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const deployAll = async (skills: string[]) => {
    setOperating('__group__')
    onDance()
    try {
      for (const skill of skills) {
        if (!deployed.has(skill)) await ipc.addSkill(scopeSessionId, skill)
      }
      notify(`已部署全部 ${skills.length} 个技能`, 'success')
      await refresh()
    } catch (err: any) {
      notify(err?.message || '批量操作失败', 'error')
    }
    setOperating(null)
  }

  const removeAll = (label: string, skills: string[]) => {
    setConfirm({
      title: `移除「${label}」的全部部署？`,
      body: `将从当前会话移除 ${skills.length} 个技能的部署。技能文件保留在本地仓库，可随时重新部署。`,
      names: skills.join('、'),
      confirmLabel: `移除 ${skills.length} 个`,
      onConfirm: async () => {
        setOperating('__group__')
        onDance()
        try {
          for (const skill of skills) await ipc.removeSkill(scopeSessionId, skill)
          notify(`已移除 ${skills.length} 个部署`, 'success', UNDO_MS, {
            label: '撤销',
            run: () => { void deployAll(skills) },
          })
          await refresh()
        } catch (err: any) {
          notify(err?.message || '批量操作失败', 'error')
        }
        setOperating(null)
      },
    })
  }

  // Collect all installed skill names for search result dedup
  const installedNames = new Set<string>()
  for (const cat of categories) {
    for (const s of cat.skills) installedNames.add(s)
  }
  for (const g of groups) {
    for (const s of g.skills) installedNames.add(s)
  }

  const sourcesOf = useCallback((name: string): string[] => {
    const sources: string[] = []
    for (const cat of categories) if (cat.skills.includes(name)) sources.push(cat.category)
    for (const g of groups) if (g.skills.includes(name)) sources.push(`组合包 ${g.name}`)
    for (const n of native) if (n.name === name) sources.push(`内置 ${n.source}`)
    return sources
  }, [categories, groups, native])

  // ─── MCP tab state ─────────────────────────────────
  const [mcpAvailable, setMcpAvailable] = useState(true)
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpCentral, setMcpCentral] = useState<McpServerInfo[]>([])
  const [mcpDeployed, setMcpDeployed] = useState<Set<string>>(new Set())
  const [mcpOperating, setMcpOperating] = useState<string | null>(null)
  const [mcpInput, setMcpInput] = useState('')
  const [mcpManualOpen, setMcpManualOpen] = useState(false)
  const [mcpManualText, setMcpManualText] = useState('')
  const [mcpManualError, setMcpManualError] = useState(false)
  const [mcpExpanded, setMcpExpanded] = useState<string | null>(null)

  const refreshMcps = useCallback(async () => {
    setMcpLoading(true)
    try {
      const data = await ipc.listMcps(scopeSessionId)
      setMcpAvailable(data.available)
      setMcpCentral(data.central || [])
      setMcpDeployed(new Set(data.deployed || []))
    } catch { /* ignore */ }
    setMcpLoading(false)
  }, [scopeSessionId])

  useEffect(() => { if (tab === 'mcps') refreshMcps() }, [tab, refreshMcps])

  const addMcp = useCallback(async (name: string) => {
    setMcpOperating(name)
    onDance()
    try {
      const res = isGlobal
        ? await ipc.installMcp(name)
        : await ipc.addMcp(scopeSessionId, name)
      notify(res?.message || (res?.success ? '已添加' : '添加失败'), res?.success ? 'success' : 'error')
      await refreshMcps()
    } catch (err: any) {
      notify(err?.message || '操作失败', 'error')
    }
    setMcpOperating(null)
  }, [isGlobal, scopeSessionId, onDance, notify, refreshMcps])

  const removeMcpWithUndo = useCallback(async (name: string) => {
    setMcpOperating(name)
    onDance()
    try {
      const res = isGlobal
        ? await ipc.uninstallMcp(name)
        : await ipc.removeMcp(scopeSessionId, name)
      if (res?.success) {
        if (isGlobal) notify(`已从全局仓库卸载「${name}」`, 'success')
        else notify(`已移除「${name}」`, 'success', UNDO_MS, {
            label: '撤销',
            run: () => { void addMcp(name) },
          })
      } else {
        notify(res?.message || '移除失败', 'error')
      }
      await refreshMcps()
    } catch (err: any) {
      notify(err?.message || '操作失败', 'error')
    }
    setMcpOperating(null)
  }, [isGlobal, scopeSessionId, onDance, notify, refreshMcps, addMcp])

  const toggleMcp = (name: string) => {
    if (mcpOperating) return
    if (mcpDeployed.has(name)) void removeMcpWithUndo(name)
    else void addMcp(name)
  }

  const confirmUninstallGlobalMcp = (name: string) => {
    setConfirm({
      title: `卸载 MCP「${name}」？`,
      body: '将从 mcpsmgr 中央仓库移除该定义；已经写入项目的配置不会被自动删除。',
      confirmLabel: '卸载',
      onConfirm: () => { void removeMcpWithUndo(name) },
    })
  }

  const submitMcpManual = async () => {
    const txt = mcpManualText.trim()
    if (!txt) return
    try {
      const parsed = JSON.parse(txt)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    } catch {
      setMcpManualError(true)
      return
    }
    setMcpManualError(false)
    setMcpOperating('__manual__')
    onDance()
    try {
      const res = await ipc.writeManualMcp(scopeSessionId, txt)
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
    notify(`安装 ${src} 中…`, 'info', 15000)
    await addMcp(src)
    setMcpInput('')
  }

  const mcpCentralInfo = useCallback((name: string) => mcpCentral.find((s) => s.name === name), [mcpCentral])

  // ─── shared renderers ─────────────────────────────
  const renderSwitch = (on: boolean, disabled: boolean, onToggle: () => void, title: string) => (
    <div
      onClick={(e) => { e.stopPropagation(); if (!disabled) onToggle() }}
      title={title}
      style={{
        position: 'relative', width: 30, height: 17, flexShrink: 0,
        borderRadius: 999, border: `1px solid ${on ? C.accent : `${C.border}3d`}`,
        background: on ? C.accent : 'rgba(255,255,255,0.07)',
        cursor: disabled ? 'wait' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 0.15s, border-color 0.15s',
      }}
    >
      <div style={{
        position: 'absolute', top: 1.5, left: on ? 14 : 2,
        width: 12, height: 12, borderRadius: '50%',
        background: on ? '#0c1214' : '#c9cede',
        transition: 'left 0.15s, background 0.15s',
      }} />
    </div>
  )

  const renderSkillRow = (skill: string) => {
    const on = isGlobal || deployed.has(skill)
    return (
      <div
        key={skill}
        onClick={() => setSelected(selected === skill ? null : skill)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '5px 10px', borderRadius: 6, fontSize: 14,
          cursor: 'pointer',
          border: `1px solid ${selected === skill ? `${C.accent}44` : 'transparent'}`,
          background: selected === skill ? `${C.accent}14` : 'none',
          opacity: on ? 1 : 0.5,
          color: on ? C.text : C.textDim,
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{skill}</span>
        {isGlobal
          ? <button
              onClick={(event) => { event.stopPropagation(); confirmUninstallGlobalSkill(skill) }}
              disabled={operating === skill}
              style={{ border: 'none', background: 'none', color: C.red, fontSize: 11, cursor: 'pointer', opacity: operating === skill ? 0.5 : 1 }}
            >卸载</button>
          : renderSwitch(on, operating === skill, () => toggleSkill(skill), on ? '点击移除部署' : '点击部署')}
      </div>
    )
  }

  const renderDetailCard = () => {
    if (!selected || mode !== 'manage') return null
    const on = isGlobal || deployed.has(selected)
    const sources = sourcesOf(selected)
    return (
      <div style={{
        margin: '0 0 10px', padding: '10px 12px', borderRadius: 10,
        border: `1px solid ${C.border}1c`, background: `${C.well}aa`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected}</span>
          <span style={{ fontSize: 11, color: on ? C.green : C.textDim }}>
            {isGlobal ? '已安装' : on ? '已部署' : '未部署'}
          </span>
          <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', color: C.textDim, cursor: 'pointer', fontSize: 13 }}>✕</button>
        </div>
        {selectedInfo === 'loading' && <div style={{ fontSize: 12, color: C.textDim }}>查询 registry…</div>}
        {selectedInfo === 'missing' && <div style={{ fontSize: 12, color: C.textDim }}>本地仓库技能（registry 中未找到同名条目）</div>}
        {selectedInfo && selectedInfo !== 'loading' && selectedInfo !== 'missing' && (
          <>
            <div style={{ fontSize: 12, color: C.text, marginBottom: 4 }}>
              v{selectedInfo.version}
            </div>
            <div style={{ fontSize: 12, color: C.textDim, lineHeight: 1.6 }}>{selectedInfo.description}</div>
          </>
        )}
        {sources.length > 0 && (
          <div style={{ fontSize: 11, color: C.textDim, marginTop: 6 }}>
            归属：{sources.join(' · ')}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button
            onClick={() => isGlobal ? confirmUninstallGlobalSkill(selected) : toggleSkill(selected)}
            disabled={operating === selected}
            style={{
              padding: '4px 14px', borderRadius: 7,
              border: `1px solid ${on ? `${C.red}55` : `${C.accent}55`}`,
              background: on ? `${C.red}1c` : `${C.accent}1c`,
              color: on ? C.red : C.accent,
              fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
              opacity: operating === selected ? 0.5 : 1,
            }}
          >{isGlobal ? '从全局仓库卸载' : on ? '移除部署' : '部署到当前会话'}</button>
        </div>
      </div>
    )
  }

  const renderCatBlock = (title: string, skills: string[], kind: 'cat' | 'group') => {
    const key = `${kind}:${title}`
    const allDeployed = skills.length > 0 && skills.every((s) => deployed.has(s))
    const noneDeployed = skills.every((s) => !deployed.has(s))
    const isCollapsed = collapsed.has(key)
    return (
      <div key={key} style={{ marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0' }}>
          <div
            onClick={() => toggleCollapse(key)}
            style={{ fontSize: 14, color: kind === 'group' ? C.warning : C.accent, cursor: 'pointer', userSelect: 'none', flex: 1 }}
          >
            {isCollapsed ? '▸' : '▾'} {title} <span style={{ color: C.textDim }}>{kind === 'group' ? `(组合包 · ${skills.length})` : `(${skills.length})`}</span>
          </div>
          {!isGlobal && skills.length > 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); allDeployed ? removeAll(title, skills) : void deployAll(skills) }}
              disabled={operating === '__group__'}
              style={{
                padding: '2px 8px', borderRadius: 6, border: `1px solid ${C.border}2e`,
                background: allDeployed ? `${C.red}1c` : `${C.green}1c`,
                color: allDeployed ? C.red : C.green,
                fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
                opacity: operating === '__group__' ? 0.5 : 1,
              }}
            >{operating === '__group__' ? '...' : allDeployed ? '全部移除' : noneDeployed ? '全部部署' : '补全部署'}</button>
          )}
        </div>
        {!isCollapsed && skills.map((skill) => renderSkillRow(skill))}
      </div>
    )
  }

  const deployedSorted = [...deployed].sort()

  return (
    <div style={{
      ...popover({ alpha: 'f5', radius: 16 }), padding: 18, overflow: 'hidden',
      display: 'flex', flexDirection: 'column', position: 'relative',
    }}>
      {/* Header */}
      <div data-drag-handle style={{ ...popupHeader(), marginBottom: 10, flexShrink: 0 }}>
        <span style={{ fontSize: 18, fontWeight: 600 }}>📦 {isGlobal ? '全局 ' : ''}{tab === 'skills' ? '技能管理' : 'MCP 管理'}</span>
        <button onClick={onClose} style={{ ...btnClose(), fontSize: 20 }}>✕</button>
      </div>

      {/* Scope banner */}
      <div style={{
        marginBottom: 10, padding: '6px 10px', borderRadius: 8, flexShrink: 0,
        fontSize: 11, color: C.textDim,
        background: `${C.accent}12`, border: `1px solid ${C.accent}30`,
      }}>
        {isGlobal
          ? <>安装/卸载作用于 <b style={{ color: C.accent }}>skillsmgr / mcpsmgr 全局仓库</b></>
          : <>部署/移除仅作用于<b style={{ color: C.accent }}>当前会话</b>的运行环境</>}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexShrink: 0 }}>
        {(['skills', 'mcps'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1, padding: '6px 10px', borderRadius: 8,
              border: `1px solid ${tab === t ? `${C.accent}66` : `${C.border}1c`}`,
              background: tab === t ? `${C.accent}1c` : 'transparent',
              color: tab === t ? C.accent : C.textDim,
              fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >{t === 'skills' ? '技能 (skillsmgr)' : 'MCP (mcpsmgr)'}</button>
        ))}
      </div>

      {/* Inline toast (with optional undo action) */}
      {toast && (
        <div
          key={toast.id}
          onClick={() => setToast(null)}
          style={{
            marginBottom: 10, padding: '8px 12px', borderRadius: 8,
            fontSize: 13, lineHeight: 1.4, cursor: 'pointer', flexShrink: 0,
            display: 'flex', alignItems: 'center', gap: 8,
            background: toast.tone === 'success' ? `${C.green}22` : toast.tone === 'error' ? `${C.red}22` : `${C.accent}1c`,
            border: `1px solid ${toast.tone === 'success' ? C.green : toast.tone === 'error' ? C.red : C.accent}66`,
            color: toast.tone === 'success' ? C.green : toast.tone === 'error' ? C.red : C.accent,
            wordBreak: 'break-word',
          }}
          title="点击关闭"
        >
          <span style={{ flex: 1 }}>{toast.text}</span>
          {toast.action && (
            <button
              onClick={(e) => { e.stopPropagation(); toast.action?.(); setToast(null) }}
              style={{
                background: 'none', border: 'none', color: C.accent,
                fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
              }}
            >{toast.actionLabel}</button>
          )}
        </div>
      )}

      {tab === 'skills' && <>
      {/* Search */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexShrink: 0 }}>
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch() }}
          placeholder="搜索 registry，回车进入搜索…"
          style={{
            flex: 1, padding: '5px 10px', borderRadius: 8,
            border: `1px solid ${C.border}1c`, background: `${C.well}cc`,
            color: C.text, fontSize: 14, outline: 'none', fontFamily: 'inherit',
          }}
        />
        <button onClick={() => void handleSearch()} disabled={searching}
          style={{
            padding: '5px 10px', borderRadius: 8, border: 'none',
            background: C.accent, color: '#0c1214', fontSize: 14,
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

        {mode === 'search' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <button
                onClick={exitSearch}
                style={{
                  padding: '3px 10px', borderRadius: 7, fontSize: 11,
                  border: `1px solid ${C.border}1c`, background: 'none', color: C.text,
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >← 返回已安装</button>
              <span style={{ fontSize: 12, color: C.textDim }}>
                {searching ? '搜索中…' : `“${searchQuery}” · ${searchResults?.length ?? 0} 个结果`}
              </span>
            </div>
            {!searching && searchResults && searchResults.length === 0 && (
              <div style={{ fontSize: 14, color: C.textDim, marginBottom: 10 }}>没有匹配的 registry 条目</div>
            )}
            {!searching && searchResults?.map((r) => (
              <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name} <span style={{ color: C.textDim, fontSize: 12 }}>v{r.version}</span></div>
                  <div style={{ fontSize: 12, color: C.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description}</div>
                </div>
                {installedNames.has(r.name) ? (
                  <span style={{ fontSize: 12, color: C.green, flexShrink: 0 }}>✓ 已安装</span>
                ) : (
                  <button onClick={() => handleInstall(r.name)} disabled={installing === r.name}
                    style={{
                      padding: '4px 12px', borderRadius: 6, border: 'none',
                      background: C.green, color: '#0c1214', fontSize: 13, fontWeight: 600,
                      cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
                      opacity: installing === r.name ? 0.5 : 1,
                    }}
                  >{installing === r.name ? '...' : '安装'}</button>
                )}
              </div>
            ))}
          </>
        )}

        {mode === 'manage' && <>
          {loading && available && (
            <div style={{ fontSize: 14, color: C.textDim, textAlign: 'center', padding: 20 }}>加载中...</div>
          )}

          {/* Deployed zone — at-a-glance answer to "这个会话激活了哪些技能" */}
          {!isGlobal && !loading && available && (
            <div style={{
              border: `1px solid ${C.accent}3d`, background: `${C.accent}0a`,
              borderRadius: 12, padding: '6px 6px 4px', marginBottom: 10,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px 7px' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: C.accent }}>● 已部署到当前会话</span>
                <span style={{
                  fontSize: 10.5, color: C.textDim,
                  background: `${C.accent}1c`, borderRadius: 999, padding: '1px 8px',
                }}>{deployedSorted.length}</span>
              </div>
              {deployedSorted.length === 0 && (
                <div style={{ fontSize: 11.5, color: C.textDim, padding: '2px 4px 6px' }}>
                  还没有部署任何技能 — 从下面分类里打开开关即可
                </div>
              )}
              {deployedSorted.map((skill) => renderSkillRow(skill))}
            </div>
          )}

          {renderDetailCard()}

          {/* Skill categories */}
          {!loading && categories.map((cat) => renderCatBlock(cat.category, cat.skills, 'cat'))}

          {/* Groups */}
          {!loading && groups.map((g) => renderCatBlock(g.name, g.skills, 'group'))}

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
                    style={{ fontSize: 14, color: C.info, cursor: 'pointer', padding: '4px 0', userSelect: 'none' }}
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
                          <span style={{ color: s.enabled !== false ? C.info : C.textDim, fontSize: 14 }}>
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
        </>}
      </div>
      </>}

      {tab === 'mcps' && <>
        {/* MCP add input */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexShrink: 0 }}>
          <input
            value={mcpInput}
            onChange={(e) => setMcpInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addMcpFromInput() }}
            placeholder={isGlobal ? 'owner/repo / GitHub URL' : 'central 名 / owner/repo / GitHub URL'}
            style={{
              flex: 1, padding: '5px 10px', borderRadius: 8,
              border: `1px solid ${C.border}1c`, background: `${C.well}cc`,
              color: C.text, fontSize: 14, outline: 'none', fontFamily: 'inherit',
            }}
          />
          <button
            onClick={() => void addMcpFromInput()}
            disabled={!!mcpOperating || !mcpInput.trim()}
            style={{
              padding: '5px 12px', borderRadius: 8, border: 'none',
              background: C.green, color: '#0c1214', fontSize: 14,
              cursor: 'pointer', fontFamily: 'inherit',
              opacity: !!mcpOperating || !mcpInput.trim() ? 0.5 : 1,
            }}
          >{isGlobal ? '安装' : '添加'}</button>
        </div>

        {/* Manual paste JSON (validated before submit) */}
        {!isGlobal && <div style={{ marginBottom: 10, flexShrink: 0 }}>
          <div
            onClick={() => setMcpManualOpen((v) => !v)}
            style={{ fontSize: 12, color: C.textDim, cursor: 'pointer', userSelect: 'none', padding: '2px 0' }}
          >
            {mcpManualOpen ? '▾' : '▸'} ✏️ 高级：手动粘贴 JSON 写入项目配置
          </div>
          {mcpManualOpen && (
            <div style={{ marginTop: 6 }}>
              <textarea
                value={mcpManualText}
                onChange={(e) => { setMcpManualText(e.target.value); setMcpManualError(false) }}
                placeholder={'粘贴一段 mcpServers JSON，例如:\n{\n  "my-server": {\n    "command": "npx",\n    "args": ["-y", "..."]\n  }\n}\n\n也接受外层包 "mcpServers": { ... }'}
                spellCheck={false}
                style={{
                  width: '100%', minHeight: 140, padding: 8, borderRadius: 6,
                  border: `1px solid ${mcpManualError ? C.red : `${C.border}2e`}`, background: `${C.well}cc`,
                  color: C.text, fontSize: 12, fontFamily: 'ui-monospace, Menlo, monospace',
                  outline: 'none', resize: 'vertical', boxSizing: 'border-box',
                }}
              />
              {mcpManualError && (
                <div style={{ fontSize: 11, color: C.red, marginTop: 4 }}>JSON 格式错误，未写入</div>
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
                <button
                  onClick={() => void submitMcpManual()}
                  disabled={!!mcpOperating || !mcpManualText.trim()}
                  style={{
                    padding: '4px 12px', borderRadius: 6, border: 'none',
                    background: C.accent, color: '#0c1214', fontSize: 13,
                    cursor: 'pointer', fontFamily: 'inherit',
                    opacity: !!mcpOperating || !mcpManualText.trim() ? 0.5 : 1,
                  }}
                >{mcpOperating === '__manual__' ? '写入中…' : '校验并写入'}</button>
                <span style={{ fontSize: 11, color: C.textDim }}>
                  目标:
                  同步写入 .mcp.json、.codex/config.toml 与 opencode.json
                </span>
              </div>
            </div>
          )}
        </div>}

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

          {!isGlobal && !mcpLoading && mcpDeployed.size > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 13, color: C.textDim, marginBottom: 6 }}>── 当前项目已部署 ({mcpDeployed.size}) ──</div>
              {[...mcpDeployed].map((name) => {
                const info = mcpCentralInfo(name)
                const expanded = mcpExpanded === name
                return (
                  <div key={`d:${name}`} style={{ border: `1px solid ${C.border}1c`, borderRadius: 8, marginBottom: 6, overflow: 'hidden' }}>
                    <div
                      onClick={() => setMcpExpanded(expanded ? null : name)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer' }}
                    >
                      <span style={{ color: C.green, fontSize: 14, flexShrink: 0 }}>●</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                        {info?.description && (
                          <div style={{ fontSize: 12, color: C.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{info.description}</div>
                        )}
                      </div>
                      {renderSwitch(true, mcpOperating === name, () => toggleMcp(name), '点击移除')}
                      <span style={{ fontSize: 9, color: C.textDim }}>{expanded ? '▾' : '▸'}</span>
                    </div>
                    {expanded && (
                      <div style={{ borderTop: `1px solid ${C.border}14`, padding: '8px 10px', background: `${C.well}66`, fontSize: 12, color: C.textDim, lineHeight: 1.7 }}>
                        {info?.description ?? 'central 未收录（手动添加的 server）'}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {!mcpLoading && mcpCentral.length > 0 && (
            <div>
              <div style={{ fontSize: 13, color: C.textDim, marginBottom: 6 }}>── {isGlobal ? '已安装到全局仓库' : '中央仓库'} ({mcpCentral.length}) ──</div>
              {mcpCentral.map((s) => (
                <div
                  key={`c:${s.name}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px' }}
                >
                  <span style={{ color: mcpDeployed.has(s.name) ? C.green : C.textDim, fontSize: 14, flexShrink: 0 }}>{mcpDeployed.has(s.name) ? '●' : '○'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                    {s.description && (
                      <div style={{ fontSize: 12, color: C.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.description}</div>
                    )}
                  </div>
                  {isGlobal
                    ? <button
                        onClick={() => confirmUninstallGlobalMcp(s.name)}
                        disabled={mcpOperating === s.name}
                        style={{ border: 'none', background: 'none', color: C.red, fontSize: 11, cursor: 'pointer', opacity: mcpOperating === s.name ? 0.5 : 1 }}
                      >卸载</button>
                    : renderSwitch(mcpDeployed.has(s.name), mcpOperating === s.name, () => toggleMcp(s.name), mcpDeployed.has(s.name) ? '点击移除' : '点击部署')}
                </div>
              ))}
            </div>
          )}

          {!mcpLoading && mcpAvailable && mcpCentral.length === 0 && mcpDeployed.size === 0 && (
            <div style={{ fontSize: 14, color: C.textDim, textAlign: 'center', padding: 20 }}>
              还没有任何 MCP server<br />
              <span style={{ fontSize: 13 }}>用上面的输入框{isGlobal ? '安装' : '添加'} owner/repo</span>
            </div>
          )}
        </div>
      </>}

      {/* Confirm modal for destructive batch actions */}
      {confirm && (
        <div
          onClick={() => setConfirm(null)}
          style={{
            position: 'absolute', inset: 0, zIndex: 80,
            background: 'rgba(6,8,14,0.55)', backdropFilter: 'blur(3px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 340, padding: 16, borderRadius: 14,
              background: '#1e2230', border: `1px solid ${C.border}3d`,
              boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
            }}
          >
            <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 8 }}>{confirm.title}</div>
            <div style={{ fontSize: 12, color: C.textDim, lineHeight: 1.6, marginBottom: 6 }}>{confirm.body}</div>
            {confirm.names && <div style={{ fontSize: 11, color: C.textDim, marginBottom: 12, lineHeight: 1.6, opacity: 0.8 }}>{confirm.names}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setConfirm(null)}
                style={{
                  padding: '6px 16px', borderRadius: 9, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                  border: `1px solid ${C.border}1c`, background: 'rgba(255,255,255,0.04)', color: C.textDim,
                }}
              >取消</button>
              <button
                onClick={() => { const run = confirm.onConfirm; setConfirm(null); void run() }}
                style={{
                  padding: '6px 16px', borderRadius: 9, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                  border: 'none', background: C.red, color: '#fff',
                }}
              >{confirm.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
