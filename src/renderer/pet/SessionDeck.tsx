import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GroupInfo, GroupRestartProgress, SessionInfo } from '@shared/types/session'
import { useConfigStore } from '../store/config-store'
import { useSessionStore } from '../store/session-store'
import {
  buildDeckForest,
  chooseVerticalDirection,
  countDeckDescendants,
  nextDeckAxis,
  openDeckGroup,
  toggleDeckSubtree,
  type DeckAxis,
  type DeckEdge,
  type DeckGroupNode,
  type VerticalDirection,
} from './deck-tree'
import { clampMenuPosition } from './menu-position'
import { useAutoClose } from './useAutoClose'
import './SessionDeck.css'

interface Props {
  sessions: SessionInfo[]
  edge: DeckEdge
  closing?: boolean
  onClose: () => void
  onCreateDirect: () => void
  onCreateInDirectory: () => void
  onAttach: (id: string) => void
  onKill: (id: string) => void
  onRename: (id: string, title: string) => void
  onRestart: (id: string) => void
  onClearConversation: (id: string) => void
  onEditEnv: (id: string) => void
  onOpenSkills: (sessionId: string) => void
}

type DeckItem =
  | { kind: 'session'; session: SessionInfo }
  | { kind: 'group'; node: DeckGroupNode }

interface DragState {
  kind: 'session' | 'group'
  id: string
  title: string
  x: number
  y: number
  active: boolean
  target: string | null
}

interface ChildGroupDialogState {
  groupId: string
  depth?: number
  x: number
  y: number
  rootBranchStyle?: React.CSSProperties
}

interface GroupRestartState extends GroupRestartProgress {
  error?: string
}

const DRAG_THRESHOLD = 5

function childItems(node: DeckGroupNode): DeckItem[] {
  const sessions = node.sessions.map((session): DeckItem => ({ kind: 'session', session }))
  const groups = node.children.map((child): DeckItem => ({ kind: 'group', node: child }))
  return [...sessions, ...groups]
}

function ToolIcon({ tool }: { tool: string }) {
  const glyph = tool === 'codex' ? '</>' : tool === 'opencode' ? '⌘' : '✦'
  return <span className="session-deck__tool-icon" aria-hidden="true">{glyph}</span>
}

function GroupIcon() {
  return (
    <svg className="session-deck__group-icon" viewBox="0 0 28 24" aria-hidden="true">
      <path d="M2.5 6.5h8l2.6 3h12.4v11H2.5z" />
      <path d="M5 3.5h8l2.4 3H23v3" opacity=".55" />
    </svg>
  )
}

