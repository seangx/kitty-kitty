import { getDB } from './database'
import type { PetState, InteractionType } from '@shared/types/pet'
import { XP_PER_LEVEL, MOOD_THRESHOLDS } from '@shared/constants'

export function getPetState(): PetState {
  const db = getDB()
  return db.prepare(`
    SELECT mood, mood_score as moodScore, experience, level,
           total_interactions as totalInteractions,
           last_interaction_at as lastInteractionAt
    FROM pet_state WHERE id = 1
  `).get() as PetState
}

export function updatePetState(updates: Partial<PetState>): PetState {
  const db = getDB()
  const fields: string[] = []
  const values: unknown[] = []

  if (updates.mood !== undefined) { fields.push('mood = ?'); values.push(updates.mood) }
  if (updates.moodScore !== undefined) { fields.push('mood_score = ?'); values.push(Math.max(0, Math.min(100, updates.moodScore))) }
  if (updates.experience !== undefined) { fields.push('experience = ?'); values.push(updates.experience) }
  if (updates.level !== undefined) { fields.push('level = ?'); values.push(updates.level) }
  if (updates.totalInteractions !== undefined) { fields.push('total_interactions = ?'); values.push(updates.totalInteractions) }
  if (updates.lastInteractionAt !== undefined) { fields.push('last_interaction_at = ?'); values.push(updates.lastInteractionAt) }

  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')")
    db.prepare(`UPDATE pet_state SET ${fields.join(', ')} WHERE id = 1`).run(...values)
  }

  return getPetState()
}

export function recordInteraction(type: InteractionType, _detail?: string): PetState {
  const state = getPetState()

  let moodDelta = 0
  let xpGained = 0

  switch (type) {
    case 'click': moodDelta = 2; xpGained = 2; break
    case 'pet': moodDelta = 5; xpGained = 5; break
    case 'drag': moodDelta = -1; xpGained = 1; break
    case 'feed': moodDelta = 8; xpGained = 15; break
    case 'chat': moodDelta = 3; xpGained = 10; break
  }

  const newMoodScore = Math.max(0, Math.min(100, state.moodScore + moodDelta))
  const newXP = state.experience + xpGained
  const newLevel = Math.floor(newXP / XP_PER_LEVEL) + 1

  let mood: string = 'neutral'
  if (newMoodScore >= MOOD_THRESHOLDS.HAPPY) mood = 'happy'
  else if (newMoodScore >= MOOD_THRESHOLDS.SAD) mood = 'neutral'
  else mood = 'sad'

  return updatePetState({
    mood: mood as PetState['mood'],
    moodScore: newMoodScore,
    experience: newXP,
    level: newLevel,
    totalInteractions: state.totalInteractions + 1,
    lastInteractionAt: new Date().toISOString()
  })
}
