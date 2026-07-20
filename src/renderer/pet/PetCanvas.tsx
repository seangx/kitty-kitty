import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PetSprite from './PetSprite'
import SessionDeck from './SessionDeck'
import InputPopup from './InputPopup'
import ContextMenu from './ContextMenu'
import SettingsPanel from './SettingsPanel'
import SessionPicker from './SessionPicker'
import SpeechBubble from './SpeechBubble'
import { PetStateMachine } from './animations/state-machine'
import { BehaviorScheduler } from './animations/behaviors'
import type { AnimationState } from '@shared/types/pet'
import { IPC } from '@shared/types/ipc'
import { useSessionStore } from '../store/session-store'
import { useConfigStore } from '../store/config-store'
import type { ToolId } from '../store/config-store'
import type { DirectoryPickResult } from '@shared/directory-session'

interface DirPickState extends DirectoryPickResult { defaultTool: ToolId }

export default function PetCanvas() {
  const [animation, setAnimation] = useState<AnimationState>('idle')
  const [showInput, setShowInput] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [dirPick, setDirPick] = useState<DirPickState | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [speech, setSpeech] = useState<string | null>(null)
  const [envEditor, setEnvEditor] = useState<string | null>(null)
  const [deckEdge, setDeckEdge] = useState<'left' | 'right'>('right')
  const [deckOpen, setDeckOpen] = useState(false)
  const [deckClosing, setDeckClosing] = useState(false)
  const [groupPrompt, setGroupPrompt] = useState(false)
  const [driftPrompt, setDriftPrompt] = useState<{ sessionId: string; drift: import('../lib/ipc').SessionDrift; kind: 'attach' | 'restart' } | null>(null)
  const isDragging = useRef(false)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragOffset = useRef({ x: 0, y: 0 })
  const deckCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { sessions, loadSessions, createSession, attachSession, killSession, renameSession, needsInput, loadNeedsInput, markNeedsInput, clearNeedsInput } = useSessionStore()
  const { bubble, lastTool, setLastTool } = useConfigStore()

  const machine = useMemo(() => new PetStateMachine(setAnimation), [])
  const scheduler = useMemo(() => new BehaviorScheduler(machine), [machine])

  const sayTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const say = useCallback((text: string, duration = 3000) => {
    if (sayTimer.current) clearTimeout(sayTimer.current)
    setSpeech(text)
    sayTimer.current = setTimeout(() => setSpeech(null), duration)
  }, [])

  // 长操作(变身/重启)的阶段心跳:主进程推 transfer:progress 阶段,这里每 3s
  // 用「阶段 + 已用秒数」刷新气泡——拿不到真实百分比(import 是黑盒),只报真话
  const progressStageRef = useRef<{ id: string; stage: string } | null>(null)
  const PROGRESS_TEXT: Record<string, string> = useMemo(() => ({
    scan: '预检会话大小', transfer: '导入 Codex', handoff: '生成交接文档', daemon: '等待 codex daemon', restart: '重启会话',
  }), [])
  const startProgressHeartbeat = useCallback((id: string, title: string, fallbackText: string) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      const cur = progressStageRef.current
      const stageText = cur && cur.id === id ? PROGRESS_TEXT[cur.stage] || fallbackText : fallbackText
      say(`${title} ${stageText}中… ${Math.round((Date.now() - t0) / 1000)}s`, 4000)
    }, 3000)
    return () => { clearInterval(timer); if (progressStageRef.current?.id === id) progressStageRef.current = null }
  }, [say, PROGRESS_TEXT])

  const closeAll = useCallback(() => {
    setShowInput(false)
    setShowSettings(false)
    setDirPick(null)
    setContextMenu(null)
    setGroupPrompt(false)
    setDriftPrompt(null)
    // Don't close envEditor on blur — user must dismiss it explicitly
  }, [])

  useEffect(() => {
    scheduler.start()
    loadSessions()
    const poll = setInterval(() => loadSessions(), 10000)
    const unsub = window.api.on('window-blur', closeAll)
    const unsubProgress = window.api.on('transfer:progress', (msg: any) => {
      if (msg?.sessionId && msg?.stage) progressStageRef.current = { id: msg.sessionId, stage: msg.stage }
    })
    const resetDeck = () => {
      if (deckCloseTimer.current) clearTimeout(deckCloseTimer.current)
      deckCloseTimer.current = null
      setDeckClosing(false)
      setDeckOpen(false)
    }
    const unsubDeckClosed = window.api.on('pet:deck-closed', resetDeck)
    return () => {
      scheduler.stop(); machine.destroy(); clearInterval(poll)
      if (deckCloseTimer.current) clearTimeout(deckCloseTimer.current)
      unsub(); unsubProgress(); unsubDeckClosed()
    }
  }, [scheduler, machine, loadSessions, closeAll])

  // Wakeup ("xxx 在等你") IPC — bound ONCE, never re-binds on session updates,
  // otherwise the 10s sessions poll would tear down + re-bind every cycle and
  // make SessionDeck re-render via loadNeedsInput's fresh Set, stuttering drags.
  const sessionsRef = useRef(sessions)
  useEffect(() => { sessionsRef.current = sessions }, [sessions])
  useEffect(() => {
    loadNeedsInput()
    const unsubNeed = window.api.on('session:needs-input', (msg: any) => {
      if (!msg?.sessionId) return
      markNeedsInput(msg.sessionId)
      const session = sessionsRef.current.find((s) => s.id === msg.sessionId)
      const title = session?.title || String(msg.sessionId).slice(0, 6)
      machine.forceState('happy', 1500)
      say(`${title} 在等你喵~`, 4000)
    })
    const unsubClear = window.api.on('session:needs-input-clear', (msg: any) => {
      if (msg?.sessionId) clearNeedsInput(msg.sessionId)
    })
    // Pane-side triggers (e.g. tmux Alt+C) route here via unix socket.
    const unsubPaneAction = window.api.on('pane:action', async (msg: any) => {
      if (!msg?.sessionId || !msg?.action) return
      if (msg.action === 'clear-conversation') {
        try {
          const { clearConversation } = await import('../lib/ipc')
          const res = await clearConversation(msg.sessionId)
          const title = sessionsRef.current.find((s) => s.id === msg.sessionId)?.title || ''
          say(`${title} ${res?.message || (res?.success ? '已清空' : '清空失败')}`, 4000)
          if (res?.success) machine.forceState('happy', 1500)
          await loadSessions()
        } catch (err: any) { say(err?.message || '清空失败', 4000) }
      } else if (msg.action === 'set-main-session') {
        const s = sessionsRef.current.find((x) => x.id === msg.sessionId)
        if (!s?.groupId) { say('该会话不在分组里喵~', 3000); return }
        try {
          await window.api.invoke('group:set-main-session', s.groupId, s.id)
          say(`${s.title} 设为主窗口喵~`, 3000)
          machine.forceState('happy', 1500)
          await loadSessions()
        } catch (err: any) { say(err?.message || '设置失败', 4000) }
      } else if (msg.action === 'restart') {
        const title = sessionsRef.current.find((s) => s.id === msg.sessionId)?.title || ''
        const stopBeat = startProgressHeartbeat(msg.sessionId, title, '重启')
        try {
          machine.forceState('dance', 60000)
          say(`${title} 重启中喵~`)
          await window.api.invoke('session:restart-agent', msg.sessionId)
          stopBeat()
          machine.forceState('happy', 2000)
          say('重启完成喵~')
          await loadSessions()
        } catch (err: any) {
          stopBeat()
          machine.forceState('sad', 1500)
          say(err?.message || '重启失败喵...')
        }
      } else if (msg.action === 'transfer-codex') {
        const title = sessionsRef.current.find((s) => s.id === msg.sessionId)?.title || ''
        say(`${title} 变身中喵~`, 4000)
        machine.forceState('think', 60000)
        const stopBeat = startProgressHeartbeat(msg.sessionId, title, '变身')
        try {
          const res: any = await window.api.invoke('session:transfer-codex', msg.sessionId)
          stopBeat()
          say(`${title} ${res?.message || (res?.success ? '转移完成' : '转移失败')}`, 6000)
          machine.forceState(res?.success ? 'happy' : 'sad', 1500)
          await loadSessions()
        } catch (err: any) {
          stopBeat()
          say(err?.message || '转移失败喵...', 5000)
          machine.forceState('sad', 1500)
        }
      }
    })
    return () => { unsubNeed(); unsubClear(); unsubPaneAction() }
  }, [loadNeedsInput, markNeedsInput, clearNeedsInput, loadSessions, machine, say, startProgressHeartbeat])

  // Ntfy push notifications — keep last 3
  const [ntfyMessages, setNtfyMessages] = useState<Array<{ id: number; text: string; url?: string; color: string; time: string }>>([])
  const [ntfyDismissing, setNtfyDismissing] = useState(false)
  const ntfyIdRef = useRef(0)
  useEffect(() => {
    const unsub = window.api.on(IPC.NTFY_MESSAGE, (msg: any) => {
      const title = msg.title || msg.message || '通知'
      const body = msg.title ? msg.message : ''
      const text = body ? `${title}: ${body}` : title
      const tags: string[] = msg.tags || []
      const isError = tags.some((t: string) => /fail|error|x/i.test(t))
      const isSuccess = tags.some((t: string) => /success|check|white_check_mark/i.test(t))
      const color = isError ? '#e11d48' : isSuccess ? '#10b981' : '#645efb'
      const now = new Date()
      const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`

      machine.forceState(isError ? 'sad' : 'happy', 3000)
      setNtfyDismissing(false)
      ntfyIdRef.current++
      setNtfyMessages(prev => [{ id: ntfyIdRef.current, text, url: msg.url, color, time }, ...prev].slice(0, 3))
    })
    return () => { unsub() }
  }, [machine])

  const dismissNtfy = useCallback(() => {
    setNtfyDismissing(true)
    // Last card starts first (bottom-up), stagger 80ms, fly-out 200ms
    const count = ntfyMessages.length
    setTimeout(() => { setNtfyMessages([]); setNtfyDismissing(false) }, count * 80 + 200)
  }, [ntfyMessages.length])

  const anyPopup = showInput || showSettings || !!dirPick || !!envEditor || groupPrompt || !!driftPrompt

  const clickAnimations: AnimationState[] = ['happy', 'dance', 'jump', 'roll', 'stretch', 'lick', 'sneak']
  const clickIndex = useRef(0)

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (isDragging.current || anyPopup) return
    e.stopPropagation()
    if (clickTimer.current) {
      clearTimeout(clickTimer.current); clickTimer.current = null
      // Double-click: create a new session directly and attach using the last-used tool
      ;(async () => {
        try {
          machine.forceState('dance', 10000)
          say(lastTool === 'codex' ? '启动 Codex 中喵~' : lastTool === 'opencode' ? '启动 OpenCode 中喵~' : '启动中喵~')
          await createSession(lastTool)
          machine.forceState('happy', 2000)
          say('开始新对话喵~')
        } catch (err: any) {
          console.error('[kitty] create session failed:', err)
          machine.forceState('sad', 2000)
          say(err?.message || '出错了喵...')
        }
      })()
    } else {
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null
        const anim = clickAnimations[clickIndex.current % clickAnimations.length]
        clickIndex.current++
        machine.forceState(anim, 2000)
      }, 250)
    }
  }, [machine, anyPopup, createSession, say, lastTool])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    setShowInput(false); setShowSettings(false); setDirPick(null)
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0 || anyPopup) return
    dragOffset.current = { x: e.screenX, y: e.screenY }; isDragging.current = false
    const onMove = (ev: MouseEvent) => {
      const dx = ev.screenX - dragOffset.current.x, dy = ev.screenY - dragOffset.current.y
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        if (!isDragging.current) window.api.invoke('drag-start')
        isDragging.current = true
        if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null }
        window.api.invoke('move-window', dx, dy)
        dragOffset.current = { x: ev.screenX, y: ev.screenY }
      }
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp)
      if (isDragging.current) window.api.invoke('drag-end')
      setTimeout(() => { isDragging.current = false }, 150)
    }
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
  }, [anyPopup])

  const handleCreateSession = useCallback(async (message: string, tool: ToolId) => {
    setLastTool(tool)
    try {
      machine.forceState('dance', 15000)
      say(tool === 'codex' ? '启动 Codex 中喵~' : tool === 'opencode' ? '启动 OpenCode 中喵~' : '启动中喵~')
      await createSession(tool, message)
      machine.forceState('happy', 2000)
      say('开始新对话喵~')
    } catch (err) { console.error('[kitty] create session failed:', err); machine.forceState('sad', 2000); say('出错了喵...') }
  }, [createSession, machine, say, setLastTool])

  const performAttach = useCallback(async (id: string) => {
    machine.forceState('dance', 15000)
    say('连接中喵~')
    const alive = await attachSession(id)
    if (alive) {
      const session = sessions.find(s => s.id === id)
      if (session?.status === 'running') {
        say('这个窗口已经开着啦~')
        machine.forceState('idle', 1000)
      } else {
        machine.forceState('happy', 1500)
      }
    } else {
      say('这个会话已经结束了喵...')
      machine.forceState('sad', 1500)
    }
  }, [attachSession, sessions, machine, say])

  const doRestart = useCallback(async (id: string) => {
    const title = sessions.find((s) => s.id === id)?.title || ''
    const stopBeat = startProgressHeartbeat(id, title, '重启')
    try {
      machine.forceState('dance', 60000)
      say(`${title} 重启中喵~`)
      await window.api.invoke('session:restart-agent', id)
      stopBeat()
      machine.forceState('happy', 2000)
      say('重启完成喵~')
    } catch (err: any) {
      stopBeat()
      machine.forceState('sad', 1500)
      say(err?.message || '重启失败喵...')
    }
  }, [machine, say, sessions, startProgressHeartbeat])

  const handleAttach = useCallback(async (id: string) => {
    // Drift check: if claude/codex has rolled over to a newer jsonl (e.g. after
    // /clear), prompt before attaching. We check both detached AND running rows
    // — the running case happens within the same pane (claude rolled the file
    // mid-session), and we'll only update the DB record without touching tmux.
    try {
      const { checkSessionDrift } = await import('../lib/ipc')
      const drift = await checkSessionDrift(id)
      if (drift) {
        setDriftPrompt({ sessionId: id, drift, kind: 'attach' })
        return
      }
    } catch { /* drift check failure shouldn't block attach */ }
    void performAttach(id)
  }, [performAttach])

  const handleOpenInDir = useCallback(async () => {
    try {
      machine.forceState('dance', 15000)
      const result = await window.api.invoke('session:create-in-dir', lastTool) as any
      if (!result) { machine.forceState('idle'); return }
      if (result.type === 'pick') {
        setDirPick({ ...result, defaultTool: lastTool } as DirPickState)
      }
    } catch (err) {
      console.error('[kitty] open in dir failed:', err)
      machine.forceState('sad', 1500); say('打开失败了喵...')
    }
  }, [machine, loadSessions, say, lastTool])

  const handleDirConfirm = useCallback(async (action: import('./SessionPicker').PickAction) => {
    if (!dirPick) return
    try {
      machine.forceState('dance', 15000)
      say('准备中喵~')
      // create-in-dir-confirm signature: (tool, dir, resumeId?) where resumeId
      // is the on-disk uuid for `resume`, '__new__' for fresh, undefined for `continue --last`.
      const resumeArg =
        action.type === 'new' ? '__new__'
        : action.type === 'continue-latest' ? undefined
        : action.id
      await window.api.invoke('session:create-in-dir-confirm', action.tool, dirPick.dir, resumeArg)
      // Remember the chosen tool so subsequent actions default to it.
      if (action.tool === 'claude' || action.tool === 'codex' || action.tool === 'opencode') setLastTool(action.tool)
      machine.forceState('happy', 2000)
      say(action.type === 'resume' ? '继续之前的对话喵~' : '开始新对话喵~')
      await loadSessions()
    } catch (err) {
      console.error('[kitty] dir confirm failed:', err)
      machine.forceState('sad', 1500); say('出错了喵...')
    }
    setDirPick(null)
  }, [dirPick, machine, loadSessions, say, setLastTool])

  const menuItems = useMemo(() => [
    { label: '💬 新对话', onClick: () => setShowInput(true) },
    { label: '📂 在目录中开始', onClick: handleOpenInDir },
    { label: '📁 新建分组', onClick: () => setGroupPrompt(true) },
    { separator: true as const },
    { label: '♻️ 重启全部', onClick: async () => {
      try {
        machine.forceState('dance', 8000)
        say('全部重启中喵~')
        const result: any = await window.api.invoke('session:restart-all')
        machine.forceState('happy', 2000)
        say(`重启了 ${result?.ok ?? 0} 个会话喵~`)
      } catch (err: any) {
        machine.forceState('sad', 1500)
        say(err?.message || '重启失败喵...')
      }
    }},
    { separator: true as const },
    { label: '⚙️ 设置', onClick: () => setShowSettings(true) },
  ], [handleOpenInDir, loadSessions, machine, say])


  // When popup is open, disable click-through so popup is interactive
  useEffect(() => {
    if (anyPopup) {
      window.api.invoke('set-ignore-mouse', false)
    } else {
      window.api.invoke('set-ignore-mouse', true)
    }
  }, [anyPopup])

  // SessionDeck dispatches these custom events when a card is being dragged so
  // we can lock the window into interactive mode (set-ignore-mouse false) for
  // the full drag duration — otherwise transparent-area mousemove would flip
  // ignore-mouse back to true and the drag would be broken mid-way.
  const isDraggingBubble = useRef(false)
  useEffect(() => {
    const onStart = () => {
      isDraggingBubble.current = true
      window.api.invoke('set-ignore-mouse', false)
    }
    const onEnd = () => {
      isDraggingBubble.current = false
      if (!anyPopup) window.api.invoke('set-ignore-mouse', true)
    }
    window.addEventListener('kitty-drag-start', onStart)
    window.addEventListener('kitty-drag-end', onEnd)
    return () => {
      window.removeEventListener('kitty-drag-start', onStart)
      window.removeEventListener('kitty-drag-end', onEnd)
    }
  }, [anyPopup])

  // Dynamically toggle click-through: transparent area = pass through, pet/UI = capture
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (anyPopup || isDraggingBubble.current) return
    window.api.invoke('set-ignore-mouse', e.target === e.currentTarget)
  }, [anyPopup])

  const handleMouseLeave = useCallback(() => {
    if (!anyPopup && !isDraggingBubble.current) {
      window.api.invoke('set-ignore-mouse', true)
    }
  }, [anyPopup])

  // Opening Deck replaces the cat under the cursor with transparent space after
  // the native window grows. Reset capture after that render as well, so a late
  // mousemove from the old cat layout cannot leave the full 720px window blocking.
  useEffect(() => {
    if (deckOpen && !anyPopup && !isDraggingBubble.current) {
      window.api.invoke('set-ignore-mouse', true)
    }
  }, [anyPopup, deckOpen])

  const openDeck = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation()
    if (isDragging.current || deckOpen || deckClosing) return
    const result = await window.api.invoke('pet:set-deck-open', true) as { edge?: string }
    setDeckEdge(result?.edge === 'left' ? 'left' : 'right')
    setDeckOpen(true)
  }, [deckClosing, deckOpen])

  const closeDeck = useCallback(() => {
    if (!deckOpen || deckClosing) return
    setDeckClosing(true)
    deckCloseTimer.current = setTimeout(async () => {
      // 先让主进程瞬时收回窗口，再挂载猫，避免猫在宽窗口里横跳一帧。
      await window.api.invoke('pet:set-deck-open', false)
      setDeckOpen(false)
      setDeckClosing(false)
      deckCloseTimer.current = null
    }, 150)
  }, [deckClosing, deckOpen])



  return (
    <>
    {/* Ntfy notifications — fixed top */}
    {ntfyMessages.length > 0 && (
      <div
        onMouseEnter={() => window.api.invoke('set-ignore-mouse', false)}
        onMouseLeave={() => { if (!anyPopup) window.api.invoke('set-ignore-mouse', true) }}
        style={{
          position: 'fixed', top: 6, right: 6, zIndex: 300,
          display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end',
          pointerEvents: 'auto',
          /* container doesn't animate — each card does */
        }}>
        {ntfyMessages.map((n, i) => {
          // Dismiss: bottom-up order (last item = index count-1 flies first)
          const total = ntfyMessages.length
          const dismissDelay = (total - 1 - i) * 0.08
          return (
            <div key={n.id}
              onClick={() => { if (n.url) window.api.invoke('open-external', n.url) }}
              style={{
                padding: '6px 10px 6px 12px', borderRadius: 10,
                background: '#0d0d1fee', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
                color: '#e5e3ff', fontSize: 12, lineHeight: 1.4,
                fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
                cursor: n.url ? 'pointer' : 'default',
                boxShadow: `0 4px 16px rgba(0,0,0,0.5)`,
                borderLeft: `3px solid ${n.color}`,
                maxWidth: 260,
                transition: 'transform 0.3s cubic-bezier(0.16,1,0.3,1), gap 0.3s ease',
                animation: ntfyDismissing
                  ? `ntfyFlyOut 0.2s cubic-bezier(0.55,0,1,0.45) ${dismissDelay}s forwards`
                  : `ntfySlideIn 0.4s cubic-bezier(0.34,1.56,0.64,1) ${i * 0.06}s both`,
              }}>
              <div style={{ fontSize: 10, color: '#aaa8c3', marginBottom: 2 }}>{n.time}</div>
              <div style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{n.text}</div>
            </div>
          )
        })}
        <button onClick={dismissNtfy} style={{
          background: '#23233f99', border: `1px solid #46465c44`, borderRadius: 8,
          color: '#aaa8c3', fontSize: 10, cursor: 'pointer',
          fontFamily: 'inherit', padding: '3px 10px',
          transition: 'all 0.2s',
          opacity: ntfyDismissing ? 0 : 1,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = '#23233fff')}
        onMouseLeave={(e) => (e.currentTarget.style.background = '#23233f99')}
        >清除</button>
        <style>{`
          @keyframes ntfySlideIn {
            0% { opacity: 0; transform: translateX(60px) scale(0.9); }
            70% { opacity: 1; transform: translateX(-4px) scale(1.01); }
            100% { opacity: 1; transform: translateX(0) scale(1); }
          }
          @keyframes ntfyFlyOut {
            0% { opacity: 1; transform: translateX(0); }
            100% { opacity: 0; transform: translateX(60px) scale(0.95); }
          }
        `}</style>
      </div>
    )}

    {/* Floating popups — outside pet area */}
    {showInput && <DraggablePopup><InputPopup defaultTool={lastTool} onSubmit={handleCreateSession} onClose={() => setShowInput(false)} /></DraggablePopup>}
    {showSettings && <DraggablePopup><SettingsPanel onClose={() => setShowSettings(false)} /></DraggablePopup>}
    {dirPick && (
      <DraggablePopup>
        <SessionPicker
          dir={dirPick.dir}
          defaultTool={dirPick.defaultTool}
          sessions={dirPick.sessions}
          onPick={handleDirConfirm}
          onClose={() => setDirPick(null)}
        />
      </DraggablePopup>
    )}
    {/* Skills panel opens in a separate window */}
    {envEditor && (
      <DraggablePopup>
        <EnvEditor
          sessionId={envEditor}
          sessionTitle={sessions.find(s => s.id === envEditor)?.title || ''}
          onClose={() => setEnvEditor(null)}
          onSaved={() => { machine.forceState('happy', 1500); say('会话设置已保存喵~') }}
        />
      </DraggablePopup>
    )}
    {groupPrompt && (
      <DraggablePopup>
        <GroupNamePrompt
          onSubmit={async (name) => {
            await window.api.invoke('group:create', name)
            await loadSessions()
            setGroupPrompt(false)
            machine.forceState('happy', 1500)
            say('新分组已创建喵~')
          }}
          onClose={() => setGroupPrompt(false)}
        />
      </DraggablePopup>
    )}
    {driftPrompt && (
      <DraggablePopup>
        <SessionDriftPrompt
          sessionTitle={sessions.find(s => s.id === driftPrompt.sessionId)?.title || ''}
          isRunning={(sessions.find(s => s.id === driftPrompt.sessionId)?.status === 'running')}
          drift={driftPrompt.drift}
          onKeepCurrent={() => {
            const { sessionId, kind } = driftPrompt
            setDriftPrompt(null)
            if (kind === 'restart') void doRestart(sessionId)
            else void performAttach(sessionId)
          }}
          onUseLatest={async () => {
            const { sessionId, drift, kind } = driftPrompt
            const isRunning = sessions.find(s => s.id === sessionId)?.status === 'running'
            setDriftPrompt(null)
            try {
              const { rebindExternal } = await import('../lib/ipc')
              // attach + running: soft rebind (DB only, keep pane running its current jsonl)
              // attach + detached, or restart: keep tmux so restart-agent can respawn-pane
              // into a launch script that uses the new externalSessionId.
              const keepTmux = kind === 'restart' ? true : isRunning
              await rebindExternal(sessionId, drift.latestId, keepTmux)
              await loadSessions()
              if (kind === 'attach') say(isRunning ? '记录已对齐喵~' : '已切到新对话喵~')
            } catch (err) {
              console.error('[kitty] rebind failed:', err)
              say('切换失败了喵...')
              return
            }
            if (kind === 'restart') void doRestart(sessionId)
            else void performAttach(sessionId)
          }}
          onClose={() => setDriftPrompt(null)}
        />
      </DraggablePopup>
    )}

    {/* Pet area — cat, tagcloud, context menu */}
    <div
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', userSelect: 'none', position: 'relative' }}
      onMouseDown={handleMouseDown} onClick={handleClick} onContextMenu={handleContextMenu}
      onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave}
    >
      {deckOpen && <SessionDeck
        sessions={sessions}
        edge={deckEdge}
        closing={deckClosing}
        onClose={closeDeck}
        onCreateDirect={() => setShowInput(true)}
        onCreateInDirectory={handleOpenInDir}
        onAttach={handleAttach}
        onKill={killSession}
        onRename={renameSession}
        onRestart={async (id) => {
          try {
            const { checkSessionDrift } = await import('../lib/ipc')
            const drift = await checkSessionDrift(id)
            if (drift) {
              setDriftPrompt({ sessionId: id, drift, kind: 'restart' })
              return
            }
          } catch { /* drift failure shouldn't block restart */ }
          void doRestart(id)
        }}
        onClearConversation={async (id) => {
          try {
            const { clearConversation } = await import('../lib/ipc')
            const res = await clearConversation(id)
            say(res?.message || (res?.success ? '已清空' : '清空失败'), 4000)
            if (res?.success) machine.forceState('happy', 1500)
            else machine.forceState('sad', 1500)
            await loadSessions()
          } catch (err: any) {
            say(err?.message || '清空失败', 4000)
            machine.forceState('sad', 1500)
          }
        }}
        onEditEnv={(id) => setEnvEditor(id)}
        onOpenSkills={(id) => window.api.invoke('popup-open', 'skills', id)}
      />}
      {!deckOpen && <div
        style={{
          position: 'relative', flexShrink: 0, width: 128, height: 128,
          pointerEvents: 'auto', cursor: 'pointer',
          display: 'block',
        }}
        onClick={openDeck}
        title="打开会话边栏"
      >
        {speech && <SpeechBubble text={speech} onDone={() => setSpeech(null)} />}
        <PetSprite state={animation} skin={bubble.skin} size={128} />
      </div>}
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)} items={menuItems} />
      )}
    </div>
    </>
  )
}

