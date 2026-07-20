import type {
  AudioSource,
  PlaybackEvent,
} from '../../contracts/src/index.ts';

export type PlaybackListener = (event: PlaybackEvent) => void;

export interface AudioPlayerPort {
  play(generation: number, segmentId: string, source: AudioSource): Promise<void>;
  pause(generation: number): void;
  resume(generation: number): void;
  stop(generation: number): Promise<void>;
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

export * from './known-tone-fixture.ts';
export * from './web-audio-pcm-player.ts';
