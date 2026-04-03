import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type { SessionInfo } from '@shared/types/session'
import { useConfigStore } from '../store/config-store'
import { COLOR_THEMES } from '@shared/types/config'
import { useAutoClose } from './useAutoClose'

interface Props {
  sessions: SessionInfo[]
  onAttach: (id: string) => void
  onKill: (id: string) => void
  onRename: (id: string, title: string) => void
  onCreateWorktreePane: (sessionId: string, branch: string) => void
  onRemoveWorktreePane: (paneId: string, keepWorktree: boolean) => void
  onOpenSkills: (sessionId: string) => void
}

// Status dot: cyan-green=running, amber=detached
const statusDotColor: Record<string, string> = { running: '#06d6a0', detached: '#ffb148', dead: '#555' }

function getBubbleColor(id: string): string | null {
  try { return localStorage.getItem(`kitty-bubble-color-${id}`) } catch { return null }
}
function setBubbleColorLS(id: string, color: string | null) {
  if (color) localStorage.setItem(`kitty-bubble-color-${id}`, color)
  else localStorage.removeItem(`kitty-bubble-color-${id}`)
}

function getBubblePriority(id: string): number {
  try { return parseInt(localStorage.getItem(`kitty-bubble-priority-${id}`) || '0', 10) } catch { return 0 }
}
function setBubblePriorityLS(id: string, priority: number) {
  if (priority) localStorage.setItem(`kitty-bubble-priority-${id}`, String(priority))
  else localStorage.removeItem(`kitty-bubble-priority-${id}`)
}

function getGroupPriority(groupId: string): number {
  try { return parseInt(localStorage.getItem(`kitty-group-priority-${groupId}`) || '0', 10) } catch { return 0 }
}
function setGroupPriorityLS(groupId: string, priority: number) {
  if (priority) localStorage.setItem(`kitty-group-priority-${groupId}`, String(priority))
  else localStorage.removeItem(`kitty-group-priority-${groupId}`)
}

const BUBBLE_PRESETS = ['#645efb', '#10b981', '#e11d48', '#d97706', '#06b6d4', '#8b5cf6']

// Branch type → color for worktree sessions
function branchColor(cwd: string): { label: string; color: string } | null {
  // Detect worktree path: .../.worktrees/<branch-name>/
  const wtMatch = cwd.match(/\.worktrees\/([^/]+)\/?$/)
  if (!wtMatch) return null
  const branch = wtMatch[1]
  if (/^release/i.test(branch)) return { label: branch, color: '#e11d48' }   // red
  if (/^main$|^master$/i.test(branch)) return { label: branch, color: '#d97706' } // yellow/amber
  if (/^feature/i.test(branch)) return { label: branch, color: '#10b981' }   // green
  return { label: branch, color: '#8b5cf6' } // purple for other branches
}

// Tier config: [baseFontSize, verticalPad, horizontalPad, opacity]
const TIERS: Array<[number, number, number, number]> = [
  [15, 7, 18, 1.0],   // hero
  [13, 5, 14, 0.9],   // medium
  [13, 5, 14, 0.9],
  [11, 4, 11, 0.7],   // small
  [11, 4, 11, 0.7],
  [10, 3, 10, 0.55],  // tiny
  [10, 3, 10, 0.55],
  [10, 3, 10, 0.45],
]

// Slight nudges for organic feel
function nudge(i: number): React.CSSProperties {
  const rot = ((i * 13 + 5) % 7) - 3
  const mx = ((i * 7 + 2) % 5) - 2
  const my = ((i * 11 + 3) % 5) - 2
  return { transform: `rotate(${rot}deg)`, marginLeft: mx, marginTop: my }
}

// CSS keyframes for subtle float animation (injected once)
let animInjected = false
function injectAnimations() {
  if (animInjected) return
  animInjected = true
  const style = document.createElement('style')
  style.textContent = `
    @keyframes kitty-float {
      0%, 100% { transform: translateY(0px); }
      50% { transform: translateY(-2px); }
    }
    @keyframes kitty-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
  `
  document.head.appendChild(style)
}

