import { useState } from 'react'

interface ClaudeSession {
  id: string
  summary: string
  date: string
}

interface Props {
  dir: string
  sessions: ClaudeSession[]
  isGitRepo: boolean
  discoveredWorktrees?: Array<{ branch: string; path: string; isTracked: boolean }>
  onPick: (resumeId: string | null) => void
  onWorktree: (branch: string, resumeId?: string) => void
  onAttachWorktrees: (worktrees: Array<{ branch: string; path: string }>) => void
  onClose: () => void
}

const C = {
  variant: '#23233f', container: '#17172f',
  text: '#e5e3ff', textDim: '#aaa8c3',
  primaryDim: '#645efb', primary: '#a7a5ff', outline: '#46465c',
}

export default function SessionPicker({ dir, sessions: initialSessions, isGitRepo, discoveredWorktrees, onPick, onWorktree, onAttachWorktrees, onClose }: Props) {
  const dirName = dir.split('/').pop() || dir
  const [sessions, setSessions] = useState(initialSessions)
  const [worktreeMode, setWorktreeMode] = useState(false)
  const [branch, setBranch] = useState('')
  const [wtResumeId, setWtResumeId] = useState<string | undefined>(undefined)
  const [selectedWorktrees, setSelectedWorktrees] = useState<Set<string>>(new Set())

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await window.api.invoke('session:delete-claude-session', dir, id)
      setSessions((prev) => prev.filter((s) => s.id !== id))
    } catch (err) {
      console.error('Failed to delete session:', err)
    }
  }

  const handleWorktreeSubmit = () => {
    const b = branch.trim()
    if (b) onWorktree(b, wtResumeId)
  }

  return (
    <div style={{
      background: `${C.variant}f5`, backdropFilter: 'blur(32px)', WebkitBackdropFilter: 'blur(32px)',
      borderRadius: 16, padding: 14, width: 300, maxHeight: 380, overflow: 'auto',
      boxShadow: `0 12px 48px rgba(0,0,0,0.6), inset 0 1px 0 ${C.outline}20`,
      fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", color: C.text,
    }}>
      <div data-drag-handle style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, cursor: 'grab' }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>📂 {dirName}</div>
          <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>选择继续或新建</div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textDim, cursor: 'pointer', fontSize: 14 }}>✕</button>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <button
          onClick={() => onPick('__new__')}
          style={{
            flex: 1, padding: '8px 12px', borderRadius: 10,
            background: `${C.container}cc`, border: `1px solid ${C.outline}44`,
            color: C.text, fontSize: 12, fontWeight: 600,
            cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center',
          }}
        >
          🆕 新建
        </button>
        <button
          onClick={() => onPick(null)}
          style={{
            flex: 1, padding: '8px 12px', borderRadius: 10,
            background: `linear-gradient(135deg, ${C.primary}, ${C.primaryDim})`,
            border: 'none', color: '#0c0c1f', fontSize: 12, fontWeight: 600,
            cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center',
          }}
        >
          ✨ 继续最近
        </button>
      </div>

      {/* Worktree button — only for git repos */}
      {isGitRepo && !worktreeMode && (
        <button
          onClick={() => setWorktreeMode(true)}
          style={{
            width: '100%', padding: '8px 12px', borderRadius: 10, marginBottom: 6,
            background: `${C.container}cc`, border: `1px solid #10b98144`,
            color: '#10b981', fontSize: 12, fontWeight: 600,
            cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center',
            transition: 'all 0.2s',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#10b98122' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = `${C.container}cc` }}
        >
          🌿 Worktree 分支
        </button>
      )}

      {/* Worktree branch input */}
      {worktreeMode && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 10, color: '#10b981', marginBottom: 4 }}>🌿 输入分支名：</div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
            <input
              autoFocus
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleWorktreeSubmit()
                if (e.key === 'Escape') { setWorktreeMode(false); setBranch('') }
              }}
              placeholder="feature/my-branch"
              style={{
                flex: 1, padding: '6px 10px', borderRadius: 8,
                background: `${C.container}cc`, border: `1px solid #10b98144`,
                color: C.text, fontSize: 12, fontFamily: 'inherit', outline: 'none',
              }}
            />
            <button
              onClick={handleWorktreeSubmit}
              style={{
                padding: '6px 12px', borderRadius: 8,
                background: '#10b981', border: 'none',
                color: '#0c0c1f', fontSize: 12, fontWeight: 600,
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              GO
            </button>
            <button
              onClick={() => { setWorktreeMode(false); setBranch(''); setWtResumeId(undefined) }}
              style={{
                padding: '6px 8px', borderRadius: 8,
                background: 'none', border: `1px solid ${C.outline}44`,
                color: C.textDim, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              ✕
            </button>
          </div>
          {/* Session to continue in worktree */}
          <div style={{ fontSize: 10, color: C.textDim, marginBottom: 3 }}>
            继续会话：{wtResumeId ? '已选择' : '最近（默认）'}
          </div>
          {sessions.length > 0 && sessions.slice(0, 3).map((s) => (
            <button
              key={s.id}
              onClick={() => setWtResumeId(wtResumeId === s.id ? undefined : s.id)}
              style={{
                display: 'block', width: '100%', padding: '4px 8px', marginBottom: 2,
                borderRadius: 6, fontSize: 11, textAlign: 'left',
                background: wtResumeId === s.id ? '#10b98122' : 'transparent',
                border: wtResumeId === s.id ? '1px solid #10b98144' : '1px solid transparent',
                color: wtResumeId === s.id ? '#10b981' : C.textDim,
                cursor: 'pointer', fontFamily: 'inherit',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {s.summary}
            </button>
          ))}
          {/* Discovered existing worktrees */}
          {discoveredWorktrees && discoveredWorktrees.filter(w => !w.isTracked).length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 10, color: '#10b981', marginBottom: 4 }}>已有 worktree：</div>
              {discoveredWorktrees.filter(w => !w.isTracked).map((wt) => (
                <label
                  key={wt.path}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3,
                    padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
                    background: selectedWorktrees.has(wt.path) ? '#10b98118' : 'transparent',
                    border: selectedWorktrees.has(wt.path) ? '1px solid #10b98133' : '1px solid transparent',
                    fontSize: 11, color: C.text, fontFamily: 'inherit',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedWorktrees.has(wt.path)}
                    onChange={() => {
                      setSelectedWorktrees(prev => {
                        const next = new Set(prev)
                        if (next.has(wt.path)) next.delete(wt.path)
                        else next.add(wt.path)
                        return next
                      })
                    }}
                    style={{ accentColor: '#10b981' }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {wt.branch}
                  </span>
                </label>
              ))}
              {selectedWorktrees.size > 0 && (
                <button
                  onClick={() => {
                    const selected = discoveredWorktrees!.filter(w => selectedWorktrees.has(w.path))
                    onAttachWorktrees(selected)
                  }}
                  style={{
                    width: '100%', padding: '6px 12px', borderRadius: 8, marginTop: 4,
                    background: '#10b981', border: 'none',
                    color: '#0c0c1f', fontSize: 11, fontWeight: 600,
                    cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  挂载 {selectedWorktrees.size} 个 worktree 为 pane
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {sessions.length > 0 && (
        <div style={{ fontSize: 10, color: C.textDim, marginTop: 8, marginBottom: 4 }}>指定会话恢复：</div>
      )}
      {sessions.map((s) => (
        <div key={s.id} style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4,
        }}>
          <button
            onClick={() => onPick(s.id)}
            style={{
              flex: 1, padding: '8px 12px', borderRadius: 10,
              background: `${C.container}cc`, border: `1px solid ${C.outline}33`,
              color: C.text, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
              textAlign: 'left', transition: 'all 0.2s', overflow: 'hidden',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = `${C.primaryDim}66` }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = `${C.outline}33` }}
          >
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              🔄 {s.summary}
            </div>
            <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>{s.date}</div>
          </button>
          <button
            onClick={(e) => handleDelete(s.id, e)}
            title="删除此会话"
            style={{
              width: 28, height: 28, borderRadius: 8, flexShrink: 0,
              background: 'none', border: `1px solid ${C.outline}33`,
              color: '#ff6e84', fontSize: 12, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#ff6e8422' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none' }}
          >
            🗑
          </button>
        </div>
      ))}
    </div>
  )
}
