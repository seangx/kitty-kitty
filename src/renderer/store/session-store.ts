import { create } from 'zustand'
import type { SessionInfo } from '@shared/types/session'
import * as ipc from '../lib/ipc'

interface SessionState {
  sessions: SessionInfo[]
  loading: boolean

  loadSessions: () => Promise<void>
  createSession: (tool: string, firstMessage?: string) => Promise<SessionInfo>
  createSessionInDir: (tool: string) => Promise<SessionInfo | null>
  importSessions: () => Promise<number>
  attachSession: (id: string) => Promise<boolean>
  killSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => void
  setAgentMetadata: (id: string, roles: string, expertise: string) => Promise<void>
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  loading: false,

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

  importSessions: async () => {
    const imported = await ipc.importSessions()
    if (imported.length > 0) await get().loadSessions()
    return imported.length
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
