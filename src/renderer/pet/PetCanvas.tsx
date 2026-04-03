import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PetSprite from './PetSprite'
import TagCloud from './TagCloud'
import InputPopup from './InputPopup'
import ContextMenu from './ContextMenu'
import SettingsPanel from './SettingsPanel'
import SessionPicker from './SessionPicker'
import SpeechBubble from './SpeechBubble'
import SkillsPanel from './SkillsPanel'
import { PetStateMachine } from './animations/state-machine'
import { BehaviorScheduler } from './animations/behaviors'
import { SKINS } from './animations/sprite-data'
import type { AnimationState, SkinId } from '@shared/types/pet'
import { IPC } from '@shared/types/ipc'
import { useSessionStore } from '../store/session-store'
import { useConfigStore } from '../store/config-store'

interface DirPickResult {
  type: 'pick'
  dir: string
  sessions: Array<{ id: string; summary: string; date: string }>
  isGitRepo: boolean
  discoveredWorktrees?: Array<{ branch: string; path: string; isTracked: boolean }>
}

export default function PetCanvas() {
  const [animation, setAnimation] = useState<AnimationState>('idle')
  const [showInput, setShowInput] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [dirPick, setDirPick] = useState<DirPickResult | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [speech, setSpeech] = useState<string | null>(null)
  const [showSkinPicker, setShowSkinPicker] = useState(false)
  const [skillsSessionId, setSkillsSessionId] = useState<string | null>(null)
  const isDragging = useRef(false)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragOffset = useRef({ x: 0, y: 0 })

  const { sessions, loadSessions, createSession, importSessions, attachSession, killSession, renameSession, createWorktreePane, removeWorktreePane } = useSessionStore()
  const { bubble, setBubble } = useConfigStore()

  const machine = useMemo(() => new PetStateMachine(setAnimation), [])
  const scheduler = useMemo(() => new BehaviorScheduler(machine), [machine])

  const sayTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const say = useCallback((text: string, duration = 3000) => {
    if (sayTimer.current) clearTimeout(sayTimer.current)
    setSpeech(text)
    sayTimer.current = setTimeout(() => setSpeech(null), duration)
  }, [])

  const closeAll = useCallback(() => {
    setShowInput(false)
    setShowSettings(false)
    setShowSkinPicker(false)
    setSkillsSessionId(null)
    setDirPick(null)
    setContextMenu(null)
  }, [])

  useEffect(() => {
    scheduler.start()
    loadSessions()
    const poll = setInterval(() => loadSessions(), 10000)
    const unsub = window.api.on('window-blur', closeAll)
    return () => { scheduler.stop(); machine.destroy(); clearInterval(poll); unsub() }
  }, [scheduler, machine, loadSessions, closeAll])

  useEffect(() => {
    const unsubAdvice = window.api.on('worktree:advice', (_event: any, advice: any) => {
      let message = ''
      switch (advice.type) {
        case 'suggest-cleanup':
          message = `${advice.branch} 已合并，要清理吗？`; break
        case 'warn-conflict':
          message = `${advice.branches.join(' 和 ')} 修改了相同文件`; break
        case 'warn-stale':
          message = `${advice.branch} 已 ${advice.staleDays} 天没有提交`; break
        case 'suggest-rebase':
          message = `${advice.branch} 落后 ${advice.behind} 个提交`; break
      }
      if (message) say(message, 5000)
    })
    return () => { unsubAdvice() }
  }, [say])

  // Real-time collab message display
  useEffect(() => {
    const unsub = window.api.on(IPC.COLLAB_MESSAGE, (_event: any, msg: any) => {
      const preview = msg.message.length > 60
        ? msg.message.slice(0, 57) + '...'
        : msg.message
      say(`💬 ${msg.from}: ${preview}`, 5000)
    })
    return () => { unsub() }
  }, [say])

  const anyPopup = showInput || showSettings || showSkinPicker || !!dirPick || !!skillsSessionId

  const clickAnimations: AnimationState[] = ['happy', 'dance', 'jump', 'roll', 'stretch', 'lick', 'sneak']
  const clickIndex = useRef(0)

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (isDragging.current || anyPopup) return
    e.stopPropagation()
    if (clickTimer.current) {
      clearTimeout(clickTimer.current); clickTimer.current = null
      setShowInput(true)
    } else {
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null
        const anim = clickAnimations[clickIndex.current % clickAnimations.length]
        clickIndex.current++
        machine.forceState(anim, 2000)
      }, 250)
    }
  }, [machine, anyPopup])

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
        isDragging.current = true
        if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null }
        window.api.invoke('move-window', dx, dy)
        dragOffset.current = { x: ev.screenX, y: ev.screenY }
      }
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp)
      setTimeout(() => { isDragging.current = false }, 150)
    }
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
  }, [anyPopup])

  const handleCreateSession = useCallback(async (message: string, tool: string) => {
    try {
      machine.forceState('dance', 15000)
      say('启动中喵~')
      await createSession(tool, message)
      machine.forceState('happy', 2000)
      say('开始新对话喵~')
    } catch { machine.forceState('sad', 2000); say('出错了喵...') }
  }, [createSession, machine, say])

  const handleAttach = useCallback(async (id: string) => {
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

  const handleOpenInDir = useCallback(async () => {
    try {
      machine.forceState('dance', 15000)
      const result = await window.api.invoke('session:create-in-dir', 'claude') as any
      if (!result) { machine.forceState('idle'); return }
      if (result.type === 'pick') {
        let discovered: any[] = []
        if (result.isGitRepo) {
          try {
            discovered = await window.api.invoke('worktree:discover', result.dir)
          } catch { /* ignore */ }
        }
        setDirPick({ ...result, discoveredWorktrees: discovered } as DirPickResult)
      } else if (result.type === 'created') {
        machine.forceState('happy', 2000)
        say('在新目录开始啦~')
        await loadSessions()
      }
    } catch {
      machine.forceState('sad', 1500); say('打开失败了喵...')
    }
  }, [machine, loadSessions, say])

  const handleDirConfirm = useCallback(async (resumeId: string | null) => {
    if (!dirPick) return
    try {
      machine.forceState('dance', 15000)
      say('准备中喵~')
      await window.api.invoke('session:create-in-dir-confirm', 'claude', dirPick.dir, resumeId || undefined)
      machine.forceState('happy', 2000)
      say(resumeId && resumeId !== '__new__' ? '继续之前的对话喵~' : '开始新对话喵~')
      await loadSessions()
    } catch {
      machine.forceState('sad', 1500); say('出错了喵...')
    }
    setDirPick(null)
  }, [dirPick, machine, loadSessions, say])

  const handleWorktree = useCallback(async (branch: string, resumeId?: string) => {
    if (!dirPick) return
    try {
      machine.forceState('dance', 15000)
      say('创建 worktree 中喵~')
      await window.api.invoke('session:create-worktree', 'claude', dirPick.dir, branch, resumeId)
      machine.forceState('happy', 2000)
      say(`🌿 worktree ${branch} 启动喵~`)
      await loadSessions()
    } catch (err: any) {
      machine.forceState('sad', 1500)
      say(err?.message || 'worktree 创建失败喵...')
    }
    setDirPick(null)
  }, [dirPick, machine, loadSessions, say])

  const menuItems = useMemo(() => [
    { label: '💬 新对话', onClick: () => setShowInput(true) },
    { label: '📂 在目录中开始', onClick: handleOpenInDir },
    { label: '📥 导入已有会话', onClick: async () => {
      const count = await importSessions()
      if (count > 0) { machine.forceState('happy', 1500); say(`导入了 ${count} 个会话喵~`) }
      else { say('没有新的会话可以导入喵') }
    }},
    { separator: true as const },
    { label: '🎨 换装', onClick: () => setShowSkinPicker(true) },
    { label: '⚙️ 气泡设置', onClick: () => setShowSettings(true) },
  ], [handleOpenInDir, importSessions, machine, say])

  const DraggablePopup = useCallback(({ children }: { children: React.ReactNode }) => {
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
        ref.current.style.left = `${ev.clientX - dragOff.current.x}px`
        ref.current.style.top = `${ev.clientY - dragOff.current.y}px`
        ref.current.style.transform = 'none'
      }
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
    }
    return (
      <div ref={ref}
        style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}
        onClick={(e) => e.stopPropagation()} onMouseDown={(e) => { e.stopPropagation(); onDragStart(e) }}>
        {children}
      </div>
    )
  }, [])

  // When a popup opens, always grab mouse (no click-through while popups are visible)
  useEffect(() => {
    if (anyPopup) {
      window.api.invoke('set-ignore-mouse', false)
    }
  }, [anyPopup])

  // Dynamically toggle click-through: transparent area = pass through, pet/UI = capture
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (anyPopup) return
    window.api.invoke('set-ignore-mouse', e.target === e.currentTarget)
  }, [anyPopup])

  const handleMouseLeave = useCallback(() => {
    if (!anyPopup) {
      window.api.invoke('set-ignore-mouse', true)
    }
  }, [anyPopup])

  return (
    <div
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', userSelect: 'none', position: 'relative' }}
      onMouseDown={handleMouseDown} onClick={handleClick} onContextMenu={handleContextMenu}
      onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave}
    >
      {showInput && <DraggablePopup><InputPopup sessions={sessions} onSubmit={handleCreateSession} onClose={() => setShowInput(false)} /></DraggablePopup>}
      {showSettings && <DraggablePopup><SettingsPanel onClose={() => setShowSettings(false)} /></DraggablePopup>}
      {dirPick && (
        <DraggablePopup>
          <SessionPicker
            dir={dirPick.dir}
            sessions={dirPick.sessions}
            isGitRepo={dirPick.isGitRepo}
            discoveredWorktrees={dirPick.discoveredWorktrees}
            onPick={handleDirConfirm}
            onWorktree={handleWorktree}
            onAttachWorktrees={async (worktrees) => {
              setDirPick(null)
            }}
            onClose={() => setDirPick(null)}
          />
        </DraggablePopup>
      )}

      <TagCloud
        sessions={sessions}
        onAttach={handleAttach}
        onKill={killSession}
        onRename={renameSession}
        onCreateWorktreePane={async (sessionId, branch) => {
          try {
            machine.forceState('dance', 15000)
            say('创建 pane 中喵~')
            await createWorktreePane(sessionId, branch)
            machine.forceState('happy', 2000)
            say(`${branch} pane 已创建喵~`)
          } catch (err: any) {
            machine.forceState('sad', 1500)
            say(err?.message || 'worktree pane 创建失败喵...')
          }
        }}
        onRemoveWorktreePane={async (paneId, keepWorktree) => {
          await removeWorktreePane(paneId, keepWorktree)
          say('pane 已关闭喵~')
        }}
        onOpenSkills={(id) => setSkillsSessionId(id)}
      />

      {/* Cat sprite + speech bubble */}
      <div style={{ position: 'relative' }}>
        {speech && <SpeechBubble text={speech} onDone={() => setSpeech(null)} />}
        <PetSprite state={animation} skin={bubble.skin} />
      </div>

      {skillsSessionId && (
        <DraggablePopup>
          <SkillsPanel
            sessionId={skillsSessionId}
            onClose={() => setSkillsSessionId(null)}
            onSay={say}
            onDance={() => machine.forceState('dance', 15000)}
          />
        </DraggablePopup>
      )}

      {showSkinPicker && (
        <DraggablePopup>
          <SkinPicker
            current={bubble.skin}
            onSelect={(id) => { setBubble({ skin: id }); setShowSkinPicker(false); machine.forceState('happy', 1500); say('换装成功喵~') }}
            onClose={() => setShowSkinPicker(false)}
          />
        </DraggablePopup>
      )}

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)} items={menuItems} />
      )}
    </div>
  )
}

