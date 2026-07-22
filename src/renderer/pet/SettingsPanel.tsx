import { useState, useEffect, useRef } from 'react'
import { useConfigStore } from '../store/config-store'
import {
  ACCENT_PRESETS,
  T,
  btnClose,
  btnGhost,
  divider,
  inputWell,
  popover,
  popupHeader,
  statusDot,
} from './ui-tokens'

interface Props {
  onClose: () => void
}

interface ArchivedGroup {
  id: string
  name: string
  color: string | null
  sessionCount: number
}

type ConfigurableTool = 'claude' | 'codex' | 'opencode'
const CONFIGURABLE_TOOLS: Array<{ id: ConfigurableTool; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
]

export default function SettingsPanel({ onClose }: Props) {
  const { bubble, setBubble, resetBubble } = useConfigStore()
  const [ntfyTopic, setNtfyTopic] = useState('')
  const [codexHiveBridge, setCodexHiveBridgeState] = useState(false)
  const [toolCommands, setToolCommands] = useState<Record<ConfigurableTool, string>>({
    claude: 'claude', codex: 'codex', opencode: 'opencode',
  })
  const [toolCommandError, setToolCommandError] = useState('')
  const [archivedGroups, setArchivedGroups] = useState<ArchivedGroup[]>([])
  const ntfyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadArchived = () => {
    window.api.invoke('group:list-archived').then((g: any) => setArchivedGroups(g || [])).catch(() => {})
  }

  useEffect(() => {
    window.api.invoke('ntfy:topic:get').then((t: any) => setNtfyTopic(t || '')).catch(() => {})
    window.api.invoke('config:codex-hive-bridge:get').then((v: any) => setCodexHiveBridgeState(!!v)).catch(() => {})
    window.api.invoke('config:tool-commands:get').then((commands: any) => {
      if (!commands || typeof commands !== 'object') return
      setToolCommands({
        claude: String(commands.claude || 'claude'),
        codex: String(commands.codex || 'codex'),
        opencode: String(commands.opencode || 'opencode'),
      })
    }).catch(() => {})
    loadArchived()
  }, [])

  const handleUnarchive = async (id: string) => {
    try {
      await window.api.invoke('group:unarchive', id)
      loadArchived()
    } catch (e) {
      console.error('unarchive failed:', e)
    }
  }

  const saveToolCommand = async (tool: ConfigurableTool) => {
    try {
      const result: any = await window.api.invoke('config:tool-command:set', tool, toolCommands[tool])
      setToolCommands((current) => ({ ...current, [tool]: String(result?.command || tool) }))
      setToolCommandError('')
    } catch (error: any) {
      setToolCommandError(error?.message || '命令保存失败')
    }
  }

  return (
    <div style={{ ...popover({ alpha: 'f5', radius: 16 }), padding: 16, width: 260 }}>
      <div data-drag-handle style={{ ...popupHeader(), marginBottom: 14 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>⚙️ 设置</span>
        <button onClick={onClose} style={btnClose()}>✕</button>
      </div>

      {/* Ntfy notification */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: T.text, marginBottom: 4 }}>通知</div>
        <input
          type="text"
          placeholder="ntfy topic"
          value={ntfyTopic}
          onChange={(e) => {
            const v = e.target.value
            setNtfyTopic(v)
            if (ntfyTimer.current) clearTimeout(ntfyTimer.current)
            ntfyTimer.current = setTimeout(() => {
              window.api.invoke('ntfy:topic:set', v.trim())
            }, 1000)
          }}
          style={{ ...inputWell(), padding: '6px 10px' }}
        />
        <div style={{ fontSize: 10, color: T.faint, marginTop: 3 }}>
          ntfy.sh 推送主题，留空关闭
        </div>
      </div>

      {/* Codex hive bridge (path B) */}
      <div style={{ marginBottom: 14 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={codexHiveBridge}
            onChange={(e) => {
              const v = e.target.checked
              setCodexHiveBridgeState(v)
              window.api.invoke('config:codex-hive-bridge:set', v).catch(() => {})
            }}
            style={{ accentColor: T.accent }}
          />
          <span style={{ fontSize: 12, color: T.text }}>Codex 走 hive 联动</span>
          <span style={{ fontSize: 9, color: T.warning, border: `1px solid ${T.warning}55`, borderRadius: 4, padding: '0 4px' }}>实验</span>
        </label>
        <div style={{ fontSize: 10, color: T.faint, marginTop: 3, marginLeft: 22 }}>
          Codex 新建会话用 <code>{toolCommands.codex} --remote</code> 接到 kitty-hive 的 daemon，可接收 hive 推送
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: T.text, marginBottom: 6 }}>工具可执行命令</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {CONFIGURABLE_TOOLS.map(({ id, label }) => (
            <label key={id} style={{ display: 'grid', gridTemplateColumns: '68px 1fr', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 10, color: T.faint }}>{label}</span>
              <input
                value={toolCommands[id]}
                onChange={(event) => setToolCommands((current) => ({ ...current, [id]: event.target.value }))}
                onBlur={() => { void saveToolCommand(id) }}
                onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
                spellCheck={false}
                aria-label={`${label} 可执行命令`}
                style={{ ...inputWell({ mono: true }), padding: '5px 8px', fontSize: 10.5 }}
              />
            </label>
          ))}
        </div>
        <div style={{ fontSize: 10, color: toolCommandError ? T.danger : T.faint, marginTop: 4 }}>
          {toolCommandError || '新建或重启会话后生效；Hive 中仍使用原 tool id'}
        </div>
      </div>

      <div style={divider()} />
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: T.faint, marginBottom: 7, fontWeight: 500 }}>全局工具库</div>
        <button
          onClick={() => {
            onClose()
            void window.api.invoke('popup-open', 'skills', 'global')
          }}
          style={{ ...btnGhost({ radius: 10 }), width: '100%', padding: '8px 10px', color: T.text, textAlign: 'left' }}
        >
          <span style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>📦 Skills / MCP 管理</span>
          <span style={{ display: 'block', marginTop: 2, color: T.faint, fontSize: 10 }}>管理 skillsmgr 与 mcpsmgr 的全局仓库</span>
        </button>
      </div>

      {/* Archived groups */}
      {archivedGroups.length > 0 && (
        <>
          <div style={divider()} />
          <div style={{ fontSize: 11, color: T.faint, marginBottom: 8, fontWeight: 500 }}>📦 已归档 ({archivedGroups.length})</div>
          <div style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {archivedGroups.map((g) => (
              <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={statusDot(g.color || T.accent)} />
                <span style={{ flex: 1, fontSize: 12, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {g.name}
                  <span style={{ fontSize: 10, color: T.faint, marginLeft: 6 }}>{g.sessionCount} 会话</span>
                </span>
                <button onClick={() => handleUnarchive(g.id)}
                  style={{ ...btnGhost({ radius: 9999 }), padding: '2px 10px', color: T.text, fontSize: 10, flexShrink: 0 }}>
                  恢复
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <div style={divider()} />

      {/* Deck section header */}
      <div style={{ fontSize: 11, color: T.faint, marginBottom: 8, fontWeight: 500 }}>Deck</div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: T.faint, marginBottom: 7 }}>选中颜色</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="color"
            value={bubble.deckAccentColor}
            onChange={(e) => setBubble({ deckAccentColor: e.target.value })}
            aria-label="Deck 选中颜色"
            style={{ width: 32, height: 26, padding: 0, border: `1px solid ${T.border}1c`, borderRadius: 7, background: 'transparent', cursor: 'pointer' }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            {ACCENT_PRESETS.map((color) => (
              <button
                key={color}
                onClick={() => setBubble({ deckAccentColor: color })}
                aria-label={`选择 ${color}`}
                style={{
                  width: 20, height: 20, borderRadius: '50%', background: color, cursor: 'pointer',
                  border: bubble.deckAccentColor === color ? '2px solid #fff' : '1px solid rgba(255,255,255,.22)',
                  boxShadow: bubble.deckAccentColor === color ? `0 0 0 2px ${color}55` : 'none',
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <div style={{ textAlign: 'center' }}>
        <button onClick={resetBubble}
          style={{ ...btnGhost({ radius: 9999 }), padding: '4px 14px', fontSize: 11 }}>
          恢复默认
        </button>
      </div>
    </div>
  )
}
