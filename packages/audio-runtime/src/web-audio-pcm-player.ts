import type { AudioSource, AudioStreamSource, PlaybackEvent } from '../../contracts/src/index.ts';
import type { AudioPlayerPort, PlaybackListener } from './index.ts';

export type PcmStreamResolver = (
  source: AudioStreamSource,
  signal: AbortSignal,
) => AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>;

export interface WebAudioPcmPlayerOptions {
  openStream: PcmStreamResolver;
  initialBufferMs?: number;
  startLeadMs?: number;
  levelIntervalMs?: number;
  levelWindowMs?: number;
  contextFactory?: () => AudioContext;
}

interface PcmBlock {
  firstFrame: number;
  samples: Float32Array;
  startTime: number | null;
}

interface PlaybackSession {
  generation: number;
  segmentId: string;
  source: AudioStreamSource;
  controller: AbortController;
  blocks: PcmBlock[];
  pendingBlocks: PcmBlock[];
  scheduledNodes: Set<AudioBufferSourceNode>;
  totalFrames: number;
  nextStartTime: number;
  startedAt: number | null;
  streamEnded: boolean;
  stalled: boolean;
  startTimer: ReturnType<typeof setTimeout> | undefined;
  recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  progressTimer: ReturnType<typeof setInterval> | undefined;
}

export class WebAudioPcmStreamPlayer implements AudioPlayerPort {
  private readonly listeners = new Set<PlaybackListener>();
  private readonly openStream: PcmStreamResolver;
  private readonly initialBufferMs: number;
  private readonly startLeadMs: number;
  private readonly levelIntervalMs: number;
  private readonly levelWindowMs: number;
  private readonly contextFactory: () => AudioContext;
  private context: AudioContext | undefined;
  private current: PlaybackSession | null = null;

  constructor(options: WebAudioPcmPlayerOptions) {
    this.openStream = options.openStream;
    this.initialBufferMs = positive(options.initialBufferMs ?? 100, 'initialBufferMs');
    this.startLeadMs = positive(options.startLeadMs ?? 30, 'startLeadMs');
    this.levelIntervalMs = positive(options.levelIntervalMs ?? 25, 'levelIntervalMs');
    this.levelWindowMs = positive(options.levelWindowMs ?? 20, 'levelWindowMs');
    this.contextFactory = options.contextFactory ?? (() => new AudioContext());
  }

  async play(generation: number, segmentId: string, source: AudioSource): Promise<void> {
    assertPcmStream(source);
    if (this.current) await this.stop(this.current.generation);
    const context = this.context ??= this.contextFactory();
    if (context.state === 'suspended') await context.resume();

    const session: PlaybackSession = {
      generation, segmentId, source, controller: new AbortController(),
      blocks: [], pendingBlocks: [], scheduledNodes: new Set(), totalFrames: 0,
      nextStartTime: 0, startedAt: null, streamEnded: false, stalled: false,
      startTimer: undefined, recoveryTimer: undefined, progressTimer: undefined,
    };
    this.current = session;
    this.emit({ type: 'playback.buffering', generation, segmentId, positionMs: 0, bufferedMs: 0 });

    try {
      const stream = await this.openStream(source, session.controller.signal);
      let lowByte: number | undefined;
      for await (const chunk of stream) {
        if (session.controller.signal.aborted) return;
        const decoded = decodePcmS16Le(chunk, lowByte);
        lowByte = decoded.lowByte;
        if (!decoded.samples.length) continue;
        const block = { firstFrame: session.totalFrames, samples: decoded.samples, startTime: null };
        session.totalFrames += decoded.samples.length;
        session.blocks.push(block);
        if (session.startedAt === null) session.pendingBlocks.push(block);
        else this.scheduleBlock(session, block);

        const bufferedMs = session.totalFrames / source.sampleRateHz * 1_000;
        if (session.startedAt === null) {
          this.emit({ type: 'playback.buffering', generation, segmentId, positionMs: 0, bufferedMs });
          if (bufferedMs >= this.initialBufferMs) this.startSession(session);
        }
      }
      if (lowByte !== undefined) throw new Error('PCM stream ended with an incomplete 16-bit sample');
      if (session.startedAt === null) {
        if (!session.totalFrames) throw new Error('PCM stream contained no audio samples');
        this.startSession(session);
      }
      session.streamEnded = true;
      if (!session.scheduledNodes.size) this.complete(session);
    }
    catch (error) {
      if (session.controller.signal.aborted) return;
      if (this.current === session) this.cleanup(session);
      throw error;
    }
  }

