import { create } from 'zustand'
import type { PetState, AnimationState, InteractionType } from '@shared/types/pet'
import * as ipc from '../lib/ipc'

interface PetStoreState extends PetState {
  currentAnimation: AnimationState
  loading: boolean

  // Actions
  loadPetState: () => Promise<void>
  interact: (type: InteractionType) => Promise<void>
  setAnimation: (state: AnimationState) => void
}

export const usePetStore = create<PetStoreState>((set) => ({
  mood: 'neutral',
  moodScore: 50,
  experience: 0,
  level: 1,
  totalInteractions: 0,
  totalMessages: 0,
  lastInteractionAt: null,
  lastFedAt: null,
  currentAnimation: 'idle',
  loading: false,

  loadPetState: async () => {
    set({ loading: true })
    const state = await ipc.getPetState()
    set({ ...state, loading: false })
  },

  interact: async (type: InteractionType) => {
    const newState = await ipc.petInteract(type)
    set(newState)
  },

  setAnimation: (currentAnimation: AnimationState) => {
    set({ currentAnimation })
  }
}))
