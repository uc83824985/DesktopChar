import { Application, Ticker } from 'pixi.js';
import { Live2DModel, MotionPriority } from 'pixi-live2d-display/cubism4';
import type { AvatarEvent, RuntimeEffect } from '../../../../packages/contracts/src/index.ts';
import type { AmplitudeSample } from '../../../../packages/contracts/src/index.ts';
import {
  KNOWN_TONE_PULSES,
  KNOWN_TONE_SPEECH_TEXT,
  KNOWN_TONE_STREAM_URI,
  WebAudioPcmStreamPlayer,
  createKnownToneAudioSource,
  createKnownTonePcmStream,
  evaluateKnownToneAcceptance,
  evaluateKnownToneResponseTiming,
} from '../../../../packages/audio-runtime/src/index.ts';
import type { KnownToneResponseTrace } from '../../../../packages/audio-runtime/src/index.ts';
import { AvatarRuntime, DefaultAvatarPlanner, ParameterMixer } from '../../../../packages/avatar-runtime/src/index.ts';
import { DEFAULT_TTS_CONFIG } from '../../../../packages/config/src/index.ts';
import { RuntimeParameterFrame } from '../../../../packages/live2d-renderer/src/index.ts';
import type { TtsAdapter } from '../../../../packages/tts-mcp-adapter/src/index.ts';
import { JsonConsoleTtsLogger, MockTtsAdapter, TtsRuntimeEffectHandler } from '../../../../packages/tts-mcp-adapter/src/index.ts';
import './style.css';

Live2DModel.registerTicker(Ticker);
const canvas = document.querySelector<HTMLCanvasElement>('#avatar')!;
const status = document.querySelector<HTMLElement>('#status')!;
const speak = document.querySelector<HTMLButtonElement>('#speak')!;
const tone = document.querySelector<HTMLButtonElement>('#tone')!;
const motion = document.querySelector<HTMLButtonElement>('#motion')!;
const gaze = document.querySelector<HTMLButtonElement>('#gaze')!;
const reset = document.querySelector<HTMLButtonElement>('#reset')!;
const toneDebug = document.querySelector<HTMLElement>('#tone-debug')!;
const tonePlaybackPoint = document.querySelector<HTMLElement>('#tone-playback-point')!;
const toneModelPoint = document.querySelector<HTMLElement>('#tone-model-point')!;
const toneFramePoint = document.querySelector<HTMLElement>('#tone-frame-point')!;
const toneSyncLog = document.querySelector<HTMLOListElement>('#tone-sync-log')!;
const app = new Application({ view: canvas, resizeTo: window, backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: Math.min(devicePixelRatio, 2) });

