import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlaybackEvent } from '../../contracts/src/index.ts';
import { WebAudioPcmStreamPlayer } from '../src/web-audio-pcm-player.ts';

test('stream boundaries and progress follow scheduled WebAudio playback instead of packet receipt', async () => {
  const context = new RealtimeAudioContext();
  const marks: string[] = [];
  const events: PlaybackEvent[] = [];
  let startedPlaybackTime = -1;
  let completedPlaybackTime = -1;
  const player = new WebAudioPcmStreamPlayer({
    contextFactory: () => context as unknown as AudioContext,
    initialBufferMs: 20,
    startLeadMs: 5,
    levelIntervalMs: 10,
    levelWindowMs: 10,
    openStream: async () => streamWithStall(marks),
  });
  player.subscribe(event => {
    marks.push(event.type);
    events.push(event);
    if (event.type === 'playback.started') startedPlaybackTime = context.currentTime;
    if (event.type === 'playback.completed') completedPlaybackTime = context.currentTime;
  });

  const play = player.play(3, 'speech', {
    delivery: 'stream', requestId: 'stream-3', uri: 'memory://stream-3', mimeType: 'audio/pcm',
    codec: 'pcm_s16le', sampleRateHz: 1_000, channels: 1,
  });
  await waitFor(() => events.some(event => event.type === 'playback.completed'));
  await play;

  const started = requiredEvent(events, 'playback.started');
  const stalled = requiredEvent(events, 'playback.stalled');
  const recovered = requiredEvent(events, 'playback.recovered');
  const completed = requiredEvent(events, 'playback.completed');
  assert.ok(marks.indexOf('first-chunk') < marks.indexOf('playback.started'));
  assert.ok(startedPlaybackTime >= context.scheduledRanges[0]!.startTime - 0.002);
  assert.ok(events.indexOf(started) < events.indexOf(stalled));
  assert.ok(events.indexOf(stalled) < events.indexOf(recovered));
  assert.ok(events.indexOf(recovered) < events.indexOf(completed));
  assert.ok(marks.indexOf('stream-eof') < marks.indexOf('playback.completed'));
  assert.ok(Math.abs(stalled.positionMs - 80) <= 2, `stall position was ${stalled.positionMs}`);
  assert.ok(Math.abs(recovered.positionMs - 80) <= 2, `recovery position was ${recovered.positionMs}`);
  assert.equal(completed.positionMs, 160);
  assert.ok(completedPlaybackTime >= context.scheduledRanges.at(-1)!.endTime - 0.002);

  const stalledIndex = events.indexOf(stalled);
  const recoveredIndex = events.indexOf(recovered);
  assert.equal(
    events.slice(stalledIndex + 1, recoveredIndex).some(event => event.type === 'playback.progress'),
    false,
    'playback progress must freeze while no PCM is reaching the output',
  );
});

async function* streamWithStall(marks: string[]): AsyncIterable<Uint8Array> {
  await delay(30);
  marks.push('first-chunk');
  yield pcmFrames(80, 0.4);
  await delay(120);
  marks.push('second-chunk');
  yield pcmFrames(80, 0.4);
  marks.push('stream-eof');
}

function pcmFrames(frameCount: number, value: number): Uint8Array {
  const bytes = new Uint8Array(frameCount * 2);
  const view = new DataView(bytes.buffer);
  const sample = Math.round(value * 32_767);
  for (let frame = 0; frame < frameCount; frame++) view.setInt16(frame * 2, sample, true);
  return bytes;
}

function requiredEvent<T extends PlaybackEvent['type']>(events: PlaybackEvent[], type: T): Extract<PlaybackEvent, { type: T }> {
  const event = events.find(candidate => candidate.type === type);
  assert.ok(event, `missing ${type}`);
  return event as Extract<PlaybackEvent, { type: T }>;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error('condition timed out');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class RealtimeAudioContext {
  readonly destination = {};
  readonly state = 'running';
  readonly scheduledRanges: Array<{ startTime: number; endTime: number }> = [];
  private readonly origin = performance.now();

  get currentTime(): number { return (performance.now() - this.origin) / 1_000; }
  resume(): Promise<void> { return Promise.resolve(); }
  suspend(): Promise<void> { return Promise.resolve(); }

  createBuffer(_channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(length, sampleRate);
  }

  createBufferSource(): FakeAudioBufferSourceNode {
    return new FakeAudioBufferSourceNode(this);
  }
}

class FakeAudioBuffer {
  readonly samples: Float32Array;
  readonly length: number;
  readonly sampleRate: number;
  constructor(length: number, sampleRate: number) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.samples = new Float32Array(length);
  }
  getChannelData(): Float32Array { return this.samples; }
}

class FakeAudioBufferSourceNode {
  buffer: FakeAudioBuffer | null = null;
  private readonly context: RealtimeAudioContext;
  private endedListener: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(context: RealtimeAudioContext) { this.context = context; }
  connect(): void {}
  disconnect(): void {}
  addEventListener(type: string, listener: () => void): void {
    if (type === 'ended') this.endedListener = listener;
  }
  start(when: number): void {
    const buffer = this.buffer;
    if (!buffer) throw new Error('buffer is required before start');
    const startDelayMs = Math.max(0, (when - this.context.currentTime) * 1_000);
    const durationMs = buffer.length / buffer.sampleRate * 1_000;
    this.context.scheduledRanges.push({ startTime: when, endTime: when + durationMs / 1_000 });
    this.timer = setTimeout(() => this.endedListener?.(), startDelayMs + durationMs);
  }
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
