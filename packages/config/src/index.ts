import type { AvatarAction, Emotion } from '../../contracts/src/index';

export interface CharacterConfig {
  id: string;
  modelJsonUrl: string;
  defaultEmotion: Emotion;
  allowedEmotions: Emotion[];
  allowedActions: AvatarAction[];
  expressionCooldownMs: number;
  idleReturnDelayMs: number;
}
