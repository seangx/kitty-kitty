import type { AnimationState } from '@shared/types/pet'

export type TransitionTrigger =
  | 'click'
  | 'double-click'
  | 'timeout'
  | 'ai-thinking'
  | 'ai-talking'
  | 'ai-done'
  | 'ai-error'
  | 'auto-behavior'
  | 'drag-start'
  | 'drag-end'

interface Transition {
  from: AnimationState | '*'
  trigger: TransitionTrigger
  to: AnimationState
  duration?: number // ms before auto-transition back to idle
}

const transitions: Transition[] = [
  // User interactions
  { from: '*', trigger: 'click', to: 'happy', duration: 1500 },
  { from: '*', trigger: 'double-click', to: 'happy', duration: 800 },

  // AI states
  { from: '*', trigger: 'ai-thinking', to: 'think' },
  { from: 'think', trigger: 'ai-talking', to: 'talk' },
  { from: 'talk', trigger: 'ai-done', to: 'happy', duration: 2000 },
  { from: '*', trigger: 'ai-done', to: 'happy', duration: 2000 },
  { from: '*', trigger: 'ai-error', to: 'sad', duration: 3000 },

  // Autonomous behaviors
  { from: 'idle', trigger: 'auto-behavior', to: 'walk-left', duration: 4000 },
  { from: 'idle', trigger: 'auto-behavior', to: 'walk-right', duration: 4000 },
  { from: 'idle', trigger: 'auto-behavior', to: 'stretch', duration: 2500 },
  { from: 'idle', trigger: 'auto-behavior', to: 'sleep', duration: 8000 },
  { from: 'idle', trigger: 'auto-behavior', to: 'roll', duration: 2000 },
  { from: 'idle', trigger: 'auto-behavior', to: 'lick', duration: 2500 },
  { from: 'idle', trigger: 'auto-behavior', to: 'jump', duration: 1500 },
  { from: 'idle', trigger: 'auto-behavior', to: 'sneak', duration: 3500 },
]

export class PetStateMachine {
  private state: AnimationState = 'idle'
  private timer: ReturnType<typeof setTimeout> | null = null
  private onChange: (state: AnimationState) => void

  constructor(onChange: (state: AnimationState) => void) {
    this.onChange = onChange
  }

  getState(): AnimationState {
    return this.state
  }

  trigger(trigger: TransitionTrigger): void {
    const candidates = transitions.filter(
      (t) => (t.from === this.state || t.from === '*') && t.trigger === trigger
    )

    if (candidates.length === 0) return

    // Pick a random valid transition (for auto-behavior variety)
    const transition = candidates[Math.floor(Math.random() * candidates.length)]

    this.clearTimer()
    this.state = transition.to
    this.onChange(this.state)

    if (transition.duration) {
      this.timer = setTimeout(() => {
        this.state = 'idle'
        this.onChange(this.state)
      }, transition.duration)
    }
  }

  forceState(state: AnimationState, duration?: number): void {
    this.clearTimer()
    this.state = state
    this.onChange(this.state)

    if (duration) {
      this.timer = setTimeout(() => {
        this.state = 'idle'
        this.onChange(this.state)
      }, duration)
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  destroy(): void {
    this.clearTimer()
  }
}
