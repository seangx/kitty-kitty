import { create } from 'zustand'
import type { SessionInfo } from '@shared/types/session'
import * as ipc from '../lib/ipc'

interface SessionState {
  sessions: SessionInfo[]
  loading: boolean

  /** Session ids currently flagged as "needs your input" (claude permission/elicitation). */
  needsInput: Set<string>
  loadNeedsInput: () => Promise<void>
  markNeedsInput: (id: string) => void
  clearNeedsInput: (id: string) => void

  loadSessions: () => Promise<void>
  createSession: (tool: string, firstMessage?: string) => Promise<SessionInfo>
  createSessionInDir: (tool: string) => Promise<SessionInfo | null>
  attachSession: (id: string) => Promise<boolean>
  killSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => void
  setAgentMetadata: (id: string, roles: string, expertise: string) => Promise<void>
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  loading: false,

  needsInput: new Set<string>(),
  loadNeedsInput: async () => {
    try {
      const ids = await window.api.invoke('session:list-needs-input') as string[]
      const next = new Set(ids)
      // Skip the state update if the membership is identical, to avoid
      // re-rendering subscribers (TagCloud) when nothing actually changed.
      const cur = get().needsInput
      if (cur.size === next.size && [...cur].every((id) => next.has(id))) return
      set({ needsInput: next })
    } catch (err) { console.error('loadNeedsInput failed:', err) }
  },
  markNeedsInput: (id) => set((s) => {
    if (s.needsInput.has(id)) return s
    const next = new Set(s.needsInput); next.add(id); return { needsInput: next }
  }),
  clearNeedsInput: (id) => set((s) => {
    if (!s.needsInput.has(id)) return s
    const next = new Set(s.needsInput); next.delete(id); return { needsInput: next }
  }),

  loadSessions: async () => {
    set({ loading: true })
    try {
      const sessions = await ipc.syncSessions()
      set({ sessions, loading: false })
    } catch (err) {
      console.error('Failed to load sessions:', err)
      set({ loading: false })
    }
  },

  createSession: async (tool: string, firstMessage?: string) => {
    const session = await ipc.createSession(tool, firstMessage)
    await get().loadSessions()
    return session
  },

  createSessionInDir: async (tool: string) => {
    const session = await ipc.createSessionInDir(tool)
    if (session) await get().loadSessions()
    return session
  },

  attachSession: async (id: string) => {
    const alive = await ipc.attachSession(id)
    if (!alive) await get().loadSessions()
    return alive
  },

  killSession: async (id: string) => {
    await ipc.killSession(id)
    await get().loadSessions()
  },

  renameSession: (id: string, title: string) => {
    // Optimistic update
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, title } : s
      )
    }))
    // Persist to DB
    window.api.invoke('session:rename', id, title).catch(console.error)
  },

  setAgentMetadata: async (id, roles, expertise) => {
    // Optimistic update
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, roles, expertise } : s
      )
    }))
    await ipc.setAgentMetadata(id, roles, expertise)
    // Re-sync to get authoritative state
    await get().loadSessions()
  }
}))