type CubismCoreModel = {
  setParameterValueById(id: string, value: number): void;
  getParameterValueById(id: string): number;
};
interface ToneSyncTrace extends KnownToneResponseTrace {
  level: number;
  modelValue?: number;
}
interface ToneAcceptanceRun {
  segmentId: string;
  playerLevels: AmplitudeSample[];
  modelLevels: AmplitudeSample[];
  traces: ToneSyncTrace[];
  lastLoggedBucket: number;
  lastLoggedPhase: string;
}
let model: Live2DModel | undefined;
let runtime: AvatarRuntime | undefined;
let playbackTimer: ReturnType<typeof setInterval> | undefined;
let motionTimer: ReturnType<typeof setTimeout> | undefined;
let motionRequestToken = 0;
let toneAcceptance: ToneAcceptanceRun | null = null;
let applyingToneTrace: ToneSyncTrace | null = null;
const pendingToneTraces: ToneSyncTrace[] = [];
const runtimeFrame = new RuntimeParameterFrame({
  aliases: { ParamMouthOpenY: 'ParamA', ParamMouthForm: 'ParamMouthUp' },
});
const mockTtsAdapter = new MockTtsAdapter({ ...DEFAULT_TTS_CONFIG.mock, logger: new JsonConsoleTtsLogger() });
const ttsAdapter: TtsAdapter = {
  prepare: request => request.text === KNOWN_TONE_SPEECH_TEXT
    ? Promise.resolve(createKnownToneAudioSource(request.requestId))
    : mockTtsAdapter.prepare(request),
  cancel: requestId => mockTtsAdapter.cancel(requestId),
  capabilities: () => mockTtsAdapter.capabilities(),
  health: () => mockTtsAdapter.health(),
};
const ttsEffects = new TtsRuntimeEffectHandler(ttsAdapter);
const tonePlayer = new WebAudioPcmStreamPlayer({
  initialBufferMs: 100, levelIntervalMs: 25, levelWindowMs: 20,
  openStream(source, signal) {
    if (source.uri !== KNOWN_TONE_STREAM_URI) throw new Error(`Unknown test stream: ${source.uri}`);
    return createKnownTonePcmStream({ chunkDurationMs: 20, chunkDelayMs: 1, signal });
  },
});
document.body.dataset.toneAcceptance = 'idle';
tonePlayer.subscribe(event => {
  const active = toneAcceptance?.segmentId === event.segmentId ? toneAcceptance : null;
  if (active && event.type === 'playback.level') {
    active.playerLevels.push({ atMs: event.positionMs, value: event.value });
    const trace: ToneSyncTrace = {
      atMs: event.positionMs, level: event.value, playbackObservedAtMs: performance.now(),
    };
    active.traces.push(trace);
    applyingToneTrace = trace;
    tonePlaybackPoint.textContent = `T+${formatMs(trace.atMs)} · L=${trace.level.toFixed(3)} · ${tonePhase(trace.atMs)}`;
    try { runtime?.dispatch(event); }
    finally { applyingToneTrace = null; }
  }
  else runtime?.dispatch(event);
  if (active && event.type === 'playback.completed') {
    afterRenderedFrames(2, () => finishToneAcceptance(active));
  }
  else if (active && event.type === 'playback.interrupted') failToneAcceptance('acceptance playback was interrupted');
});

try {
  model = await Live2DModel.from('/models/Mao/Mao.model3.json', { autoInteract: false });
  model.internalModel.on('beforeModelUpdate', applyRuntimeFrame);
  app.stage.addChild(model);
  fitModel();
  window.addEventListener('resize', fitModel);

  runtime = new AvatarRuntime({
    planner: new DefaultAvatarPlanner(),
    mixer: new ParameterMixer({ ranges: {
      ParamA: { min: 0, max: 1 }, ParamMouthOpenY: { min: 0, max: 1 },
      ParamMouthForm: { min: -1, max: 1 },
      ParamAngleX: { min: -30, max: 30 }, ParamAngleY: { min: -30, max: 30 },
      ParamEyeBallX: { min: -1, max: 1 }, ParamEyeBallY: { min: -1, max: 1 },
    } }),
    effects: { execute },
  });
  runtime.dispatch({ type: 'renderer.ready', capabilities: {
    emotions: ['neutral', 'happy'], actions: ['nod'],
    parameters: [
      'ParamA', 'ParamMouthOpenY', 'ParamMouthForm',
      'ParamAngleX', 'ParamAngleY', 'ParamEyeBallX', 'ParamEyeBallY',
    ],
    supportsMouthForm: true, supportsGaze: true, supportsHitTest: true,
  } });
  const ttsHealth = await ttsAdapter.health();
  document.body.dataset.ttsHealth = ttsHealth.status;
  runtime.subscribe(snapshot => {
    document.body.dataset.runtimeState = snapshot.state;
    document.body.dataset.gazeFollow = snapshot.gaze.active ? 'enabled' : 'disabled';
    const busy = snapshot.state !== 'idle';
    for (const button of [speak, tone, motion]) button.disabled = busy;
    reset.disabled = false;
    gaze.disabled = !(snapshot.capabilities?.supportsGaze ?? false);
    gaze.textContent = snapshot.gaze.active ? '眼部跟随：开' : '眼部跟随：关';
    gaze.setAttribute('aria-pressed', String(snapshot.gaze.active));
    status.textContent = snapshot.state === 'speaking'
      ? `Runtime: speaking · ${Math.round(snapshot.playback.positionMs)} ms`
      : 'Runtime 已就绪 · UI 仅发送事件，状态由 Runtime 持有';
  });

  window.addEventListener('pointermove', event => runtime?.dispatch({
    type: 'user.look-target-changed',
    x: event.clientX / innerWidth * 2 - 1,
    y: -(event.clientY / innerHeight * 2 - 1),
  }));
  speak.addEventListener('click', () => submitDemo(false));
  tone.addEventListener('click', submitToneAcceptance);
  motion.addEventListener('click', () => submitDemo(true));
  gaze.addEventListener('click', () => runtime?.dispatch({
    type: runtime.getSnapshot().gaze.active ? 'user.gaze-follow-disabled' : 'user.gaze-follow-enabled',
  }));
  reset.addEventListener('click', () => runtime?.dispatch({ type: 'user.interrupt-requested' }));

  document.body.dataset.ready = 'true';
}
catch (error) {
  status.textContent = `加载失败：${error instanceof Error ? error.message : String(error)}`;
  document.body.dataset.ready = 'false';
  console.error(error);
}

