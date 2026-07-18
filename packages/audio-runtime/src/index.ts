import type { AudioSource, PlaybackEvent } from '../../contracts/src/index';

export type PlaybackListener = (event: PlaybackEvent) => void;

export interface PlaybackClock {
  readonly positionMs: number;
  play(source: AudioSource): Promise<void>;
  pause(): void;
  resume(): void;
  interrupt(): Promise<void>;
  subscribe(listener: PlaybackListener): () => void;
}

export interface LipSyncFrame {
  mouthOpen: number;
  mouthForm?: number;
}

export interface LipSyncSource {
  sample(positionMs: number): LipSyncFrame;
  reset(): void;
}
