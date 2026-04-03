import { PetStateMachine } from './state-machine'

/**
 * Autonomous behavior scheduler.
 * Periodically triggers random behaviors based on mood score.
 */
export class BehaviorScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private machine: PetStateMachine
  private moodScore: number = 50
  private running = false

  constructor(machine: PetStateMachine) {
    this.machine = machine
  }

  start(): void {
    this.running = true
    this.scheduleNext()
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  setMoodScore(score: number): void {
    this.moodScore = score
  }

  private scheduleNext(): void {
    if (!this.running) return

    // Higher mood = more frequent behaviors
    const baseDelay = 10000 // 10s minimum
    const variance = 20000 - (this.moodScore / 100) * 10000 // 10-20s variance based on mood
    const delay = baseDelay + Math.random() * variance

    this.timer = setTimeout(() => {
      // Only trigger if currently idle
      if (this.machine.getState() === 'idle') {
        this.machine.trigger('auto-behavior')
      }
      this.scheduleNext()
    }, delay)
  }
}