function submitToneAcceptance(): void {
  if (!runtime || runtime.getSnapshot().state !== 'idle') return;
  const suffix = Date.now();
  const segmentId = `known-tone-${suffix}`;
  toneAcceptance = {
    segmentId, playerLevels: [], modelLevels: [], traces: [],
    lastLoggedBucket: -1, lastLoggedPhase: '',
  };
  pendingToneTraces.length = 0;
  document.body.dataset.toneAcceptance = 'running';
  delete document.body.dataset.toneAcceptanceMetrics;
  toneDebug.hidden = false;
  tonePlaybackPoint.textContent = '正在等待 playback.level';
  toneModelPoint.textContent = '正在等待 ParamA 写入';
  toneFramePoint.textContent = '正在等待下一屏幕帧';
  toneSyncLog.replaceChildren();
  runtime.dispatch({ type: 'plan.submitted', plan: { id: `known-tone-plan-${suffix}`, segments: [{
    id: segmentId, sequence: 0, displayText: '先验铃声口型同步验收', speechText: KNOWN_TONE_SPEECH_TEXT,
  }] } });
}

function submitDemo(withAction: boolean): void {
  if (!runtime || runtime.getSnapshot().state !== 'idle') return;
  runtime.dispatch({ type: 'plan.submitted', plan: { id: `demo-${Date.now()}`, segments: [{
    id: `segment-${Date.now()}`, sequence: 0, displayText: '运行时演示',
    speechText: withAction ? '正在播放动作演示，请观察视线和身体动作。' : '运行时演示',
    emotion: { emotion: 'happy', intensity: 0.7, atMs: 100 },
    actions: withAction ? [{ id: 'nod-demo', action: 'nod', atMs: 200 }] : [],
  }] } });
}