export default function TagCloud({ sessions, onAttach, onKill, onRename, onCreateWorktreePane, onRemoveWorktreePane, onOpenSkills }: Props) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null)
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null)
  const [showAllUngrouped, setShowAllUngrouped] = useState(false)
  const [wtBranchInput, setWtBranchInput] = useState('')
  const [wtInputSessionId, setWtInputSessionId] = useState<string | null>(null)
  const { bubble } = useConfigStore()

  useEffect(() => { injectAnimations() }, [])

  // Sort: priority (desc) → running first → newest first
  const alive = useMemo(() => {
    return sessions
      .filter((s) => s.status !== 'dead')
      .sort((a, b) => {
        const pa = getBubblePriority(a.id), pb = getBubblePriority(b.id)
        if (pa !== pb) return pb - pa
        if (a.status !== b.status) return a.status === 'running' ? -1 : 1
        return 0
      })
      .slice(0, 8)
  }, [sessions])

  const [bubbleColors, setBubbleColors] = useState<Record<string, string>>(() => {
    const c: Record<string, string> = {}
    alive.forEach((s) => { const v = getBubbleColor(s.id); if (v) c[s.id] = v })
    return c
  })

  const [priorities, setPriorities] = useState<Record<string, number>>(() => {
    const p: Record<string, number> = {}
    alive.forEach((s) => { const v = getBubblePriority(s.id); if (v) p[s.id] = v })
    return p
  })

  const handleSetColor = useCallback((id: string, color: string | null) => {
    setBubbleColorLS(id, color)
    setBubbleColors((p) => { const n = { ...p }; if (color) n[id] = color; else delete n[id]; return n })
    setCtxMenu(null)
  }, [])

  const handleSetPriority = useCallback((id: string, priority: number) => {
    // Exclusive: clear all others first
    if (priority > 0) {
      for (const s of alive) {
        if (s.id !== id) setBubblePriorityLS(s.id, 0)
      }
    }
    setBubblePriorityLS(id, priority)
    setPriorities(priority > 0 ? { [id]: priority } : {})
    setCtxMenu(null)
  }, [alive])

  const [groupPriorities, setGroupPriorities] = useState<Record<string, number>>(() => {
    const p: Record<string, number> = {}
    const groupIds = new Set(sessions.filter(s => s.groupId).map(s => s.groupId!))
    for (const gid of groupIds) { const v = getGroupPriority(gid); if (v) p[gid] = v }
    return p
  })

  const handleSetGroupPriority = useCallback((groupId: string, priority: number) => {
    // Exclusive: clear other group priorities
    if (priority > 0) {
      for (const s of alive) {
        if (s.groupId && s.groupId !== groupId) setGroupPriorityLS(s.groupId, 0)
      }
    }
    setGroupPriorityLS(groupId, priority)
    setGroupPriorities(priority > 0 ? { [groupId]: priority } : {})
  }, [alive])

  const theme = bubble.colorTheme === 'custom' && bubble.customColor
    ? { primary: bubble.customColor, dim: bubble.customColor, glass: '#23233f' }
    : COLOR_THEMES[bubble.colorTheme] || COLOR_THEMES.indigo

  const scale = bubble.sizeScale

  const startRename = (s: SessionInfo) => { setEditingId(s.id); setEditTitle(s.title); setCtxMenu(null) }
  const finishRename = () => { if (editingId && editTitle.trim()) onRename(editingId, editTitle.trim()); setEditingId(null) }

  const statusSummary = useMemo(() => {
    const running = sessions.filter(s => s.status === 'running').length
    const detached = sessions.filter(s => s.status === 'detached').length
    const dead = sessions.filter(s => s.status === 'dead').length
    const parts: string[] = []
    if (running) parts.push(`${running} 运行中`)
    if (detached) parts.push(`${detached} 已分离`)
    if (dead) parts.push(`${dead} 已结束`)
    return parts.length ? parts.join(' · ') : null
  }, [sessions])

  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([])
  const [groupMenuId, setGroupMenuId] = useState<string | null>(null)
  const [newGroupName, setNewGroupName] = useState('')
  const showCollabError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : '未知错误'
    console.error('[session] action failed:', error)
    window.alert(`操作失败：${message}`)
  }, [])

  const loadGroups = useCallback(async () => {
    const g = await window.api.invoke('group:list') as Array<{ id: string; name: string }>
    setGroups(g || [])
  }, [])

  // Load groups
  useEffect(() => {
    void loadGroups()
  }, [sessions, loadGroups])

  const handleSetGroup = useCallback(async (sessionId: string, groupId: string | null) => {
    await window.api.invoke('session:set-group', sessionId, groupId)
    setCtxMenu(null)
    setGroupMenuId(null)
  }, [])

  const handleCreateGroup = useCallback(async (sessionId: string) => {
    const name = newGroupName.trim()
    if (!name) return
    const g: any = await window.api.invoke('group:create', name)
    setGroups((prev) => [...prev, g])
    await window.api.invoke('session:set-group', sessionId, g.id)
    setNewGroupName('')
    setCtxMenu(null)
    setGroupMenuId(null)
  }, [newGroupName])

  // Group sessions: grouped ones by group, ungrouped separate
  const grouped = useMemo(() => {
    const map = new Map<string, { name: string; sessions: SessionInfo[] }>()
    const ungrouped: SessionInfo[] = []
    for (const s of alive) {
      if (s.groupId && s.groupName) {
        if (!map.has(s.groupId)) map.set(s.groupId, { name: s.groupName, sessions: [] })
        map.get(s.groupId)!.sessions.push(s)
      } else {
        ungrouped.push(s)
      }
    }
    const sortedGroups = [...map.entries()].sort((a, b) => {
      return getGroupPriority(b[0]) - getGroupPriority(a[0])
    })
    return { groups: sortedGroups, ungrouped }
  }, [alive])

  if (alive.length === 0) return null

  // Build rows: grouped sections on top, ungrouped below (closest to cat)
  // Ungrouped uses the old hero/medium/small layout
  const hero = grouped.ungrouped[0]
  const medium = grouped.ungrouped.slice(1, 3)
  const small = grouped.ungrouped.slice(3)

  const renderTag = (session: SessionInfo, tierIdx: number) => {
    const [baseFontSize, vPad, hPad, baseOpacity] = TIERS[Math.min(tierIdx, TIERS.length - 1)]
    const fontSize = Math.round(baseFontSize * scale)
    const isHero = tierIdx === 0
    const isHovered = hoveredId === session.id
    const isEditing = editingId === session.id
    const isRunning = session.status === 'running'
    const dotColor = statusDotColor[session.status] || '#555'
    const accent = bubbleColors[session.id] || (isRunning ? theme.primary : theme.dim)
    const opacity = isRunning ? Math.max(baseOpacity, 0.85) : baseOpacity
    const n = nudge(tierIdx)
    const branch = branchColor(session.cwd || '')
    const hasPriority = (priorities[session.id] || 0) > 0

    // Float animation: different duration per bubble for organic feel
    const floatDuration = 3 + (tierIdx * 0.5)
    const floatDelay = tierIdx * 0.3

    return (
      <div
        key={session.id}
        onMouseEnter={() => setHoveredId(session.id)}
        onMouseLeave={() => setHoveredId(null)}
        onClick={(e) => { e.stopPropagation(); if (!isEditing) onAttach(session.id) }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ id: session.id, x: e.clientX, y: e.clientY }) }}
        style={{
          ...n,
          display: 'inline-flex', alignItems: 'center',
          gap: Math.round(5 * scale),
          padding: `${Math.round(vPad * scale)}px ${Math.round(hPad * scale)}px`,
          borderRadius: 9999, fontSize,
          fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
          color: '#e5e3ff', opacity: isHovered ? 1 : opacity,
          background: isHovered
            ? `${accent}cc`
            : isHero
              ? `${accent}bb`
              : isRunning
                ? `${accent}aa`
                : `${theme.glass}ee`,
          backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
          boxShadow: isHero
            ? `0 0 ${18 * scale}px ${accent}40, 0 4px 14px rgba(0,0,0,0.3)`
            : isRunning
              ? `0 0 10px ${accent}25, 0 3px 10px rgba(0,0,0,0.2)`
              : `0 2px 8px rgba(0,0,0,0.25)`,
          border: (isHero || isRunning) ? `1px solid ${accent}${isHero ? '55' : '30'}` : 'none',
          cursor: 'pointer',
          transition: 'all 0.25s ease',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          maxWidth: Math.round((isHero ? 240 : 170) * scale),
          animation: `kitty-float ${floatDuration}s ease-in-out ${floatDelay}s infinite`,
        }}
        title={`${session.tool}: ${session.title}\n📂 ${session.cwd || '未设置'}${hasPriority ? '\n📌 已置顶' : ''}\n点击 attach · 右键菜单`}
      >
        {/* Status dot */}
        <span style={{
          width: Math.round((isHero ? 8 : 6) * scale),
          height: Math.round((isHero ? 8 : 6) * scale),
          borderRadius: '50%', background: dotColor, flexShrink: 0,
          boxShadow: `0 0 ${isHero ? 10 : 6}px ${dotColor}`,
          animation: isRunning ? 'kitty-pulse 2s ease-in-out infinite' : undefined,
        }} />
        {/* Title + optional branch below */}
        <div style={{ overflow: 'hidden', minWidth: 0 }}>
          {isEditing ? (
            <input autoFocus value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') finishRename(); if (e.key === 'Escape') setEditingId(null) }}
              onBlur={finishRename} onClick={(e) => e.stopPropagation()}
              style={{ background: 'transparent', border: 'none', color: '#e5e3ff', fontSize, outline: 'none', width: 80, padding: 0, fontFamily: 'inherit' }}
            />
          ) : (
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isHero ? 600 : 500 }}>
              {session.title}
            </div>
          )}
          {branch && (
            <div style={{
              fontSize: Math.max(fontSize - 4, 7),
              color: branch.color,
              fontWeight: 500,
              lineHeight: 1.2,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {branch.label}
            </div>
          )}
        </div>
        {session.isGitRepo && !(session.cwd || '').includes('.worktrees/') && (
          <span
            onClick={(e) => { e.stopPropagation(); setExpandedSessionId(expandedSessionId === session.id ? null : session.id) }}
            style={{ fontSize: Math.max(fontSize - 4, 7), color: '#10b981', cursor: 'pointer', flexShrink: 0 }}
            title="Worktree panes"
          >
            {session.worktreePanes && session.worktreePanes.length > 0 ? `🌿${session.worktreePanes.length}` : '🌿'}
          </span>
        )}
        {hasPriority && (
          <span style={{ fontSize: Math.max(fontSize - 4, 7), flexShrink: 0, opacity: 0.7 }}>📌</span>
        )}
      </div>
    )
  }

  const mergeStateColor: Record<string, string> = {
    clean: '#10b981', behind: '#d97706', conflict: '#e11d48', merged: '#6b7280', unknown: '#6b7280'
  }

  const renderWorktreePanes = (session: SessionInfo) => {
    if (!session.isGitRepo || (session.cwd || '').includes('.worktrees/') || expandedSessionId !== session.id) return null
    return (
      <div style={{
        position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
        zIndex: 50,
        display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2,
        padding: `3px 6px`, borderRadius: 6,
        background: '#17172fee', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid #46465c44',
        fontSize: Math.round(9 * scale),
        fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
        minWidth: Math.round(160 * scale), maxWidth: Math.round(220 * scale),
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      >
        {(session.worktreePanes || []).map((wp) => (
          <div key={wp.id} style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#e5e3ff' }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
              background: mergeStateColor[wp.mergeState] || '#6b7280',
            }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {wp.branch}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onRemoveWorktreePane(wp.id, true) }}
              title="关闭 pane（保留 worktree）"
              style={{
                background: 'none', border: 'none', color: '#aaa8c3', cursor: 'pointer',
                fontSize: Math.round(9 * scale), padding: '0 2px', flexShrink: 0,
              }}
            >✕</button>
          </div>
        ))}
        {wtInputSessionId === session.id ? (
          <div style={{ display: 'flex', gap: 3 }}>
            <input
              autoFocus
              value={wtBranchInput}
              onChange={(e) => setWtBranchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && wtBranchInput.trim()) {
                  onCreateWorktreePane(session.id, wtBranchInput.trim())
                  setWtBranchInput(''); setWtInputSessionId(null)
                }
                if (e.key === 'Escape') { setWtBranchInput(''); setWtInputSessionId(null) }
              }}
              placeholder="feature/xxx"
              onClick={(e) => e.stopPropagation()}
              style={{
                flex: 1, padding: '3px 6px', borderRadius: 6, fontSize: Math.round(9 * scale),
                background: '#17172f', border: '1px solid #10b98144',
                color: '#e5e3ff', outline: 'none', fontFamily: 'inherit', minWidth: 0,
              }}
            />
            <button
              onClick={(e) => {
                e.stopPropagation()
                if (wtBranchInput.trim()) {
                  onCreateWorktreePane(session.id, wtBranchInput.trim())
                  setWtBranchInput(''); setWtInputSessionId(null)
                }
              }}
              style={{
                padding: '3px 8px', borderRadius: 6, fontSize: Math.round(9 * scale),
                background: '#10b981', border: 'none', color: '#0c0c1f',
                cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600,
              }}
            >GO</button>
          </div>
        ) : (
          <button
            onClick={(e) => { e.stopPropagation(); setWtInputSessionId(session.id) }}
            style={{
              background: 'none', border: '1px dashed #46465c44', borderRadius: 6,
              color: '#10b981', fontSize: Math.round(9 * scale), cursor: 'pointer',
              padding: '2px 6px', fontFamily: 'inherit',
            }}
          >+ worktree pane</button>
        )}
      </div>
    )
  }

  // Map sessions to their tier index
  const tierMap = new Map<string, number>()
  if (hero) tierMap.set(hero.id, 0)
  medium.forEach((s, i) => tierMap.set(s.id, 1 + i))
  small.forEach((s, i) => tierMap.set(s.id, 3 + i))
  // Grouped sessions get tier 3 (small)
  for (const [, g] of grouped.groups) {
    g.sessions.forEach((s, i) => tierMap.set(s.id, 3 + i))
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: Math.round(8 * scale), padding: '4px 8px' }}
      onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Status summary */}
      {statusSummary && (
        <div style={{
          fontSize: Math.round(9 * scale), color: '#aaa8c3', opacity: 0.7,
          fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
          letterSpacing: 0.3, textAlign: 'center',
        }}>
          {statusSummary}
        </div>
      )}

      {/* Grouped sections — collapsed compact rows, click to expand */}
      {grouped.groups.map(([groupId, g]) => {
        const isExpanded = expandedGroupId === groupId
        const runningCount = g.sessions.filter((s) => s.status === 'running').length
        const detachedCount = g.sessions.length - runningCount
        return (
          <div key={groupId} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'stretch',
            borderRadius: Math.round(10 * scale),
            background: '#23233f88',
            border: '1px solid #46465c33',
            maxWidth: Math.round(400 * scale),
            width: '100%',
          }}>
            {/* Compact group header row */}
            <div
              onClick={() => setExpandedGroupId(isExpanded ? null : groupId)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: `${Math.round(5 * scale)}px ${Math.round(10 * scale)}px`,
                cursor: 'pointer', userSelect: 'none',
                fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
              }}
            >
              <span style={{ fontSize: 9, color: '#aaa8c3' }}>{isExpanded ? '▾' : '▸'}</span>
              <span style={{ fontSize: Math.round(11 * scale), color: '#a7a5ff', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {g.name}
              </span>
              {/* Status dots */}
              {runningCount > 0 && <span style={{ fontSize: 9, color: '#10b981' }}>●{runningCount > 1 ? runningCount : ''}</span>}
              {detachedCount > 0 && <span style={{ fontSize: 9, color: '#d97706' }}>●{detachedCount > 1 ? detachedCount : ''}</span>}
              <span style={{ fontSize: 9, color: '#aaa8c3' }}>({g.sessions.length})</span>
              <button
                onClick={(e) => { e.stopPropagation(); handleSetGroupPriority(groupId, (groupPriorities[groupId] || 0) > 0 ? 0 : 1) }}
                style={{
                  fontSize: 9, background: 'none', border: 'none', cursor: 'pointer',
                  opacity: (groupPriorities[groupId] || 0) > 0 ? 1 : 0.4,
                  padding: 0, flexShrink: 0,
                }}
                title={(groupPriorities[groupId] || 0) > 0 ? '取消置顶' : '置顶显示'}
              >📌</button>
            </div>
            {/* Expanded: show session bubbles vertically */}
            {isExpanded && (
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: Math.round(4 * scale),
                padding: `0 ${Math.round(8 * scale)}px ${Math.round(6 * scale)}px`,
              }}>
                {g.sessions.map((s) => (
                  <div key={s.id} style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    {renderTag(s, tierMap.get(s.id) || 3)}
                    {renderWorktreePanes(s)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {/* Ungrouped sessions — show up to 3, fold the rest */}
      {small.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: Math.round(6 * scale), justifyContent: 'center' }}>
          {(showAllUngrouped ? small : small.slice(0, 3)).map((s) => (
            <div key={s.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              {renderTag(s, tierMap.get(s.id) || 3)}
              {renderWorktreePanes(s)}
            </div>
          ))}
          {small.length > 3 && !showAllUngrouped && (
            <button
              onClick={() => setShowAllUngrouped(true)}
              style={{
                fontSize: Math.round(9 * scale), color: '#aaa8c3', background: '#23233f66',
                border: '1px solid #46465c33', borderRadius: 9999,
                padding: `${Math.round(3 * scale)}px ${Math.round(10 * scale)}px`,
                cursor: 'pointer', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
              }}
            >+{small.length - 3} more</button>
          )}
        </div>
      )}
      {medium.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: Math.round(8 * scale), justifyContent: 'center' }}>
          {medium.map((s) => (
            <div key={s.id} style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              {renderTag(s, tierMap.get(s.id) || 1)}
              {renderWorktreePanes(s)}
            </div>
          ))}
        </div>
      )}
      {hero && (
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {renderTag(hero, 0)}
          {renderWorktreePanes(hero)}
        </div>
      )}

      {/* Context menu */}
      {ctxMenu && (
        <TagCtxMenu x={ctxMenu.x} y={ctxMenu.y} glass={theme.glass} dim={theme.dim}
          onClose={() => setCtxMenu(null)}>
            {/* Color swatches */}
            <div style={{ padding: '6px 10px 4px', display: 'flex', gap: 5, alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: '#aaa8c3' }}>🎨</span>
              {BUBBLE_PRESETS.map((c) => (
                <button key={c} onClick={() => handleSetColor(ctxMenu.id, c)}
                  style={{
                    width: 16, height: 16, borderRadius: '50%', background: c, border: 'none', cursor: 'pointer',
                    outline: bubbleColors[ctxMenu.id] === c ? '2px solid #fff' : 'none', outlineOffset: 1,
                  }} />
              ))}
              <button onClick={() => handleSetColor(ctxMenu.id, null)}
                style={{ width: 16, height: 16, borderRadius: '50%', background: '#333', border: '1px dashed #666', cursor: 'pointer', fontSize: 8, color: '#999' }}
                title="恢复默认">✕</button>
            </div>
            <div style={{ margin: '3px 8px', borderTop: '1px solid #46465c30' }} />
            {/* Priority toggle */}
            <button onClick={() => handleSetPriority(ctxMenu.id, (priorities[ctxMenu.id] || 0) > 0 ? 0 : 1)}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', fontSize: 12, color: '#e5e3ff', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
              onMouseEnter={(e) => { (e.target as HTMLElement).style.background = `${theme.dim}33` }}
              onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'none' }}
            >{(priorities[ctxMenu.id] || 0) > 0 ? '📌 取消置顶' : '📌 置顶显示'}</button>
            {[
              { label: '✏️ 重命名', action: () => { const s = alive.find(x => x.id === ctxMenu.id); if (s) startRename(s) } },
              { label: '⚡ 切换为 Claude', action: async () => {
                try { await window.api.invoke('session:set-tool', ctxMenu.id, 'claude'); setCtxMenu(null) }
                catch (error) { showCollabError(error) }
              }},
              { label: '🔧 切换为 Codex', action: async () => {
                try { await window.api.invoke('session:set-tool', ctxMenu.id, 'codex'); setCtxMenu(null) }
                catch (error) { showCollabError(error) }
              }},
              { label: '♻️ 重启会话', action: async () => {
                try { await window.api.invoke('session:restart-agent', ctxMenu.id); setCtxMenu(null) }
                catch (error) { showCollabError(error) }
              }},
              { label: '📦 技能', action: () => { onOpenSkills(ctxMenu.id); setCtxMenu(null) } },
              { label: '👥 移到 Group...', action: () => setGroupMenuId(groupMenuId ? null : ctxMenu.id) },
              null,
              { label: '✕ 退出', action: () => { onKill(ctxMenu.id); setCtxMenu(null) }, color: '#ff6e84' },
            ].map((item, i) => {
              if (!item) return <div key={i} style={{ margin: '3px 8px', borderTop: '1px solid #46465c30' }} />
              return (
                <button key={i} onClick={item.action}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', fontSize: 12, color: item.color || '#e5e3ff', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                  onMouseEnter={(e) => { (e.target as HTMLElement).style.background = `${theme.dim}33` }}
                  onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'none' }}
                >{item.label}</button>
              )
            })}
            {/* Group submenu */}
            {groupMenuId && (
              <>
                <div style={{ margin: '3px 8px', borderTop: '1px solid #46465c30' }} />
                {/* Ungroup option */}
                <button onClick={() => handleSetGroup(groupMenuId, null)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 12px', fontSize: 11, color: '#aaa8c3', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                  onMouseEnter={(e) => { (e.target as HTMLElement).style.background = `${theme.dim}33` }}
                  onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'none' }}
                >— 不分组</button>
                {groups.map((g) => {
                  const current = alive.find(s => s.id === groupMenuId)
                  const isCurrent = current?.groupId === g.id
                  return (
                    <button key={g.id} onClick={() => handleSetGroup(groupMenuId, g.id)}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 12px', fontSize: 11, color: isCurrent ? '#a7a5ff' : '#e5e3ff', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                      onMouseEnter={(e) => { (e.target as HTMLElement).style.background = `${theme.dim}33` }}
                      onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'none' }}
                    >{isCurrent ? '✓ ' : '  '}{g.name}</button>
                  )
                })}
                {/* New group inline */}
                <div style={{ display: 'flex', gap: 4, padding: '4px 8px' }}>
                  <input value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleCreateGroup(groupMenuId) }}
                    placeholder="新 Group 名..."
                    style={{ flex: 1, padding: '3px 6px', borderRadius: 6, fontSize: 11, background: '#17172f', border: '1px solid #46465c44', color: '#e5e3ff', outline: 'none', fontFamily: 'inherit' }}
                  />
                  <button onClick={() => handleCreateGroup(groupMenuId)}
                    style={{ padding: '3px 8px', borderRadius: 6, fontSize: 11, background: '#645efb', border: 'none', color: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}
                  >+</button>
                </div>
              </>
            )}
        </TagCtxMenu>
      )}
    </div>
  )
}

function TagCtxMenu({ x, y, glass, onClose, children }: {
  x: number; y: number; glass: string; dim?: string; onClose: () => void; children: React.ReactNode
}) {
  const autoCloseRef = useAutoClose(true, onClose)
  const [pos, setPos] = useState({ left: x, top: y })

  const setRef = useCallback((node: HTMLDivElement | null) => {
    (autoCloseRef as any).current = node
    if (!node) return
    // Adjust position to stay within viewport
    const rect = node.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = x
    let top = y
    if (rect.right > vw) left = Math.max(4, vw - rect.width - 4)
    if (rect.bottom > vh) top = Math.max(4, vh - rect.height - 4)
    if (left !== x || top !== y) setPos({ left, top })
  }, [x, y, autoCloseRef])

  useEffect(() => { setPos({ left: x, top: y }) }, [x, y])

  return (
    <div ref={setRef} style={{
      position: 'fixed', left: pos.left, top: pos.top, zIndex: 200,
      background: `${glass}f0`, backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
      borderRadius: 12, padding: '4px 0', minWidth: 150, maxHeight: '85vh', overflowY: 'auto',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif"
    }}>
      {children}
    </div>
  )
}