  pause(generation: number): void {
    const session = this.current;
    if (!session || session.generation !== generation || session.startedAt === null) return;
    const positionMs = this.positionMs(session);
    void this.context?.suspend();
    this.emit({ type: 'playback.paused', generation, segmentId: session.segmentId, positionMs });
  }

  resume(generation: number): void {
    const session = this.current;
    if (!session || session.generation !== generation || session.startedAt === null) return;
    void this.context?.resume();
    this.emit({ type: 'playback.resumed', generation, segmentId: session.segmentId, positionMs: this.positionMs(session) });
  }

  async stop(generation: number): Promise<void> {
    const session = this.current;
    if (!session || session.generation !== generation) return;
    const positionMs = this.positionMs(session);
    this.current = null;
    session.controller.abort();
    this.cleanup(session);
    this.emit({ type: 'playback.interrupted', generation, segmentId: session.segmentId, positionMs });
  }

  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private startSession(session: PlaybackSession): void {
    if (this.current !== session || session.startedAt !== null) return;
    const context = this.context!;
    session.startedAt = context.currentTime + this.startLeadMs / 1_000;
    session.nextStartTime = session.startedAt;
    for (const block of session.pendingBlocks) this.scheduleBlock(session, block);
    session.pendingBlocks = [];
    this.emitStartedAtOutput(session);
  }

  private scheduleBlock(session: PlaybackSession, block: PcmBlock): void {
    const context = this.context!;
    const outputTime = this.playbackContextTime();
    if (session.startedAt !== null && !session.stalled && session.nextStartTime <= outputTime) {
      this.markStalled(session);
    }
    const recovering = session.stalled && session.recoveryTimer === undefined;
    const startTime = recovering || session.nextStartTime <= outputTime
      ? context.currentTime + this.startLeadMs / 1_000
      : session.nextStartTime;
    block.startTime = startTime;
    const buffer = context.createBuffer(1, block.samples.length, session.source.sampleRateHz);
    buffer.getChannelData(0).set(block.samples);
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(context.destination);
    session.scheduledNodes.add(node);
    node.addEventListener('ended', () => {
      node.disconnect();
      session.scheduledNodes.delete(node);
      if (this.current !== session || session.scheduledNodes.size) return;
      if (session.streamEnded) this.complete(session);
      else this.markStalled(session);
    }, { once: true });
    node.start(startTime);
    session.nextStartTime = startTime + block.samples.length / session.source.sampleRateHz;
    if (recovering) this.emitRecoveredAtOutput(
      session,
      startTime,
      block.firstFrame / session.source.sampleRateHz * 1_000,
    );
  }

  private emitProgress(session: PlaybackSession): void {
    if (this.current !== session || session.startedAt === null || session.stalled || this.context?.state !== 'running') return;
    const positionMs = this.positionMs(session);
    this.emit({ type: 'playback.progress', generation: session.generation, segmentId: session.segmentId, positionMs });
    this.emit({
      type: 'playback.level', generation: session.generation, segmentId: session.segmentId,
      positionMs, value: measureBlocks(session, positionMs, this.levelWindowMs),
    });
  }

  private emitStartedAtOutput(session: PlaybackSession): void {
    if (this.current !== session || session.startedAt === null) return;
    const remainingMs = (session.startedAt - this.playbackContextTime()) * 1_000;
    if (remainingMs > 1) {
      session.startTimer = setTimeout(
        () => this.emitStartedAtOutput(session),
        Math.max(1, Math.min(remainingMs, this.levelIntervalMs)),
      );
      return;
    }
    this.emit({
      type: 'playback.started', generation: session.generation, segmentId: session.segmentId,
      positionMs: 0,
    });
    session.progressTimer = setInterval(() => this.emitProgress(session), this.levelIntervalMs);
  }

  private emitRecoveredAtOutput(session: PlaybackSession, startTime: number, positionMs: number): void {
    if (this.current !== session || !session.stalled) return;
    const remainingMs = (startTime - this.playbackContextTime()) * 1_000;
    if (remainingMs > 1) {
      session.recoveryTimer = setTimeout(
        () => this.emitRecoveredAtOutput(session, startTime, positionMs),
        Math.max(1, Math.min(remainingMs, this.levelIntervalMs)),
      );
      return;
    }
    session.recoveryTimer = undefined;
    session.stalled = false;
    this.emit({
      type: 'playback.recovered', generation: session.generation, segmentId: session.segmentId,
      positionMs,
    });
  }