export default function SessionDeck({
  sessions,
  edge,
  closing = false,
  onClose,
  onCreateDirect,
  onCreateInDirectory,
  onAttach,
  onKill,
  onRename,
  onRestart,
  onClearConversation,
  onEditEnv,
  onOpenSkills,
}: Props) {
  const { bubble } = useConfigStore()
  const needsInput = useSessionStore((state) => state.needsInput)
  const loadSessions = useSessionStore((state) => state.loadSessions)
  const [groups, setGroups] = useState<GroupInfo[]>([])
  const [openGroupIds, setOpenGroupIds] = useState<string[]>([])
  const [verticalDirections, setVerticalDirections] = useState<Record<string, VerticalDirection>>({})
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [sessionMenu, setSessionMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [groupMenu, setGroupMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [showMoveMenu, setShowMoveMenu] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number } | null>(null)
  const [childGroupDialog, setChildGroupDialog] = useState<ChildGroupDialogState | null>(null)
  const [childGroupCreating, setChildGroupCreating] = useState(false)
  const [childGroupError, setChildGroupError] = useState('')
  const [rootBranchStyle, setRootBranchStyle] = useState<React.CSSProperties | null>(null)
  const [groupRestart, setGroupRestart] = useState<GroupRestartState | null>(null)
  const branchPortalRef = useRef<HTMLDivElement | null>(null)

  const collapseBranches = useCallback(() => {
    setOpenGroupIds([])
    setVerticalDirections({})
    setRootBranchStyle(null)
  }, [])

  const accent = /^#[0-9a-f]{6}$/i.test(bubble.deckAccentColor || '')
    ? bubble.deckAccentColor
    : '#6fd7c8'

  const loadGroups = useCallback(async () => {
    const result = await window.api.invoke('group:list') as GroupInfo[]
    setGroups(result || [])
  }, [])

  useEffect(() => { void loadGroups() }, [sessions, loadGroups])

  useEffect(() => {
    const closeTransientSurfaces = () => {
      setSessionMenu(null)
      setGroupMenu(null)
      setCreateMenu(null)
      setShowMoveMenu(false)
      collapseBranches()
    }
    const unsubscribe = window.api.on('window-blur', closeTransientSurfaces)
    return unsubscribe
  }, [collapseBranches])

  useEffect(() => window.api.on('group:restart-progress', (value) => {
    const progress = value as GroupRestartProgress
    if (!progress?.groupId || !progress?.operationId) return
    setGroupRestart(progress)
  }), [])

  useEffect(() => {
    if (!groupRestart?.done || groupRestart.error) return
    const operationId = groupRestart.operationId
    const timer = window.setTimeout(() => {
      setGroupRestart((current) => current?.operationId === operationId ? null : current)
    }, 3500)
    return () => window.clearTimeout(timer)
  }, [groupRestart?.done, groupRestart?.error, groupRestart?.operationId])

  const visibleSessions = useMemo(
    () => sessions.filter((session) => session.status !== 'dead' && !session.hidden),
    [sessions],
  )
  const hiddenSessions = useMemo(
    () => sessions.filter((session) => !!session.hidden),
    [sessions],
  )
  const forest = useMemo(() => buildDeckForest(groups, visibleSessions), [groups, visibleSessions])
  const groupedIds = useMemo(() => new Set(groups.map((group) => group.id)), [groups])
  const ungrouped = useMemo(
    () => visibleSessions.filter((session) => !session.groupId || !groupedIds.has(session.groupId)),
    [visibleSessions, groupedIds],
  )
  const rootItems = useMemo<DeckItem[]>(() => [
    ...ungrouped.map((session): DeckItem => ({ kind: 'session', session })),
    ...forest.map((node): DeckItem => ({ kind: 'group', node })),
  ], [ungrouped, forest])

  // A root click can reveal several nested vertical branches in one render.
  // Measure every newly visible group card so each branch chooses the side with
  // usable viewport space, not only the group that received the original click.
  useLayoutEffect(() => {
    if (openGroupIds.length === 0) {
      setVerticalDirections((current) => Object.keys(current).length === 0 ? current : {})
      return
    }
    const next: Record<string, VerticalDirection> = {}
    const cards = document.querySelectorAll<HTMLElement>('[data-deck-group-id][data-child-axis="vertical"]')
    for (const card of cards) {
      const groupId = card.dataset.deckGroupId
      if (!groupId || !openGroupIds.includes(groupId)) continue
      const itemCount = Number(card.dataset.childCount) || 1
      const rect = card.getBoundingClientRect()
      const height = Math.min(Math.max(itemCount, 1), 6) * 76 + 24
      next[groupId] = chooseVerticalDirection(rect.top, rect.bottom, height, window.innerHeight)
    }
    setVerticalDirections((current) => {
      const currentKeys = Object.keys(current)
      const nextKeys = Object.keys(next)
      const unchanged = currentKeys.length === nextKeys.length
        && nextKeys.every((key) => current[key] === next[key])
      return unchanged ? current : next
    })
  }, [groups, openGroupIds, visibleSessions])

  const toggleGroup = useCallback((
    node: DeckGroupNode,
    depth: number,
    target: HTMLElement,
  ) => {
    const groupId = node.group.id
    const next = toggleDeckSubtree(openGroupIds, node, depth === 0)
    if (depth === 0 && next.includes(groupId)) {
      const rect = target.getBoundingClientRect()
      setRootBranchStyle(edge === 'left'
        ? { top: rect.top + rect.height / 2, left: rect.right + 14 }
        : { top: rect.top + rect.height / 2, right: window.innerWidth - rect.left + 14 })
    } else if (depth === 0) {
      setRootBranchStyle(null)
    }
    setOpenGroupIds(next)
  }, [edge, openGroupIds])

  const refresh = useCallback(async () => {
    await Promise.all([loadGroups(), loadSessions()])
  }, [loadGroups, loadSessions])

  const restartGroup = useCallback(async (group: GroupInfo) => {
    setGroupMenu(null)
    setGroupRestart({
      operationId: `pending:${group.id}`,
      groupId: group.id,
      groupName: group.name,
      completed: 0,
      total: 0,
      ok: 0,
      fail: 0,
      done: false,
    })
    try {
      const result = await window.api.invoke('group:restart-sessions', group.id) as {
        operationId: string
        total: number
        ok: number
        fail: number
      }
      setGroupRestart((current) => current?.groupId === group.id ? {
        operationId: result.operationId,
        groupId: group.id,
        groupName: group.name,
        completed: result.total,
        total: result.total,
        ok: result.ok,
        fail: result.fail,
        done: true,
      } : current)
      await refresh()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setGroupRestart((current) => current?.groupId === group.id ? {
        ...current,
        done: true,
        error: message,
      } : current)
    }
  }, [refresh])

  const openChildGroupDialog = useCallback((
    groupId: string,
    depth: number | undefined,
    x: number,
    y: number,
    target?: HTMLElement,
  ) => {
    setChildGroupError('')
    let nextRootBranchStyle: React.CSSProperties | undefined
    if (depth === 0 && target) {
      const rect = target.getBoundingClientRect()
      nextRootBranchStyle = edge === 'left'
        ? { top: rect.top + rect.height / 2, left: rect.right + 14 }
        : { top: rect.top + rect.height / 2, right: window.innerWidth - rect.left + 14 }
    }
    setChildGroupDialog({ groupId, depth, x, y, rootBranchStyle: nextRootBranchStyle })
  }, [edge])

  const createChildGroup = useCallback(async (name: string) => {
    if (!childGroupDialog) return
    const { groupId, depth, rootBranchStyle: nextRootBranchStyle } = childGroupDialog
    try {
      setChildGroupCreating(true)
      setChildGroupError('')
      await window.api.invoke('group:create', name, undefined, groupId)
      await refresh()
      if (depth !== undefined) {
        if (depth === 0 && nextRootBranchStyle) setRootBranchStyle(nextRootBranchStyle)
        setOpenGroupIds((current) => openDeckGroup(current, groupId))
      }
      setChildGroupDialog(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setChildGroupError(`创建失败：${message}`)
    } finally {
      setChildGroupCreating(false)
    }
  }, [childGroupDialog, refresh])

  const executeDrop = useCallback(async (state: DragState, target: string) => {
    try {
      const parentId = target.startsWith('group:') ? target.slice(6) : null
      if (state.kind === 'session') {
        const current = sessions.find((session) => session.id === state.id)
        if (!current) return
        if (current.hidden) await window.api.invoke('session:set-hidden', state.id, false)
        if (current.groupId !== parentId) await window.api.invoke('session:set-group', state.id, parentId)
      } else {
        if (parentId === state.id) return
        await window.api.invoke('group:set-parent', state.id, parentId)
      }
      await refresh()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`移动失败：${message}`)
    }
  }, [refresh, sessions])

  const startDrag = useCallback((
    event: React.MouseEvent,
    item: Omit<DragState, 'x' | 'y' | 'active' | 'target'>,
    activate: () => void,
  ) => {
    if (event.button !== 0) return
    const interactive = (event.target as HTMLElement | null)?.closest('button, input')
    if (interactive) return
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startY = event.clientY
    let active = false
    let dropTarget: string | null = null
    setDrag({ ...item, x: startX, y: startY, active: false, target: null })

    const onMove = (moveEvent: MouseEvent) => {
      if (!active && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD) return
      if (!active) {
        active = true
        window.dispatchEvent(new CustomEvent('kitty-drag-start'))
        document.body.style.cursor = 'grabbing'
      }
      const element = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY) as HTMLElement | null
      dropTarget = element?.closest('[data-drop]')?.getAttribute('data-drop') || null
      setDrag({ ...item, x: moveEvent.clientX, y: moveEvent.clientY, active: true, target: dropTarget })
    }
    const cleanup = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      if (active) window.dispatchEvent(new CustomEvent('kitty-drag-end'))
    }
    const onUp = (upEvent: MouseEvent) => {
      cleanup()
      if (active && dropTarget) void executeDrop({ ...item, x: upEvent.clientX, y: upEvent.clientY, active, target: dropTarget }, dropTarget)
      else if (Math.hypot(upEvent.clientX - startX, upEvent.clientY - startY) < DRAG_THRESHOLD) activate()
      setDrag(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [executeDrop])

  const attach = useCallback((session: SessionInfo) => {
    collapseBranches()
    setActiveSessionId(session.id)
    onAttach(session.id)
  }, [collapseBranches, onAttach])

  const renderSession = (session: SessionInfo, compact = false) => {
    const selected = activeSessionId === session.id
    const dragging = drag?.kind === 'session' && drag.id === session.id && drag.active
    return (
      <div
        key={`session:${session.id}`}
        className={`session-deck__item session-deck__session${selected ? ' is-selected' : ''}${compact ? ' is-compact' : ''}${dragging ? ' is-dragging' : ''}`}
        onMouseDown={(event) => startDrag(event, { kind: 'session', id: session.id, title: session.title }, () => attach(session))}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setSessionMenu({ id: session.id, x: event.clientX, y: event.clientY })
          setGroupMenu(null)
          setShowMoveMenu(false)
        }}
        title={`${session.tool}: ${session.title}\n${session.cwd || '未设置目录'}`}
      >
        {needsInput.has(session.id) && <span className="session-deck__attention">1</span>}
        <ToolIcon tool={session.tool} />
        <span className="session-deck__label">{session.title}</span>
      </div>
    )
  }

  const renderGroup = (node: DeckGroupNode, axis: DeckAxis, depth: number, compact = false) => {
    const groupId = node.group.id
    const isOpen = openGroupIds.includes(groupId)
    const items = childItems(node)
    const childAxis = nextDeckAxis(axis)
    const direction = verticalDirections[groupId] || 'down'
    const dragging = drag?.kind === 'group' && drag.id === groupId && drag.active
    const isDropTarget = drag?.active && drag.target === `group:${groupId}` && drag.id !== groupId
    const branch = isOpen ? (
      <div
        data-drop={`group:${groupId}`}
        className={[
          'session-deck__branch',
          `is-${childAxis}`,
          `from-${edge}`,
          depth === 0 ? 'is-portaled' : '',
          childAxis === 'vertical' ? `opens-${direction}` : '',
        ].filter(Boolean).join(' ')}
        style={depth === 0 ? rootBranchStyle || undefined : undefined}
      >
        {items.length > 0
          ? renderItems(items, childAxis, depth + 1)
          : <span className="session-deck__empty">拖入会话或分组</span>}
      </div>
    ) : null
    return (
      <div className="session-deck__item-anchor" key={`group:${groupId}`}>
        <div
          data-drop={`group:${groupId}`}
          data-deck-group-id={groupId}
          data-child-axis={childAxis}
          data-child-count={items.length}
          className={`session-deck__item session-deck__group${isOpen ? ' is-selected' : ''}${compact ? ' is-compact' : ''}${dragging ? ' is-dragging' : ''}${isDropTarget ? ' is-drop-target' : ''}`}
          onMouseDown={(event) => {
            const target = event.currentTarget
            startDrag(
              event,
              { kind: 'group', id: groupId, title: node.group.name },
              () => toggleGroup(node, depth, target),
            )
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setGroupMenu({ id: groupId, x: event.clientX, y: event.clientY })
            setSessionMenu(null)
          }}
          title={`${node.group.name} · ${countDeckDescendants(node)} 项\n点击展开 · 拖动可嵌套`}
        >
          <GroupIcon />
          <span className="session-deck__label">{node.group.name}</span>
          <button
            className="session-deck__group-add"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              openChildGroupDialog(
                groupId,
                depth,
                event.clientX,
                event.clientY,
                (event.currentTarget.closest('.session-deck__item') as HTMLElement | null) || undefined,
              )
            }}
            aria-label={`在 ${node.group.name} 中新建子分组`}
            title="新建子分组"
          >＋</button>
          <span className="session-deck__count">{countDeckDescendants(node)}</span>
        </div>
        {depth === 0
          ? branch && rootBranchStyle && branchPortalRef.current
            ? createPortal(branch, branchPortalRef.current)
            : null
          : branch}
      </div>
    )
  }

  const renderItems = (items: DeckItem[], axis: DeckAxis, depth: number) => (
    <div className={`session-deck__items is-${axis}`}>
      {items.map((item) => item.kind === 'session'
        ? renderSession(item.session)
        : renderGroup(item.node, axis, depth))}
    </div>
  )

  const selectedSession = sessionMenu
    ? sessions.find((session) => session.id === sessionMenu.id)
    : undefined
  const selectedGroup = groupMenu
    ? groups.find((group) => group.id === groupMenu.id)
    : undefined

  return (
    <div
      className={`session-deck is-${edge} is-floating${closing ? ' is-closing' : ''}`}
      style={{ '--deck-accent': accent } as React.CSSProperties}
      data-drop="root"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.stopPropagation()
      }}
    >
      <div
        className="session-deck__rail"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) collapseBranches()
        }}
      >
        <button
          className="session-deck__collapse"
          onClick={onClose}
          aria-label="收起边栏"
          title="收起成猫"
        >{edge === 'left' ? '‹' : '›'}</button>
        <div
          className="session-deck__root-scroll"
          data-drop="root"
          onScroll={collapseBranches}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) collapseBranches()
          }}
        >
          {rootItems.map((item) => item.kind === 'session'
            ? renderSession(item.session, true)
            : renderGroup(item.node, 'vertical', 0, true))}
          {showHidden && hiddenSessions.map((session) => renderSession(session, true))}
        </div>
        <div className="session-deck__footer">
          {hiddenSessions.length > 0 && (
            <button
              className={`session-deck__utility${showHidden ? ' is-selected' : ''}`}
              onClick={() => {
                collapseBranches()
                setCreateMenu(null)
                setShowHidden((value) => !value)
              }}
              title="隐藏的会话"
            >◌<span>{hiddenSessions.length}</span></button>
          )}
          <button
            className={`session-deck__add${createMenu ? ' is-selected' : ''}`}
            onClick={(event) => {
              event.stopPropagation()
              collapseBranches()
              setSessionMenu(null)
              setGroupMenu(null)
              setShowMoveMenu(false)
              const rect = event.currentTarget.getBoundingClientRect()
              setCreateMenu((current) => current ? null : {
                x: edge === 'left' ? rect.right + 8 : rect.left - 184,
                y: rect.top,
              })
            }}
            aria-label="新建会话"
            title="新建会话"
          >＋</button>
        </div>
      </div>

      <div ref={branchPortalRef} className="session-deck__branch-portal" />

      {createMenu && (
        <DeckMenu x={createMenu.x} y={createMenu.y} onClose={() => setCreateMenu(null)}>
          <button onClick={() => {
            setCreateMenu(null)
            onCreateInDirectory()
          }}>📂 从目录开始</button>
          <button onClick={() => {
            setCreateMenu(null)
            onCreateDirect()
          }}>💬 直接开始</button>
        </DeckMenu>
      )}

      {drag?.active && (
        <div className="session-deck__drag-preview" style={{ left: drag.x + 12, top: drag.y + 12 }}>
          {drag.kind === 'group' ? <GroupIcon /> : <span className="session-deck__tool-icon" aria-hidden="true">↗</span>}
          <span>{drag.title}</span>
        </div>
      )}

      {childGroupDialog && (
        <DeckNameDialog
          x={childGroupDialog.x}
          y={childGroupDialog.y}
          title={`在 ${groups.find((group) => group.id === childGroupDialog.groupId)?.name || '分组'} 中新建子分组`}
          busy={childGroupCreating}
          error={childGroupError}
          onClose={() => {
            if (!childGroupCreating) setChildGroupDialog(null)
          }}
          onSubmit={(name) => { void createChildGroup(name) }}
        />
      )}

      {sessionMenu && selectedSession && (
        <DeckMenu x={sessionMenu.x} y={sessionMenu.y} onClose={() => { setSessionMenu(null); setShowMoveMenu(false) }}>
          <button onClick={() => { attach(selectedSession); setSessionMenu(null) }}>打开会话</button>
          <button onClick={() => { onRestart(selectedSession.id); setSessionMenu(null) }}>重启</button>
          <button onClick={() => { onClearConversation(selectedSession.id); setSessionMenu(null) }}>清空对话</button>
          <button onClick={() => { onEditEnv(selectedSession.id); setSessionMenu(null) }}>环境与参数</button>
          <button onClick={() => { onOpenSkills(selectedSession.id); setSessionMenu(null) }}>技能 / MCP</button>
          <button onClick={() => {
            const title = window.prompt('会话名称', selectedSession.title)?.trim()
            if (title) onRename(selectedSession.id, title)
            setSessionMenu(null)
          }}>重命名</button>
          <button onClick={() => setShowMoveMenu((value) => !value)}>移动到分组…</button>
          {showMoveMenu && (
            <div className="session-deck__menu-sublist">
              <button onClick={async () => { await window.api.invoke('session:set-group', selectedSession.id, null); setSessionMenu(null); await refresh() }}>未分组</button>
              {groups.map((group) => (
                <button key={group.id} onClick={async () => { await window.api.invoke('session:set-group', selectedSession.id, group.id); setSessionMenu(null); await refresh() }}>
                  {selectedSession.groupId === group.id ? '✓ ' : ''}{group.name}
                </button>
              ))}
            </div>
          )}
          <button onClick={async () => { await window.api.invoke('session:set-hidden', selectedSession.id, true); setSessionMenu(null); await refresh() }}>隐藏</button>
          <button className="is-danger" onClick={() => { onKill(selectedSession.id); setSessionMenu(null) }}>结束会话</button>
        </DeckMenu>
      )}

      {groupMenu && selectedGroup && (
        <DeckMenu x={groupMenu.x} y={groupMenu.y} onClose={() => setGroupMenu(null)}>
          <button onClick={async () => { await window.api.invoke('session:create-in-group', selectedGroup.id); setGroupMenu(null); await refresh() }}>在此组创建会话</button>
          <button onClick={async () => {
            setGroupMenu(null)
            openChildGroupDialog(selectedGroup.id, undefined, groupMenu.x, groupMenu.y)
          }}>新建子分组</button>
          <button onClick={async () => {
            const name = window.prompt('分组名称', selectedGroup.name)?.trim()
            if (name) await window.api.invoke('group:rename', selectedGroup.id, name)
            setGroupMenu(null)
            await refresh()
          }}>重命名</button>
          {selectedGroup.parentGroupId && (
            <button onClick={async () => { await window.api.invoke('group:set-parent', selectedGroup.id, null); setGroupMenu(null); await refresh() }}>移到根层级</button>
          )}
          <button onClick={() => { void restartGroup(selectedGroup) }}>重启整个分组</button>
          <button className="is-danger" onClick={async () => { await window.api.invoke('group:archive', selectedGroup.id); setGroupMenu(null); await refresh() }}>归档分组</button>
        </DeckMenu>
      )}

      {groupRestart && (
        <GroupRestartProgressCard
          progress={groupRestart}
          onClose={() => setGroupRestart(null)}
        />
      )}
    </div>
  )
}