// ─── Skin Picker ─────────────────────────────────────

const skinC = {
  variant: '#23233f', container: '#17172f',
  text: '#e5e3ff', textDim: '#aaa8c3',
  primaryDim: '#645efb', outline: '#46465c',
}

function SkinPicker({ current, onSelect, onClose }: { current: SkinId; onSelect: (id: SkinId) => void; onClose: () => void }) {
  const entries = Object.entries(SKINS) as [SkinId, typeof SKINS[SkinId]][]
  return (
    <div style={{
      background: `${skinC.variant}f5`, backdropFilter: 'blur(32px)', WebkitBackdropFilter: 'blur(32px)',
      borderRadius: 16, padding: 14, width: 260,
      boxShadow: `0 12px 48px rgba(0,0,0,0.6), inset 0 1px 0 ${skinC.outline}20`,
      fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", color: skinC.text,
    }}>
      <div data-drag-handle style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, cursor: 'grab' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>🎨 换装</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: skinC.textDim, cursor: 'pointer', fontSize: 16 }}>✕</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {entries.map(([id, skin]) => (
          <button
            key={id}
            onClick={() => onSelect(id)}
            style={{
              padding: '10px 4px 8px', borderRadius: 12, cursor: 'pointer', textAlign: 'center',
              border: current === id ? `2px solid ${skinC.primaryDim}` : `1px solid ${skinC.outline}33`,
              background: current === id ? `${skinC.primaryDim}22` : `${skinC.container}88`,
              color: current === id ? skinC.text : skinC.textDim,
              fontFamily: 'inherit', transition: 'all 0.15s',
            }}
          >
            <pre style={{ fontSize: 10, lineHeight: 1.2, whiteSpace: 'pre', margin: 0, minHeight: 28 }}>{skin.preview}</pre>
            <div style={{ fontSize: 11, marginTop: 6, fontWeight: current === id ? 600 : 400 }}>{skin.name}</div>
          </button>
        ))}
      </div>
    </div>
  )
}