  private markStalled(session: PlaybackSession): void {
    if (this.current !== session || session.startedAt === null || session.stalled) return;
    session.stalled = true;
    const positionMs = this.positionMs(session);
    this.emit({
      type: 'playback.level', generation: session.generation, segmentId: session.segmentId,
      positionMs, value: 0,
    });
    this.emit({
      type: 'playback.stalled', generation: session.generation, segmentId: session.segmentId, positionMs,
    });
  }

  private complete(session: PlaybackSession): void {
    if (this.current !== session) return;
    const durationMs = session.totalFrames / session.source.sampleRateHz * 1_000;
    this.current = null;
    this.cleanup(session, false);
    this.emit({ type: 'playback.completed', generation: session.generation, segmentId: session.segmentId, positionMs: durationMs });
  }

  private cleanup(session: PlaybackSession, stopNodes = true): void {
    if (session.startTimer) clearTimeout(session.startTimer);
    if (session.recoveryTimer) clearTimeout(session.recoveryTimer);
    if (session.progressTimer) clearInterval(session.progressTimer);
    if (stopNodes) {
      for (const node of session.scheduledNodes) {
        try { node.stop(); }
        catch {}
        node.disconnect();
      }
    }
    session.scheduledNodes.clear();
    if (this.current === session) this.current = null;
  }

  private positionMs(session: PlaybackSession): number {
    if (session.startedAt === null || !this.context) return 0;
    const outputTime = this.playbackContextTime();
    let playedFrames = 0;
    for (const block of session.blocks) {
      if (block.startTime === null || outputTime <= block.startTime) break;
      const elapsedFrames = Math.floor((outputTime - block.startTime) * session.source.sampleRateHz);
      playedFrames = Math.max(
        playedFrames,
        block.firstFrame + Math.min(block.samples.length, Math.max(0, elapsedFrames)),
      );
      if (elapsedFrames < block.samples.length) break;
    }
    return playedFrames / session.source.sampleRateHz * 1_000;
  }

  private playbackContextTime(): number {
    return this.context!.currentTime;
  }

  private emit(event: PlaybackEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function assertPcmStream(source: AudioSource): asserts source is AudioStreamSource {
  if (source.delivery !== 'stream' || source.codec !== 'pcm_s16le') {
    throw new Error('WebAudioPcmStreamPlayer currently requires a pcm_s16le stream');
  }
  if (source.channels !== 1) throw new Error('WebAudioPcmStreamPlayer currently requires mono PCM');
}

function decodePcmS16Le(bytes: Uint8Array, carriedLowByte: number | undefined): {
  samples: Float32Array;
  lowByte: number | undefined;
} {
  const sampleCount = Math.floor((bytes.byteLength + (carriedLowByte === undefined ? 0 : 1)) / 2);
  const samples = new Float32Array(sampleCount);
  let outputIndex = 0;
  let inputIndex = 0;
  if (carriedLowByte !== undefined && bytes.byteLength) {
    samples[outputIndex++] = signed16(carriedLowByte, bytes[inputIndex++]!) / 32_768;
  }
  while (inputIndex + 1 < bytes.byteLength) {
    samples[outputIndex++] = signed16(bytes[inputIndex++]!, bytes[inputIndex++]!) / 32_768;
  }
  return {
    samples,
    lowByte: inputIndex < bytes.byteLength ? bytes[inputIndex] : undefined,
  };
}

function signed16(lowByte: number, highByte: number): number {
  const unsigned = lowByte | (highByte << 8);
  return unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
}

function measureBlocks(session: PlaybackSession, positionMs: number, windowMs: number): number {
  const endFrame = Math.max(0, Math.floor(positionMs * session.source.sampleRateHz / 1_000));
  const startFrame = Math.max(0, endFrame - Math.round(windowMs * session.source.sampleRateHz / 1_000));
  let sumSquares = 0;
  let sampleCount = 0;
  for (const block of session.blocks) {
    const blockEnd = block.firstFrame + block.samples.length;
    const overlapStart = Math.max(startFrame, block.firstFrame);
    const overlapEnd = Math.min(endFrame, blockEnd);
    for (let frame = overlapStart; frame < overlapEnd; frame++) {
      const value = block.samples[frame - block.firstFrame]!;
      sumSquares += value * value;
      sampleCount++;
    }
  }
  return sampleCount ? clamp01(Math.sqrt(sumSquares / sampleCount) * Math.SQRT2) : 0;
}

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`);
  return value;
}