function execute(effect: RuntimeEffect, dispatch: (event: AvatarEvent) => void): void {
  if (ttsEffects.handle(effect, dispatch)) return;
  if (effect.type === 'audio.play') {
    if (effect.source.uri === KNOWN_TONE_STREAM_URI) {
      return void tonePlayer.play(effect.generation, effect.segmentId, effect.source).catch(error => {
        failToneAcceptance(error instanceof Error ? error.message : String(error));
        dispatch({
          type: 'playback.failed', generation: effect.generation, segmentId: effect.segmentId,
          error: { code: 'known-tone-playback-failed', message: error instanceof Error ? error.message : String(error), recoverable: true },
        });
      });
    }
    clearPlayback();
    const startedAt = performance.now();
    const durationMs = effect.source.durationMs ?? 1_800;
    dispatch({ type: 'playback.buffering', generation: effect.generation, segmentId: effect.segmentId, positionMs: 0, bufferedMs: 200 });
    dispatch({ type: 'playback.started', generation: effect.generation, segmentId: effect.segmentId, positionMs: 0 });
    playbackTimer = setInterval(() => {
      const positionMs = performance.now() - startedAt;
      if (positionMs >= durationMs) {
        clearPlayback();
        dispatch({ type: 'playback.completed', generation: effect.generation, segmentId: effect.segmentId, positionMs: durationMs });
      } else {
        dispatch({ type: 'playback.progress', generation: effect.generation, segmentId: effect.segmentId, positionMs });
        if (effect.source.delivery === 'stream') dispatch({
          type: 'playback.level', generation: effect.generation, segmentId: effect.segmentId,
          positionMs, value: sampleAmplitude(effect.source.amplitude, positionMs),
        });
      }
    }, 50);
  }
  else if (effect.type === 'audio.pause') tonePlayer.pause(effect.generation);
  else if (effect.type === 'audio.resume') tonePlayer.resume(effect.generation);
  else if (effect.type === 'audio.stop') {
    clearPlayback();
    stopCurrentMotion('interrupted');
    void tonePlayer.stop(effect.generation);
  }
  else if (effect.type === 'renderer.apply-frame') {
    runtimeFrame.replace(effect.frame);
    if (toneAcceptance && applyingToneTrace && effect.frame.ParamMouthOpenY !== undefined) {
      pendingToneTraces.push(applyingToneTrace);
    }
  }
  else if (effect.type === 'renderer.play-motion' && model) {
    const activeModel = model;
    stopCurrentMotion('replaced');
    const requestToken = ++motionRequestToken;
    document.body.dataset.motionState = 'starting';
    void activeModel.motion('TapBody', 0, MotionPriority.FORCE).then(started => {
      if (requestToken !== motionRequestToken) {
        if (started) activeModel.internalModel.motionManager.stopAllMotions();
        return;
      }
      if (!started) throw new Error('Live2D TapBody motion did not start');
      document.body.dataset.motionState = 'playing';
      motionTimer = setTimeout(() => {
        if (requestToken !== motionRequestToken) return;
        activeModel.internalModel.motionManager.stopAllMotions();
        motionTimer = undefined;
        document.body.dataset.motionState = 'completed';
        dispatch({ type: 'renderer.motion-completed', generation: effect.generation, actionId: effect.command.actionId });
      }, 1_200);
    }).catch(error => {
      document.body.dataset.motionState = 'failed';
      dispatch({
        type: 'renderer.motion-failed', generation: effect.generation, actionId: effect.command.actionId,
        error: { code: 'live2d-motion-failed', message: error instanceof Error ? error.message : String(error), recoverable: true },
      });
    });
  }
}

function applyRuntimeFrame(): void {
  if (!model) return;
  const core = coreModel(model);
  runtimeFrame.apply(core);
  if (!pendingToneTraces.length) return;

  const active = toneAcceptance;
  const traces = pendingToneTraces.splice(0);
  if (!active) return;
  const modelValue = core.getParameterValueById('ParamA');
  for (const trace of traces) {
    trace.modelAppliedAtMs = performance.now();
    trace.modelValue = modelValue;
    active.modelLevels.push({ atMs: trace.atMs, value: modelValue });
    const modelDelayMs = trace.modelAppliedAtMs - trace.playbackObservedAtMs;
    toneModelPoint.textContent = `帧末 ParamA=${modelValue.toFixed(3)} · Δ ${formatMs(modelDelayMs)}`;
    app.renderer.once('postrender', () => {
      if (toneAcceptance !== active) return;
      trace.framePresentedAtMs = performance.now();
      const frameDelayMs = trace.framePresentedAtMs - trace.playbackObservedAtMs;
      toneFramePoint.textContent = `已送入屏幕帧 · Δ ${formatMs(frameDelayMs)}`;
      logToneTrace(active, trace);
    });
  }
}

function finishToneAcceptance(active: ToneAcceptanceRun): void {
  if (toneAcceptance !== active) return;
  const player = evaluateKnownToneAcceptance(active.playerLevels);
  const model = evaluateKnownToneAcceptance(active.modelLevels);
  const response = evaluateKnownToneResponseTiming(active.traces);
  const passed = player.passed && model.passed && response.passed;
  const metrics = { passed, player, model, response };
  document.body.dataset.toneAcceptance = passed ? 'passed' : 'failed';
  document.body.dataset.toneAcceptanceMetrics = JSON.stringify(metrics);
  toneAcceptance = null;
  if (passed) {
    const maximumTimingError = Math.max(...player.transitionErrorsMs, ...model.transitionErrorsMs);
    status.textContent = `口型同步验收通过 · 时轴 ${Math.round(maximumTimingError)} ms · 参数 ${formatMs(response.maximumModelResponseMs ?? 0)} · 屏幕帧 ${formatMs(response.maximumFrameResponseMs ?? 0)}`;
  }
  else status.textContent = `口型同步验收失败：${[...player.issues, ...model.issues, ...response.issues].join('；')}`;
  console.info(JSON.stringify({ event: 'tone.sync.result', ...metrics }));
}