function GroupRestartProgressCard({ progress, onClose }: {
  progress: GroupRestartState
  onClose: () => void
}) {
  const percent = progress.total > 0
    ? Math.round((progress.completed / progress.total) * 100)
    : progress.done ? 100 : 0
  const detail = progress.error
    ? `重启失败：${progress.error}`
    : progress.done
      ? progress.total === 0
        ? '没有可重启的运行中会话'
        : `完成 ${progress.ok} 个${progress.fail ? `，失败 ${progress.fail} 个` : ''}`
      : progress.total === 0
        ? '正在统计会话…'
        : `正在重启 ${progress.currentTitle || '会话'} · ${progress.completed}/${progress.total}`

  return (
    <div className={`session-deck__restart-progress${progress.error ? ' is-error' : ''}${progress.done ? ' is-done' : ''}`}>
      <div className="session-deck__restart-header">
        <span>重启 {progress.groupName}</span>
        <strong>{percent}%</strong>
        {progress.done && <button onClick={onClose} aria-label="关闭重启进度">×</button>}
      </div>
      <div
        className="session-deck__restart-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="session-deck__restart-detail">{detail}</div>
    </div>
  )
}

function DeckNameDialog({ x, y, title, busy, error, onClose, onSubmit }: {
  x: number
  y: number
  title: string
  busy: boolean
  error: string
  onClose: () => void
  onSubmit: (name: string) => void
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [name, setName] = useState('')
  const [position, setPosition] = useState({ left: x, top: y })

  const submit = useCallback(() => {
    const value = name.trim()
    if (value && !busy) onSubmit(value)
  }, [busy, name, onSubmit])

  const reposition = useCallback(() => {
    const node = dialogRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    setPosition(clampMenuPosition(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight))
  }, [x, y])

  useLayoutEffect(reposition, [reposition])
  useEffect(() => {
    inputRef.current?.focus()
    const onMouseDown = (event: MouseEvent) => {
      if (!dialogRef.current?.contains(event.target as Node)) onClose()
    }
    const onResize = () => reposition()
    document.addEventListener('mousedown', onMouseDown)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('resize', onResize)
    }
  }, [onClose, reposition])

  return (
    <div
      ref={dialogRef}
      className="session-deck__name-dialog"
      style={position}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="session-deck__name-dialog-title">{title}</div>
      <input
        ref={inputRef}
        value={name}
        disabled={busy}
        placeholder="子分组名称"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
          if (event.key === 'Escape' && !busy) onClose()
        }}
      />
      {error && <div className="session-deck__name-dialog-error">{error}</div>}
      <div className="session-deck__name-dialog-actions">
        <button onClick={onClose} disabled={busy}>取消</button>
        <button className="is-primary" onClick={submit} disabled={busy || !name.trim()}>
          {busy ? '创建中…' : '创建'}
        </button>
      </div>
    </div>
  )
}

function DeckMenu({ x, y, onClose, children }: {
  x: number
  y: number
  onClose: () => void
  children: React.ReactNode
}) {
  const autoCloseRef = useAutoClose(true, onClose)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  const reposition = useCallback(() => {
    const node = menuRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    setPosition(clampMenuPosition(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight))
  }, [x, y])
  const setRef = useCallback((node: HTMLDivElement | null) => {
    ;(autoCloseRef as React.MutableRefObject<HTMLDivElement | null>).current = node
    menuRef.current = node
  }, [autoCloseRef])
  useLayoutEffect(reposition, [reposition])
  useEffect(() => {
    const node = menuRef.current
    if (!node) return
    const observer = new ResizeObserver(reposition)
    observer.observe(node)
    window.addEventListener('resize', reposition)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', reposition)
    }
  }, [reposition])
  return (
    <div ref={setRef} className="session-deck__menu" style={position}>
      {children}
    </div>
  )
}