// ─── Shared popup colors ─────────────────────────────

const skinC = {
  variant: '#23233f', container: '#17172f',
  text: '#e5e3ff', textDim: '#aaa8c3',
  primaryDim: '#645efb', outline: '#46465c',
}

// ─── Env Editor ──────────────────

function EnvEditor({ sessionId, sessionTitle, onClose, onSaved }: {
  sessionId: string; sessionTitle: string; onClose: () => void; onSaved: () => void
}) {
  const [text, setText] = useState('')
  const [argsClaudeText, setArgsClaudeText] = useState('')
  const [argsCodexText, setArgsCodexText] = useState('')
  const [argsOpenCodeText, setArgsOpenCodeText] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    Promise.all([
      window.api.invoke('session:get-env', sessionId),
      window.api.invoke('session:get-launch-args', sessionId),
    ]).then(([env, args]: any[]) => {
      const lines = env && typeof env === 'object'
        ? Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')
        : ''
      setText(lines)
      setArgsClaudeText(typeof args?.claude === 'string' ? args.claude : '')
      setArgsCodexText(typeof args?.codex === 'string' ? args.codex : '')
      setArgsOpenCodeText(typeof args?.opencode === 'string' ? args.opencode : '')
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [sessionId])

  const save = async () => {
    setSaving(true)
    try {
      const env: Record<string, string> = {}
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq < 1) continue
        const k = trimmed.slice(0, eq).trim()
        const v = trimmed.slice(eq + 1).trim()
        if (k) env[k] = v
      }
      await Promise.all([
        window.api.invoke('session:set-env', sessionId, env),
        window.api.invoke('session:set-launch-args', sessionId, { claude: argsClaudeText.trim(), codex: argsCodexText.trim(), opencode: argsOpenCodeText.trim() }),
      ])
      onSaved()
      onClose()
    } catch (e) {
      console.error('save session config failed:', e)
    }
    setSaving(false)
  }

  return (
    <div style={{
      background: `${skinC.variant}f5`, backdropFilter: 'blur(32px)', WebkitBackdropFilter: 'blur(32px)',
      borderRadius: 16, padding: 14, width: 340,
      boxShadow: `0 12px 48px rgba(0,0,0,0.6), inset 0 1px 0 ${skinC.outline}20`,
      fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", color: skinC.text,
    }}>
      <div data-drag-handle style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, cursor: 'grab' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>⚙️ 会话设置 · {sessionTitle}</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: skinC.textDim, cursor: 'pointer', fontSize: 16 }}>✕</button>
      </div>
      <div style={{ fontSize: 11, color: skinC.text, fontWeight: 600, marginBottom: 4 }}>🌱 环境变量</div>
      <textarea
        value={loading ? '加载中...' : text}
        onChange={(e) => setText(e.target.value)}
        placeholder="KEY=value&#10;ANOTHER=value"
        disabled={loading}
        style={{
          width: '100%', boxSizing: 'border-box', minHeight: 110,
          padding: '8px 10px', borderRadius: 8,
          border: `1px solid ${skinC.outline}55`,
          background: `${skinC.container}aa`,
          color: skinC.text, fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          outline: 'none', resize: 'vertical',
        }}
      />
      <div style={{ fontSize: 10, color: skinC.textDim, marginTop: 4 }}>
        每行一个 KEY=VALUE
      </div>
      <div style={{ fontSize: 11, color: skinC.text, fontWeight: 600, margin: '12px 0 4px' }}>🚀 启动参数（claude）</div>
      <input
        value={loading ? '加载中...' : argsClaudeText}
        onChange={(e) => setArgsClaudeText(e.target.value)}
        placeholder="--model opus  --dangerously-skip-permissions"
        disabled={loading}
        style={{
          width: '100%', boxSizing: 'border-box',
          padding: '8px 10px', borderRadius: 8,
          border: `1px solid ${skinC.outline}55`,
          background: `${skinC.container}aa`,
          color: skinC.text, fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          outline: 'none',
        }}
      />
      <div style={{ fontSize: 11, color: skinC.text, fontWeight: 600, margin: '10px 0 4px' }}>🚀 启动参数（codex）</div>
      <input
        value={loading ? '加载中...' : argsCodexText}
        onChange={(e) => setArgsCodexText(e.target.value)}
        placeholder="-c model_reasoning_effort=high"
        disabled={loading}
        style={{
          width: '100%', boxSizing: 'border-box',
          padding: '8px 10px', borderRadius: 8,
          border: `1px solid ${skinC.outline}55`,
          background: `${skinC.container}aa`,
          color: skinC.text, fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          outline: 'none',
        }}
      />
      <div style={{ fontSize: 11, color: skinC.text, fontWeight: 600, margin: '10px 0 4px' }}>🚀 启动参数（opencode）</div>
      <input
        value={loading ? '加载中...' : argsOpenCodeText}
        onChange={(e) => setArgsOpenCodeText(e.target.value)}
        placeholder="--model provider/model --agent build"
        disabled={loading}
        style={{
          width: '100%', boxSizing: 'border-box',
          padding: '8px 10px', borderRadius: 8,
          border: `1px solid ${skinC.outline}55`,
          background: `${skinC.container}aa`,
          color: skinC.text, fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          outline: 'none',
        }}
      />
      <div style={{ fontSize: 10, color: skinC.textDim, marginTop: 4 }}>
        按会话当前工具生效，追加在全局 toolArgs 之后。均需<b>重启会话</b>后生效
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 10 }}>
        <button onClick={onClose} style={{
          padding: '5px 12px', borderRadius: 8, background: `${skinC.container}aa`,
          border: `1px solid ${skinC.outline}33`, color: skinC.textDim, fontSize: 11,
          cursor: 'pointer', fontFamily: 'inherit',
        }}>取消</button>
        <button onClick={save} disabled={saving || loading} style={{
          padding: '5px 12px', borderRadius: 8,
          background: skinC.primaryDim, border: 'none',
          color: '#fff', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
          opacity: saving || loading ? 0.5 : 1,
        }}>{saving ? '保存中...' : '保存'}</button>
      </div>
    </div>
  )
}