function failToneAcceptance(message: string): void {
  document.body.dataset.toneAcceptance = 'failed';
  document.body.dataset.toneAcceptanceMetrics = JSON.stringify({ passed: false, issues: [message] });
  toneAcceptance = null;
  pendingToneTraces.length = 0;
  status.textContent = `口型同步验收失败：${message}`;
  toneFramePoint.textContent = `失败 · ${message}`;
}

function logToneTrace(active: ToneAcceptanceRun, trace: ToneSyncTrace): void {
  const bucket = Math.floor(trace.atMs / 100);
  const phase = tonePhase(trace.atMs);
  if (bucket === active.lastLoggedBucket && phase === active.lastLoggedPhase) return;
  active.lastLoggedBucket = bucket;
  active.lastLoggedPhase = phase;
  const modelDelayMs = trace.modelAppliedAtMs === undefined ? null : trace.modelAppliedAtMs - trace.playbackObservedAtMs;
  const frameDelayMs = trace.framePresentedAtMs === undefined ? null : trace.framePresentedAtMs - trace.playbackObservedAtMs;
  const entry = document.createElement('li');
  entry.textContent = `${formatMs(trace.atMs)} ${phase} · L ${trace.level.toFixed(2)} → ParamA ${(trace.modelValue ?? 0).toFixed(2)} · 参数 ${formatMs(modelDelayMs ?? 0)} / 帧 ${formatMs(frameDelayMs ?? 0)}`;
  toneSyncLog.append(entry);
  while (toneSyncLog.children.length > 12) toneSyncLog.firstElementChild?.remove();
  toneSyncLog.scrollTop = toneSyncLog.scrollHeight;
  console.info(JSON.stringify({
    event: 'tone.sync.trace', timestamp: new Date().toISOString(), audioPositionMs: trace.atMs,
    phase, playbackLevel: trace.level, modelValue: trace.modelValue,
    modelResponseMs: modelDelayMs, frameResponseMs: frameDelayMs,
  }));
}

function tonePhase(positionMs: number): string {
  const pulseIndex = KNOWN_TONE_PULSES.findIndex(pulse => positionMs >= pulse.startMs && positionMs < pulse.endMs);
  return pulseIndex < 0 ? '静音' : `提示音 ${pulseIndex + 1}`;
}

function formatMs(value: number): string { return `${value.toFixed(1)}ms`; }

function afterRenderedFrames(count: number, callback: () => void): void {
  if (count <= 0) return callback();
  app.renderer.once('postrender', () => afterRenderedFrames(count - 1, callback));
}

function stopCurrentMotion(state: 'interrupted' | 'replaced'): void {
  motionRequestToken++;
  if (motionTimer) clearTimeout(motionTimer);
  motionTimer = undefined;
  model?.internalModel.motionManager.stopAllMotions();
  if (document.body.dataset.motionState === 'playing' || document.body.dataset.motionState === 'starting') {
    document.body.dataset.motionState = state;
  }
}

function clearPlayback(): void { if (playbackTimer) clearInterval(playbackTimer); playbackTimer = undefined; }
function sampleAmplitude(samples: Array<{ atMs: number; value: number }> | undefined, positionMs: number): number {
  if (!samples?.length) return 0.25 + Math.abs(Math.sin(positionMs / 90)) * 0.5;
  let value = samples[0]!.value;
  for (const sample of samples) {
    if (sample.atMs > positionMs) break;
    value = sample.value;
  }
  return value;
}
function coreModel(target: Live2DModel): CubismCoreModel { return target.internalModel.coreModel as CubismCoreModel; }
function fitModel(): void {
  if (!model) return;
  const scale = Math.min(innerWidth / model.width * 0.7, innerHeight / model.height * 0.82);
  model.scale.set(scale); model.anchor.set(0.5, 0.5); model.position.set(innerWidth * 0.68, innerHeight * 0.5);
}
