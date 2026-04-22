import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type { SessionInfo } from '@shared/types/session'
import { useConfigStore } from '../store/config-store'
import { useSessionStore } from '../store/session-store'
import { COLOR_THEMES } from '@shared/types/config'
import { useAutoClose } from './useAutoClose'
import AgentMetadataPopup from './AgentMetadataPopup'

interface Props {
  sessions: SessionInfo[]
  onAttach: (id: string) => void
  onKill: (id: string) => void
  onRename: (id: string, title: string) => void
  onRestart: (id: string) => void
  onEditEnv: (id: string) => void
  onOpenSkills: (sessionId: string) => void
}


function getBubbleColor(id: string): string | null {
  try { return localStorage.getItem(`kitty-bubble-color-${id}`) } catch { return null }
}
function setBubbleColorLS(id: string, color: string | null) {
  if (color) localStorage.setItem(`kitty-bubble-color-${id}`, color)
  else localStorage.removeItem(`kitty-bubble-color-${id}`)
}

const BUBBLE_PRESETS = ['#645efb', '#10b981', '#e11d48', '#d97706', '#06b6d4', '#8b5cf6']

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
    @keyframes quickFade {
      from { opacity: 0; transform: translate(-50%, 2px); }
      to { opacity: 1; transform: translate(-50%, -4px); }
    }
  `
  document.head.appendChild(style)
}

export default function TagCloud({ sessions, onAttach, onKill, onRename, onRestart, onEditEnv, onOpenSkills }: Props) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const enterHover = useCallback((id: string) => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null }
    setHoveredId(id)
  }, [])
  const leaveHover = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => { setHoveredId(null); hoverTimer.current = null }, 400)
  }, [])
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [metadataPopup, setMetadataPopup] = useState<SessionInfo | null>(null)
  const setAgentMetadata = useSessionStore((s) => s.setAgentMetadata)
  const loadSessions = useSessionStore((s) => s.loadSessions)
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null)
  const [showAllUngrouped, setShowAllUngrouped] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null)
  const { bubble } = useConfigStore()

  useEffect(() => { injectAnimations() }, [])

  const hiddenIds = useMemo(() => {
    const h = new Set<string>()
    sessions.forEach((s) => { if (s.hidden) h.add(s.id) })
    return h
  }, [sessions])

  const [hiddenLoading, setHiddenLoading] = useState<string | null>(null)
  const handleToggleHidden = useCallback(async (id: string) => {
    const isHidden = hiddenIds.has(id)
    setHiddenLoading(id)
    setCtxMenu(null)
    try {
      await window.api.invoke('session:set-hidden', id, !isHidden)
      await loadSessions()
    } finally {
      setHiddenLoading(null)
    }
  }, [hiddenIds, loadSessions])

  // Sort: running first → newest first
  const alive = useMemo(() => {
    return sessions
      .filter((s) => s.status !== 'dead' && !hiddenIds.has(s.id))
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'running' ? -1 : 1
        return 0
      })
  }, [sessions, hiddenIds])

  const [bubbleColors, setBubbleColors] = useState<Record<string, string>>({})

  // Sync bubble colors from localStorage whenever sessions change
  useEffect(() => {
    const c: Record<string, string> = {}
    sessions.forEach((s) => { const v = getBubbleColor(s.id); if (v) c[s.id] = v })
    setBubbleColors(c)
  }, [sessions])

  const handleSetColor = useCallback((id: string, color: string | null) => {
    setBubbleColorLS(id, color)
    setBubbleColors((p) => { const n = { ...p }; if (color) n[id] = color; else delete n[id]; return n })
    setCtxMenu(null)
  }, [])

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
  const [groupCtxMenu, setGroupCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null)
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
  // All groups are shown (even empty ones) for drag-drop targets
  const grouped = useMemo(() => {
    const map = new Map<string, { name: string; color?: string; sessions: SessionInfo[] }>()
    // Initialize all groups (even empty)
    for (const g of groups) {
      map.set(g.id, { name: g.name, color: undefined, sessions: [] })
    }
    const ungrouped: SessionInfo[] = []
    for (const s of alive) {
      if (s.groupId && map.has(s.groupId)) {
        const entry = map.get(s.groupId)!
        if (s.groupColor) entry.color = s.groupColor
        entry.sessions.push(s)
      } else if (s.groupId && s.groupName) {
        // Group not in list yet (shouldn't happen, but handle)
        map.set(s.groupId, { name: s.groupName, color: s.groupColor, sessions: [s] })
      } else {
        ungrouped.push(s)
      }
    }
    const sortedGroups = [...map.entries()]
    return { groups: sortedGroups, ungrouped }
  }, [alive, groups])

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
    const accent = bubbleColors[session.id] || (isRunning ? theme.primary : theme.dim)
    const opacity = isRunning ? Math.max(baseOpacity, 0.85) : baseOpacity
    const n = nudge(tierIdx)
    const hasMetadata = !!(session.roles && session.roles.length > 0) || !!(session.expertise && session.expertise.length > 0)
    const metadataTooltip = hasMetadata
      ? `\n🏷 ${session.roles || ''}${session.expertise ? '\n' + session.expertise.slice(0, 60) + (session.expertise.length > 60 ? '...' : '') : ''}`
      : ''

    // Float animation: different duration per bubble for organic feel
    const floatDuration = 3 + (tierIdx * 0.5)
    const floatDelay = tierIdx * 0.3

    return (
      <div
        key={session.id}
        draggable
        onDragStart={(e) => { e.dataTransfer.setData('text/plain', session.id); e.dataTransfer.effectAllowed = 'move'; setDraggingSessionId(session.id) }}
        onDragEnd={() => setDraggingSessionId(null)}
        onMouseEnter={() => enterHover(session.id)}
        onMouseLeave={leaveHover}
        onClick={(e) => { e.stopPropagation(); if (!isEditing) onAttach(session.id) }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ id: session.id, x: e.clientX, y: e.clientY }) }}
        style={{
          ...n,
          position: 'relative',
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
              : `${accent}aa`,
          backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
          boxShadow: isHero
            ? `0 0 ${18 * scale}px ${accent}40, 0 4px 14px rgba(0,0,0,0.3)`
            : `0 0 10px ${accent}25, 0 3px 10px rgba(0,0,0,0.2)`,
          border: `1px solid ${accent}${isHero ? '55' : '30'}`,
          cursor: 'pointer',
          transition: 'all 0.25s ease',
          whiteSpace: 'nowrap',
          maxWidth: Math.round((isHero ? 240 : 170) * scale),
          animation: `kitty-float ${floatDuration}s ease-in-out ${floatDelay}s infinite`,
        }}
        title={`${session.tool}: ${session.title}\n📂 ${session.cwd || '未设置'}${metadataTooltip}\n点击 attach · 右键菜单`}
      >
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
        </div>
        {hasMetadata && (
          <span style={{ fontSize: Math.max(fontSize - 4, 7), flexShrink: 0, opacity: 0.7 }}>🏷</span>
        )}
        {isHovered && !isEditing && (
          <div
            onMouseEnter={() => enterHover(session.id)}
            onMouseLeave={leaveHover}
            style={{
              position: 'absolute', left: '50%', bottom: '100%',
              transform: 'translate(-50%, 0)',
              paddingBottom: 6, // hit-area bridge to bubble
              display: 'inline-flex', gap: 3,
              zIndex: 20,
              animation: 'quickFade 0.15s ease',
              whiteSpace: 'nowrap',
            }}>
            <div style={{
              display: 'inline-flex', gap: 3,
              padding: '2px 3px', borderRadius: 10,
              background: '#0d0d1fee', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
              boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
              border: `1px solid ${accent}33`,
            }}>
              <button
                onClick={(e) => { e.stopPropagation(); onRestart(session.id) }}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  padding: '3px 8px', height: 20,
                  background: 'transparent',
                  border: 'none', borderRadius: 7, cursor: 'pointer',
                  fontSize: 10, color: '#fff', lineHeight: 1,
                  fontFamily: 'inherit',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.18)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >重启</button>
            </div>
          </div>
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
            background: g.color ? `${g.color}22` : '#23233f88',
            border: g.color ? `1px solid ${g.color}44` : '1px solid #46465c33',
            maxWidth: Math.round(400 * scale),
          }}>
            <div
              onClick={() => setExpandedGroupId(isExpanded ? null : groupId)}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setGroupCtxMenu({ id: groupId, x: e.clientX, y: e.clientY }) }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; (e.currentTarget as HTMLElement).style.outline = '2px solid #645efb'; (e.currentTarget as HTMLElement).style.outlineOffset = '-2px' }}
              onDragLeave={(e) => { (e.currentTarget as HTMLElement).style.outline = 'none' }}
              onDrop={async (e) => {
                e.preventDefault();
                (e.currentTarget as HTMLElement).style.outline = 'none'
                const sessionId = e.dataTransfer.getData('text/plain')
                if (sessionId) {
                  const s = sessions.find(x => x.id === sessionId)
                  if (s?.hidden) {
                    setShowHidden(false)
                    await window.api.invoke('session:set-hidden', sessionId, false)
                    if (s.groupId !== groupId) {
                      await window.api.invoke('session:set-group', sessionId, groupId)
                    }
                  } else {
                    await window.api.invoke('session:set-group', sessionId, groupId)
                  }
                  await loadSessions()
                }
              }}
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
              {runningCount > 0 && <span style={{ fontSize: 9, color: '#10b981' }}>●{runningCount > 1 ? runningCount : ''}</span>}
              {detachedCount > 0 && <span style={{ fontSize: 9, color: '#d97706' }}>●{detachedCount > 1 ? detachedCount : ''}</span>}
              <span style={{ fontSize: 9, color: '#aaa8c3' }}>({g.sessions.length})</span>
            </div>
            {isExpanded && (
              <div style={{
                display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: Math.round(4 * scale),
                padding: `0 ${Math.round(8 * scale)}px ${Math.round(6 * scale)}px`,
              }}>
                {g.sessions.map((s) => (
                  <div key={s.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    {renderTag(s, tierMap.get(s.id) || 3)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {/* Ungrouped zone — plain bubbles by default; show a labeled drop frame only while dragging a group/hidden session */}
      {(() => {
        const hasUngrouped = grouped.ungrouped.length > 0
        const draggedSession = draggingSessionId ? sessions.find(x => x.id === draggingSessionId) : null
        const isValidTarget = !!draggedSession && (!!draggedSession.groupId || !!draggedSession.hidden)
        if (!hasUngrouped && !isValidTarget) return null

        const ungroupedDropProps = {
          onDragOver: (e: React.DragEvent) => {
            e.preventDefault(); e.dataTransfer.dropEffect = 'move'
          },
          onDrop: async (e: React.DragEvent) => {
            e.preventDefault()
            const sessionId = e.dataTransfer.getData('text/plain')
            if (!sessionId) return
            const s = sessions.find(x => x.id === sessionId)
            if (s?.hidden) {
              await window.api.invoke('session:set-hidden', sessionId, false)
            }
            if (s?.groupId) {
              await window.api.invoke('session:set-group', sessionId, null)
            }
            await loadSessions()
          },
        }

        const innerBubbles = bubble.layout === 'stack' ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: Math.round(4 * scale) }}>
            {grouped.ungrouped.map((s) => (
              <div key={s.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                {renderTag(s, 2)}
              </div>
            ))}
          </div>
        ) : bubble.layout === 'arc' ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: Math.round(6 * scale), justifyContent: 'center' }}>
            {grouped.ungrouped.map((s) => (
              <div key={s.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                {renderTag(s, 2)}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: Math.round(5 * scale), justifyContent: 'center', alignItems: 'flex-end' }}>
            {(showAllUngrouped ? small : small.slice(0, 3)).map((s) => (
              <div key={s.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                {renderTag(s, tierMap.get(s.id) || 3)}
              </div>
            ))}
            {small.length > 3 && !showAllUngrouped && (
              <button
                onClick={() => setShowAllUngrouped(true)}
                style={{
                  fontSize: Math.round(9 * scale), color: '#aaa8c3', background: '#23233f66',
                  border: '1px solid #46465c33', borderRadius: 9999,
                  padding: `${Math.round(3 * scale)}px ${Math.round(10 * scale)}px`,
                  cursor: 'pointer', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", alignSelf: 'center',
                }}
              >+{small.length - 3} more</button>
            )}
            {medium.map((s) => (
              <div key={s.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                {renderTag(s, tierMap.get(s.id) || 1)}
              </div>
            ))}
            {hero && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                {renderTag(hero, 0)}
              </div>
            )}
          </div>
        )

        // Not dragging a valid drop source — render bubbles plain, no frame/background
        if (!isValidTarget) return innerBubbles

        // Dragging a valid source — show labeled drop frame
        return (
          <div {...ungroupedDropProps}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              gap: Math.round(4 * scale),
              padding: `${Math.round(5 * scale)}px ${Math.round(8 * scale)}px`,
              borderRadius: Math.round(10 * scale),
              background: '#645efb22',
              border: '1px dashed #645efb88',
              minWidth: Math.round(160 * scale),
            }}
          >
            <div style={{
              fontSize: Math.round(9 * scale), color: '#a7a5ff',
              fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
              letterSpacing: 0.3,
            }}>
              {hasUngrouped ? `未分组 (${grouped.ungrouped.length})` : '拖到此处离开分组'}
            </div>
            {hasUngrouped && innerBubbles}
          </div>
        )
      })()}

      {/* Hidden sessions toggle */}
      {(() => {
        // Include dead hidden sessions too — otherwise they vanish from UI entirely
        // once marked dead, and user has no way to delete/restore them without DB surgery.
        const hiddenAlive = sessions.filter((s) => hiddenIds.has(s.id))
        const draggedSession = draggingSessionId ? sessions.find(x => x.id === draggingSessionId) : null
        // Valid drop-to-hide target when dragging a non-hidden session
        const isHideTarget = !!draggedSession && !draggedSession.hidden
        // Show the pill if there are any hidden sessions OR if user is dragging a hide-candidate
        if (hiddenAlive.length === 0 && !isHideTarget) return null
        return (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: Math.round(4 * scale), justifyContent: 'center', alignItems: 'center' }}>
            <button
              onClick={() => setShowHidden(!showHidden)}
              onDragOver={(e) => {
                if (!isHideTarget) return
                e.preventDefault(); e.dataTransfer.dropEffect = 'move'
                ;(e.currentTarget as HTMLElement).style.outline = '2px solid #a7a5ff'
                ;(e.currentTarget as HTMLElement).style.outlineOffset = '-2px'
              }}
              onDragLeave={(e) => { (e.currentTarget as HTMLElement).style.outline = 'none' }}
              onDrop={async (e) => {
                e.preventDefault();
                (e.currentTarget as HTMLElement).style.outline = 'none'
                const sessionId = e.dataTransfer.getData('text/plain')
                if (sessionId) {
                  await window.api.invoke('session:set-hidden', sessionId, true)
                  await loadSessions()
                }
              }}
              style={{
                fontSize: Math.round(9 * scale),
                color: isHideTarget ? '#a7a5ff' : '#8886a5',
                background: isHideTarget ? '#645efb22' : '#23233f44',
                border: isHideTarget ? '1px dashed #645efb88' : '1px dashed #46465c44',
                borderRadius: 9999,
                padding: `${Math.round(2 * scale)}px ${Math.round(8 * scale)}px`,
                cursor: 'pointer', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
              }}
            >{isHideTarget
              ? '拖到此处隐藏'
              : showHidden
                ? '收起'
                : `👻 ${hiddenAlive.length} 个已隐藏`}</button>
            {showHidden && hiddenAlive.map((s) => (
              <div key={s.id}
                draggable
                onDragStart={(e) => { e.dataTransfer.setData('text/plain', s.id); e.dataTransfer.effectAllowed = 'move'; setDraggingSessionId(s.id) }}
                onDragEnd={() => setDraggingSessionId(null)}
                onClick={() => onAttach(s.id)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleToggleHidden(s.id) }}
                title="拖到分组/未分组区显示"
                style={{
                  display: 'inline-block',
                  fontSize: Math.round(9 * scale), color: '#e5e3ff', background: '#23233fcc',
                  border: '1px solid #46465c55', borderRadius: 9999,
                  padding: `${Math.round(2 * scale)}px ${Math.round(8 * scale)}px`,
                  cursor: 'grab', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
                }}
              >{s.title}</div>
            ))}
          </div>
        )
      })()}

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
            {[
              { label: '✏️ 重命名', action: () => { const s = alive.find(x => x.id === ctxMenu.id); if (s) startRename(s) } },
              { label: '♻️ 重启会话', action: () => { onRestart(ctxMenu.id); setCtxMenu(null) } },
              { label: '📂 打开目录', action: () => { const s = alive.find(x => x.id === ctxMenu.id); if (s?.cwd) window.api.invoke('shell:open-path', s.cwd); setCtxMenu(null) } },
              { label: '📦 技能', action: () => { onOpenSkills(ctxMenu.id); setCtxMenu(null) } },
              { label: '🌱 环境变量', action: () => { onEditEnv(ctxMenu.id); setCtxMenu(null) } },
              ...(ctxMenu && sessions.find(s => s.id === ctxMenu.id)?.groupId ? [{
                label: '📌 设为主窗口',
                action: async () => {
                  const session = sessions.find(s => s.id === ctxMenu!.id)
                  if (session?.groupId) {
                    await window.api.invoke('group:set-main-session', session.groupId, session.id)
                  }
                  setCtxMenu(null)
                }
              }] : []),
              null,
              { label: '✕ 退出', action: () => { onKill(ctxMenu.id); setCtxMenu(null) }, color: '#ff6e84' },
              { label: '🗑️ 退出并删除', action: async () => {
                const s = alive.find(x => x.id === ctxMenu.id)
                const ok = window.confirm(`确定删除「${s?.title || '会话'}」？\n会话目录和 claude 对话文件将被清除，不可恢复。`)
                if (ok) {
                  await window.api.invoke('session:kill-and-delete', ctxMenu.id)
                }
                setCtxMenu(null)
              }, color: '#ff6e84' },
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

      {/* Group context menu */}
      {groupCtxMenu && (
        <TagCtxMenu x={groupCtxMenu.x} y={groupCtxMenu.y} glass={theme.glass} dim={theme.dim}
          onClose={() => setGroupCtxMenu(null)}>
          {/* Create session in this group */}
          <button onClick={async () => {
            const gid = groupCtxMenu.id
            setGroupCtxMenu(null)
            try {
              await window.api.invoke('session:create-in-group', gid)
              await loadSessions()
            } catch (e: any) {
              console.error('create-in-group failed:', e)
              window.alert(`创建失败: ${e?.message || e}`)
            }
          }}
            style={{
              display: 'block', width: '100%', padding: '6px 12px', textAlign: 'left',
              background: 'none', border: 'none', color: '#e5e3ff', cursor: 'pointer',
              fontSize: 12, fontFamily: 'inherit', borderRadius: 6,
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.background = `${theme.dim}33` }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'none' }}
          >+ 在此组创建会话</button>
          <button onClick={async () => {
            try {
              await window.api.invoke('group:restart-sessions', groupCtxMenu.id)
            } catch (e: any) {
              console.error('restart group sessions failed:', e)
            }
            setGroupCtxMenu(null)
          }}
            style={{
              display: 'block', width: '100%', padding: '6px 12px', textAlign: 'left',
              background: 'none', border: 'none', color: '#e5e3ff', cursor: 'pointer',
              fontSize: 12, fontFamily: 'inherit', borderRadius: 6,
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.background = `${theme.dim}33` }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'none' }}
          >♻️ 重启组内会话</button>
          {/* Rename group inline */}
          <div style={{ display: 'flex', gap: 4, padding: '4px 10px' }}>
            <input
              defaultValue={sessions.find(s => s.groupId === groupCtxMenu.id)?.groupName || ''}
              onKeyDown={async (e) => {
                if (e.key === 'Enter') {
                  const val = (e.target as HTMLInputElement).value.trim()
                  if (val) {
                    await window.api.invoke('group:rename', groupCtxMenu.id, val)
                    setGroupCtxMenu(null)
                  }
                }
              }}
              placeholder="重命名..."
              style={{ flex: 1, padding: '3px 6px', borderRadius: 6, fontSize: 11, background: '#17172f', border: '1px solid #46465c44', color: '#e5e3ff', outline: 'none', fontFamily: 'inherit' }}
            />
          </div>
          <div style={{ padding: '6px 10px 4px', display: 'flex', gap: 5, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: '#aaa8c3' }}>🎨</span>
            {BUBBLE_PRESETS.map((c) => (
              <button key={c} onClick={async () => { await window.api.invoke('group:set-color', groupCtxMenu.id, c); setGroupCtxMenu(null) }}
                style={{
                  width: 16, height: 16, borderRadius: '50%', background: c, border: 'none', cursor: 'pointer',
                  outline: sessions.find(s => s.groupId === groupCtxMenu.id)?.groupColor === c ? '2px solid #fff' : 'none', outlineOffset: 1,
                }} />
            ))}
            <button onClick={async () => { await window.api.invoke('group:set-color', groupCtxMenu.id, null); setGroupCtxMenu(null) }}
              style={{ width: 16, height: 16, borderRadius: '50%', background: '#333', border: '1px dashed #666', cursor: 'pointer', fontSize: 8, color: '#999' }}
              title="恢复默认">✕</button>
          </div>
        </TagCtxMenu>
      )}

      {/* Agent metadata editor popup */}
      {metadataPopup && (
        <div
          style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 300,
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <AgentMetadataPopup
            session={metadataPopup}
            onSave={async (roles, expertise) => {
              try {
                await setAgentMetadata(metadataPopup.id, roles, expertise)
                setMetadataPopup(null)
              } catch (err) {
                console.error('[kitty] set agent metadata failed:', err)
              }
            }}
            onClose={() => setMetadataPopup(null)}
          />
        </div>
      )}
    </div>
  )
}

function TagCtxMenu({ x, y, glass, onClose, children }: {
  x: number; y: number; glass: string; dim?: string; onClose: () => void; children: React.ReactNode
}) {
  const autoCloseRef = useAutoClose(true, onClose)
  const nodeRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [maxH, setMaxH] = useState<number | undefined>(undefined)

  // Reposition menu to stay within viewport, called on mount and resize
  const reposition = useCallback(() => {
    const node = nodeRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = x
    let top = y
    if (rect.right > vw) left = Math.max(4, vw - rect.width - 4)
    if (rect.bottom > vh) top = Math.max(4, vh - rect.height - 4)
    if (top < 4) top = 4
    const available = vh - top - 4
    setMaxH(rect.height > available ? available : undefined)
    setPos({ left, top })
  }, [x, y])

  const setRef = useCallback((node: HTMLDivElement | null) => {
    (autoCloseRef as any).current = node
    nodeRef.current = node
    if (node) reposition()
  }, [autoCloseRef, reposition])

  // Re-measure when children change size (e.g. group submenu expands)
  useEffect(() => {
    const node = nodeRef.current
    if (!node) return
    const ro = new ResizeObserver(() => reposition())
    ro.observe(node)
    return () => ro.disconnect()
  }, [reposition])

  useEffect(() => { setPos({ left: x, top: y }); setMaxH(undefined) }, [x, y])

  return (
    <div ref={setRef} style={{
      position: 'fixed', left: pos.left, top: pos.top, zIndex: 200,
      background: `${glass}f0`, backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
      borderRadius: 12, padding: '4px 0', minWidth: 150,
      maxHeight: maxH ?? '85vh', overflowY: 'auto',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif"
    }}>
      {children}
    </div>
  )
}
