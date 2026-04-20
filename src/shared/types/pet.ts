export type Mood = 'happy' | 'neutral' | 'sad' | 'excited' | 'sleepy'

export type AnimationState =
  | 'idle'
  | 'walk-left'
  | 'walk-right'
  | 'sleep'
  | 'happy'
  | 'think'
  | 'talk'
  | 'sad'
  | 'stretch'
  | 'dance'
  | 'roll'
  | 'lick'
  | 'jump'
  | 'sneak'

export type SkinId = 'calico' | 'sheep' | 'chicken'

export interface PetState {
  mood: Mood
  moodScore: number
  experience: number
  level: number
  totalInteractions: number
  lastInteractionAt: string | null
}

export type InteractionType = 'chat' | 'pet' | 'drag' | 'click' | 'feed'