// ─── Group Name Prompt ──────────────────

function GroupNamePrompt({ onSubmit, onClose }: { onSubmit: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 100)
    return () => clearTimeout(t)
  }, [])
  const submit = () => {
    const v = name.trim()
    if (v) onSubmit(v)
  }
  const C = { surface: '#0c0c1f', container: '#17172f', variant: '#23233f', primary: '#a7a5ff', primaryDim: '#645efb', text: '#e5e3ff', textDim: '#aaa8c3', outline: '#46465c' }
  return (
    <div style={{
      background: `${C.variant}99`,
      backdropFilter: 'blur(32px)',
      WebkitBackdropFilter: 'blur(32px)',
      borderRadius: 16,
      padding: 10,
      width: 260,
      boxShadow: `0 10px 40px rgba(0,0,0,0.5), inset 0 1px 0 ${C.outline}26`,
      fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif"
    }}>
      <div data-drag-handle style={{ height: 4, cursor: 'grab' }} />
      <div style={{ fontSize: 11, color: C.textDim, padding: '2px 4px 6px' }}>📁 新建分组</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onClose()
          }}
          placeholder="分组名称..."
          style={{
            flex: 1,
            padding: '7px 12px',
            borderRadius: 9999,
            border: `1px solid ${C.outline}33`,
            background: `${C.container}cc`,
            color: C.text,
            fontSize: 12,
            outline: 'none',
            fontFamily: 'inherit'
          }}
        />
        <button
          onClick={submit}
          style={{
            padding: '7px 16px',
            borderRadius: 9999,
            border: 'none',
            background: `linear-gradient(135deg, ${C.primary}, ${C.primaryDim})`,
            color: C.surface,
            fontSize: 12,
            cursor: 'pointer',
            fontWeight: 600
          }}
        >
          ▶
        </button>
      </div>
      <div style={{ marginTop: 6, fontSize: 9, color: C.textDim, textAlign: 'center', opacity: 0.6 }}>
        Enter 创建 · Esc 取消
      </div>
    </div>
  )
}

// ─── Session Drift Prompt ──────────────────

function SessionDriftPrompt({
  sessionTitle,
  isRunning,
  drift,
  onKeepCurrent,
  onUseLatest,
  onClose,
}: {
  sessionTitle: string
  isRunning: boolean
  drift: import('../lib/ipc').SessionDrift
  onKeepCurrent: () => void
  onUseLatest: () => void
  onClose: () => void
}) {
  const C = { surface: '#0c0c1f', container: '#17172f', variant: '#23233f', primary: '#a7a5ff', primaryDim: '#645efb', text: '#e5e3ff', textDim: '#aaa8c3', outline: '#46465c' }
  const currentLabel = drift.currentId ? drift.currentId.slice(0, 8) : '(无)'
  return (
    <div style={{
      background: `${C.variant}f5`,
      backdropFilter: 'blur(32px)',
      WebkitBackdropFilter: 'blur(32px)',
      borderRadius: 16,
      padding: 14,
      width: 320,
      boxShadow: `0 12px 48px rgba(0,0,0,0.6), inset 0 1px 0 ${C.outline}26`,
      fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
      color: C.text,
    }}>
      <div data-drag-handle style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, cursor: 'grab' }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>⚠️ 检测到新对话</div>
          <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>{sessionTitle}</div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textDim, cursor: 'pointer', fontSize: 14 }}>✕</button>
      </div>

      <div style={{ fontSize: 11, color: C.textDim, marginBottom: 8, lineHeight: 1.5 }}>
        该目录下检测到比当前更新的对话。
        {isRunning && <span style={{ color: C.primary }}>{' '}（仅更新记录，不重启 pane）</span>}
      </div>

      <div style={{
        background: `${C.container}cc`,
        border: `1px solid ${C.outline}33`,
        borderRadius: 10,
        padding: '8px 10px',
        marginBottom: 8,
      }}>
        <div style={{ fontSize: 10, color: C.textDim, marginBottom: 2 }}>当前绑定</div>
        <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {drift.currentSummary ? `📌 ${drift.currentSummary}` : <span style={{ color: C.textDim }}>📌 {currentLabel}（无预览，可能文件已被删/移动）</span>}
        </div>
        <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>{drift.currentDate || '—'} · {currentLabel}</div>
      </div>

      <div style={{
        background: `${C.container}cc`,
        border: `1px solid ${C.outline}33`,
        borderRadius: 10,
        padding: '8px 10px',
        marginBottom: 10,
      }}>
        <div style={{ fontSize: 10, color: C.textDim, marginBottom: 2 }}>最新对话</div>
        <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          🔄 {drift.latestSummary}
        </div>
        <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>{drift.latestDate} · {drift.latestId.slice(0, 8)}</div>
        {drift.latestCwd && (
          <div style={{ fontSize: 10, marginTop: 4, color: drift.latestCwdMatch === false ? '#f59e0b' : C.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {drift.latestCwdMatch === false ? '⚠ 不同目录: ' : '目录: '}
            <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{drift.latestCwd}</span>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={onKeepCurrent}
          style={{
            flex: 1, padding: '8px 12px', borderRadius: 10,
            background: `${C.container}cc`, border: `1px solid ${C.outline}44`,
            color: C.text, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          继续当前
        </button>
        <button
          onClick={onUseLatest}
          style={{
            flex: 1, padding: '8px 12px', borderRadius: 10,
            background: `linear-gradient(135deg, ${C.primary}, ${C.primaryDim})`,
            border: 'none', color: C.surface, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          切到最新
        </button>
      </div>
    </div>
  )
}

// ─── Draggable Popup ──────────────────

function DraggablePopup({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const dragOff = useRef({ x: 0, y: 0 })
  const onDragStart = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (!target.closest('[data-drag-handle]')) return
    e.preventDefault()
    const el = ref.current; if (!el) return
    const rect = el.getBoundingClientRect()
    dragOff.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const onMove = (ev: MouseEvent) => {
      if (!ref.current) return
      const elRect = ref.current.getBoundingClientRect()
      let newX = ev.clientX - dragOff.current.x
      let newY = ev.clientY - dragOff.current.y
      newX = Math.max(0, Math.min(newX, window.innerWidth - elRect.width))
      newY = Math.max(0, Math.min(newY, window.innerHeight - elRect.height))
      ref.current.style.left = `${newX}px`
      ref.current.style.top = `${newY}px`
      ref.current.style.transform = 'none'
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
  }
  return (
    <div ref={ref}
      style={{ position: 'fixed', top: 8, left: 8, right: 8, zIndex: 200, maxHeight: 'calc(100vh - 16px)', overflow: 'auto' }}
      onClick={(e) => e.stopPropagation()} onMouseDown={(e) => { e.stopPropagation(); onDragStart(e) }}>
      {children}
    </div>
  )
}
