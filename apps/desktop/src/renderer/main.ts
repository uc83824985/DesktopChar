import { ShaderSystem } from '@pixi/core';
import { install as installCspShaderCompiler } from '@pixi/unsafe-eval';
import { Application, Renderer, Ticker } from 'pixi.js';
import { Live2DModel, MotionPriority } from 'pixi-live2d-display/cubism4';
import { DEFAULT_LIP_SYNC_PROFILE } from '../../../../packages/contracts/src/index.ts';
import type { AvatarEvent, LipSyncProfile, RuntimeEffect, SpeechBubbleMode } from '../../../../packages/contracts/src/index.ts';
import type { AmplitudeSample } from '../../../../packages/contracts/src/index.ts';
import {
  KNOWN_TONE_PULSES,
  WebAudioPcmStreamPlayer,
  evaluateKnownToneAcceptance,
  evaluateKnownToneResponseTiming,
} from '../../../../packages/audio-runtime/src/index.ts';
import type { KnownToneResponseTrace, PcmStreamResolver } from '../../../../packages/audio-runtime/src/index.ts';
import { AvatarRuntime, DefaultAvatarPlanner, ParameterMixer, projectSpeechBubble } from '../../../../packages/avatar-runtime/src/index.ts';
import {
  DEFAULT_CHARACTER_PROFILE_URL,
  DEFAULT_TTS_CONFIG,
  loadCharacterConfig,
} from '../../../../packages/config/src/index.ts';
import {
  AsyncPixelCoveragePicker,
  HoldDragController,
  PixelCoverageLatch,
  RuntimeParameterFrame,
  WebGLPixelReadbackBackend,
} from '../../../../packages/live2d-renderer/src/index.ts';
import type { PixelCoverageResult } from '../../../../packages/live2d-renderer/src/index.ts';
import {
  DomContextMenuHost,
  ImmediateUiRegistry,
  formatChatBubbleFragment,
} from '../../../../packages/scene-ui-dom/src/index.ts';
import type {
  McpCallOptions,
  McpCallToolResult,
  McpClientPort,
  TtsAdapter,
  TtsCapabilities,
  TtsHealthReport,
  TtsSynthesisRequest,
} from '../../../../packages/tts-mcp-adapter/src/index.ts';
import { JsonConsoleTtsLogger, McpTtsAdapter, TtsRuntimeEffectHandler } from '../../../../packages/tts-mcp-adapter/src/index.ts';
import './style.css';
import type {
  DesktopTtsConfig,
  McpServiceId,
  McpServiceState,
  McpServiceTest,
  McpServicesState,
  PointerPresentation,
} from '../preload/desktop-api.d.ts';

installCspShaderCompiler({ ShaderSystem });
Live2DModel.registerTicker(Ticker);
const desktopShell = window.desktopChar;
if (desktopShell) {
  document.documentElement.dataset.shell = 'floating';
  document.body.dataset.shell = 'floating';
}
const canvas = document.querySelector<HTMLCanvasElement>('#avatar')!;
const speechBubble = document.querySelector<HTMLElement>('#speech-bubble')!;
const speechBubbleLeading = document.querySelector<HTMLElement>('#speech-bubble-leading')!;
const speechBubbleActive = document.querySelector<HTMLElement>('#speech-bubble-active')!;
const speechBubbleTrailing = document.querySelector<HTMLElement>('#speech-bubble-trailing')!;
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
  lipSyncProfile: LipSyncProfile;
  playerLevels: AmplitudeSample[];
  modelLevels: AmplitudeSample[];
  traces: ToneSyncTrace[];
  lastLoggedBucket: number;
  lastLoggedPhase: string;
}

class ReloadableTtsAdapter implements TtsAdapter {
  private current: { adapter: TtsAdapter; defaults: Pick<TtsSynthesisRequest, 'voice' | 'format'> } | undefined;
  private enabled = false;

  configure(adapter: TtsAdapter, config: DesktopTtsConfig, enabled: boolean): void {
    this.current = {
      adapter,
      defaults: {
        ...(config.voice ? { voice: config.voice } : {}),
        ...(config.format ? { format: config.format } : {}),
      },
    };
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async prepare(request: TtsSynthesisRequest) {
    const current = this.requireCurrent();
    return await current.adapter.prepare({ ...request, ...current.defaults });
  }

  async cancel(requestId: string): Promise<void> {
    await this.requireCurrent().adapter.cancel(requestId);
  }

  async capabilities(): Promise<TtsCapabilities> {
    return await this.requireCurrent().adapter.capabilities();
  }

  health(): Promise<TtsHealthReport> {
    if (!this.current || !this.enabled) return Promise.resolve({
      status: 'unavailable', provider: 'desktop-char-mcp-services', latencyMs: 0, details: '语音合成 MCP 服务未启用',
    });
    return this.current.adapter.health();
  }

  private requireCurrent() {
    if (!this.current || !this.enabled) throw new Error('语音合成 MCP 服务未就绪');
    return this.current;
  }
}

let model: Live2DModel | undefined;
let runtime: AvatarRuntime | undefined;
let playbackTimer: ReturnType<typeof setInterval> | undefined;
let motionTimer: ReturnType<typeof setTimeout> | undefined;
let motionRequestToken = 0;
let toneAcceptance: ToneAcceptanceRun | null = null;
let applyingToneTrace: ToneSyncTrace | null = null;
let knownToneAvailable = false;
let mcpServicesState: McpServicesState | undefined;
let ttsConfigSignature = '';
const reloadableTtsAdapter = new ReloadableTtsAdapter();
let currentLipSyncProfile: LipSyncProfile = { ...DEFAULT_LIP_SYNC_PROFILE };
let desktopBounds: { x: number; y: number; width: number; height: number } | undefined;
let pointerPresentation: PointerPresentation | undefined;
let pixelPicker: AsyncPixelCoveragePicker | undefined;
let pixelSelection: PixelCoverageResult | undefined;
let pixelCursorPoint: { x: number; y: number } | undefined;
let webglContextLosses = 0;
const pendingToneTraces: ToneSyncTrace[] = [];
const knownToneSegments = new Set<string>();
const pixelCoverageLatch = new PixelCoverageLatch({ coveredSamplesToSelect: 1, transparentSamplesToClear: 3 });
const dragGesture = new HoldDragController<string>({
  holdDelayMs: 240,
  callbacks: {
    onPhaseChanged(phase) {
      if (phase === 'pending') {
        document.body.dataset.dragState = 'pending';
      }
      else if (phase === 'starting') {
        document.body.dataset.dragState = 'starting';
      }
      else if (phase === 'dragging') document.body.dataset.dragState = 'armed';
    },
    async onHoldStarted(origin) {
      if (!desktopShell) throw new Error('Desktop shell is unavailable');
      updatePointerPresentation({ passthrough: false, cursor: 'move' }, false);
      await desktopShell.beginDrag(origin);
      // Do not mutate the transparent HWND bounds until Pixi has presented a
      // complete frame after drag entry. This keeps the first move from racing
      // the cursor/style transition and exposing an unpainted compositor frame.
      await nextRenderedFrame();
      // beginDrag records the move intent without refreshing Windows' cursor.
      // Re-submit the same single-source presentation after the safe frame so
      // main can force the native cursor before the first accumulated move.
      publishPointerPresentation({ passthrough: false, cursor: 'move' });
    },
    onDragMoved(point) {
      document.body.dataset.dragState = 'moving';
      desktopShell?.dragTo(point);
    },
    async onDragFinished(result) {
      document.body.dataset.dragState = result.cancelled ? 'cancelled' : result.moved ? 'moved' : 'held';
      const presentation = selectionPresentation();
      updatePointerPresentation(presentation, false);
      await desktopShell?.endDrag();
      publishPointerPresentation(pointerPresentation ?? presentation);
    },
    onClicked(hitArea) {
      document.body.dataset.dragState = 'clicked';
      document.body.dataset.lastAvatarClick = hitArea;
      runtime?.dispatch({ type: 'user.avatar-clicked', hitArea });
    },
    onPendingCancelled() {
      document.body.dataset.dragState = 'cancelled';
    },
    onError(error, pointerId) {
      if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
      document.body.dataset.dragState = 'failed';
      const presentation = selectionPresentation();
      updatePointerPresentation(presentation, false);
      void desktopShell?.endDrag()
        .then(() => publishPointerPresentation(pointerPresentation ?? presentation))
        .catch(() => publishPointerPresentation(pointerPresentation ?? presentation));
      console.error('Avatar drag failed', error);
    },
  },
});
const immediateUi = new ImmediateUiRegistry();
const contextMenuHost = new DomContextMenuHost(immediateUi, {
  onVisibilityChanged(visible) {
    document.body.dataset.contextMenu = visible ? 'open' : 'closed';
    if (!desktopShell) return;
    if (visible) {
      pixelPicker?.invalidate();
      pixelSelection = undefined;
      pixelCursorPoint = undefined;
      pixelCoverageLatch.reset();
      updatePointerPresentation({ passthrough: false, cursor: 'default' });
    }
    else updatePointerPresentation(selectionPresentation());
  },
});
document.body.dataset.contextMenu = 'closed';
document.body.dataset.webglContextLosses = '0';
const runtimeFrame = new RuntimeParameterFrame({
  aliases: { ParamMouthOpenY: 'ParamA', ParamMouthForm: 'ParamMouthUp' },
});
let ttsEffects: TtsRuntimeEffectHandler | undefined;
let audioPlayer: WebAudioPcmStreamPlayer | undefined;
const speechBubbleDismissTimers = new Map<number, ReturnType<typeof setTimeout>>();
document.body.dataset.toneAcceptance = 'idle';

function handleTonePlaybackEvent(event: AvatarEvent): void {
  if (!isPlaybackEvent(event)) return;
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
}

try {
  const shellState = desktopShell ? await desktopShell.ready() : undefined;
  const characterConfig = await loadCharacterConfig(
    shellState?.character.profileUrl ?? DEFAULT_CHARACTER_PROFILE_URL,
  );
  const tts = createTtsComposition(shellState?.tts);
  mcpServicesState = shellState?.mcpServices;
  const ttsOperational = desktopShell ? isOperationalMcpService(mcpServicesState?.tts) : true;
  reloadableTtsAdapter.configure(tts.adapter, shellState?.tts ?? browserTtsConfig(), ttsOperational);
  currentLipSyncProfile = characterConfig.lipSyncProfile;
  knownToneAvailable = tts.supportsKnownToneFixture && ttsOperational;
  if (!knownToneAvailable) tone.title = '先验铃声验收仅由 local-tts-mcp 参考服务提供';
  ttsEffects = new TtsRuntimeEffectHandler(reloadableTtsAdapter);
  audioPlayer = createRuntimeAudioPlayer(tts.openStream);
  audioPlayer.subscribe(handleTonePlaybackEvent);
  document.body.dataset.ttsMode = shellState?.tts.mode ?? 'local';
  document.body.dataset.ttsHealth = 'checking';

  model = await Live2DModel.from(characterConfig.modelJsonUrl, { autoInteract: false });
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
    gazeProfile: characterConfig.gazeProfile,
    lipSyncProfile: characterConfig.lipSyncProfile,
  });
  runtime.dispatch({ type: 'renderer.ready', capabilities: {
    emotions: characterConfig.allowedEmotions,
    actions: characterConfig.allowedActions,
    parameters: [
      'ParamA', 'ParamMouthOpenY', 'ParamMouthForm',
      'ParamAngleX', 'ParamAngleY', 'ParamEyeBallX', 'ParamEyeBallY',
    ],
    supportsMouthForm: true, supportsGaze: true, supportsHitTest: true,
  } });
  runtime.subscribe(snapshot => {
    desktopShell?.publishAgentState({ ready: true, snapshot });
    document.body.dataset.runtimeState = snapshot.state;
    document.body.dataset.gazeFollow = snapshot.gaze.active ? 'enabled' : 'disabled';
    const busy = snapshot.state !== 'idle';
    speak.disabled = busy || !isOperationalMcpService();
    motion.disabled = busy;
    tone.disabled = busy || !knownToneAvailable || !isOperationalMcpService();
    reset.disabled = false;
    gaze.disabled = !(snapshot.capabilities?.supportsGaze ?? false);
    gaze.textContent = snapshot.gaze.active ? '眼部跟随：开' : '眼部跟随：关';
    gaze.setAttribute('aria-pressed', String(snapshot.gaze.active));
    status.textContent = snapshot.state === 'speaking'
      ? `Runtime: speaking · ${Math.round(snapshot.playback.positionMs)} ms`
      : snapshot.state === 'presenting'
        ? 'Runtime: presenting · 语音合成不可用，正在显示纯文本回退'
        : 'Runtime 已就绪 · UI 仅发送事件，状态由 Runtime 持有';
    renderSpeechBubble(snapshot);
    contextMenuHost.refresh();
  });
  void reloadableTtsAdapter.health().then(report => {
    document.body.dataset.ttsHealth = report.status;
  }).catch(error => {
    document.body.dataset.ttsHealth = 'unavailable';
    console.error('[tts] health check failed', error);
  });

  desktopShell?.onAgentCommand(command => {
    if (!runtime) return;
    try {
      if (command.type === 'performance.submit') runtime.dispatch({ type: 'plan.submitted', plan: command.plan });
      else runtime.dispatch({ type: 'user.interrupt-requested' });
    }
    catch (error) {
      console.error('[agent-http] command rejected', error);
      desktopShell.publishAgentState({ ready: true, snapshot: runtime.getSnapshot() });
    }
  });

  if (desktopShell) initializeDesktopInteraction(shellState);
  else window.addEventListener('pointermove', event => runtime?.dispatch({
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
  registerDevelopmentUi();
  canvas.addEventListener('contextmenu', openAvatarContextMenu);
  canvas.addEventListener('keydown', event => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    contextMenuHost.open({
      targetId: 'avatar',
      clientX: Math.round(innerWidth / 2),
      clientY: Math.round(innerHeight / 2),
      data: { source: 'keyboard' },
    });
  });

  desktopShell?.onMcpServicesState(state => applyMcpServicesState(state));
  if (mcpServicesState) applyMcpServicesState(mcpServicesState);
  void desktopShell?.getMcpServicesState().then(state => applyMcpServicesState(state));
  window.addEventListener('beforeunload', () => {
    contextMenuHost.dispose();
    for (const timer of speechBubbleDismissTimers.values()) clearTimeout(timer);
    speechBubbleDismissTimers.clear();
  }, { once: true });

  document.body.dataset.ready = 'true';
}
catch (error) {
  const failedSnapshot = {
    state: 'idle' as const,
    generation: 0,
    planId: null,
    segmentId: null,
    sequence: null,
    playback: { status: 'idle' as const, positionMs: 0 },
    speechBubble: {
      phase: 'hidden' as const, presentationId: 0, segmentId: null, displayText: '', positionMs: 0,
    },
    emotion: { current: 'neutral' as const, intensity: 0 },
    gesture: { actionId: null, action: null, queueLength: 0 },
    gaze: { x: 0, y: 0, active: false },
    interrupted: false,
    capabilities: null,
    lastError: { code: 'renderer-startup-failed', message: error instanceof Error ? error.message : String(error), recoverable: false },
  };
  desktopShell?.publishAgentState({ ready: false, snapshot: failedSnapshot });
  void desktopShell?.ready().catch(() => undefined);
  status.textContent = `加载失败：${error instanceof Error ? error.message : String(error)}`;
  document.body.dataset.ready = 'false';
  console.error(error);
}

function submitToneAcceptance(): void {
  if (!knownToneAvailable || !runtime || runtime.getSnapshot().state !== 'idle') return;
  const suffix = Date.now();
  const segmentId = `known-tone-${suffix}`;
  knownToneSegments.add(segmentId);
  toneAcceptance = {
    segmentId, lipSyncProfile: { ...currentLipSyncProfile }, playerLevels: [], modelLevels: [], traces: [],
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
    id: segmentId, sequence: 0, displayText: '先验铃声口型同步验收', speechText: '口型同步测试。',
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
  if (ttsEffects?.handle(effect, dispatch)) return;
  if (effect.type === 'speech-bubble.schedule-dismiss') {
    const existing = speechBubbleDismissTimers.get(effect.presentationId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      speechBubbleDismissTimers.delete(effect.presentationId);
      dispatch({
        type: 'runtime.speech-bubble-dismissed',
        generation: effect.generation,
        presentationId: effect.presentationId,
      });
    }, effect.delayMs);
    speechBubbleDismissTimers.set(effect.presentationId, timer);
  }
  else if (effect.type === 'speech-bubble.cancel-dismiss') {
    const timer = speechBubbleDismissTimers.get(effect.presentationId);
    if (timer) clearTimeout(timer);
    speechBubbleDismissTimers.delete(effect.presentationId);
  }
  else if (effect.type === 'audio.play') {
    if (effect.source.delivery === 'stream' && effect.source.codec === 'pcm_s16le') {
      return void audioPlayer?.play(effect.generation, effect.segmentId, effect.source).catch(error => {
        if (knownToneSegments.has(effect.segmentId)) failToneAcceptance(error instanceof Error ? error.message : String(error));
        dispatch({
          type: 'playback.failed', generation: effect.generation, segmentId: effect.segmentId,
          error: { code: 'pcm-playback-failed', message: error instanceof Error ? error.message : String(error), recoverable: true },
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
  else if (effect.type === 'audio.pause') {
    audioPlayer?.pause(effect.generation);
  }
  else if (effect.type === 'audio.resume') {
    audioPlayer?.resume(effect.generation);
  }
  else if (effect.type === 'audio.stop') {
    clearPlayback();
    stopCurrentMotion('interrupted');
    void audioPlayer?.stop(effect.generation);
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

interface TtsComposition {
  adapter: TtsAdapter;
  openStream: PcmStreamResolver;
  supportsKnownToneFixture: boolean;
}

function applyMcpServicesState(next: McpServicesState): void {
  mcpServicesState = next;
  const config = next.tts.runtimeConfig;
  const operational = isOperationalMcpService(next.tts);
  if (config) {
    const signature = JSON.stringify(config);
    if (signature !== ttsConfigSignature) {
      const composition = createTtsComposition(config);
      reloadableTtsAdapter.configure(composition.adapter, config, operational);
      ttsConfigSignature = signature;
    }
    else reloadableTtsAdapter.setEnabled(operational);
    knownToneAvailable = config.mode === 'local' && operational;
    document.body.dataset.ttsMode = config.mode;
  }
  else {
    reloadableTtsAdapter.setEnabled(false);
    knownToneAvailable = false;
  }
  document.body.dataset.ttsMcpService = next.tts.phase;
  document.body.dataset.characterMcpService = next.character.phase;
  document.body.dataset.mcpConfigRevision = String(next.config.revision);
  document.body.dataset.mcpConfigStatus = next.config.status;
  document.body.dataset.ttsMcpTest = next.tts.lastTest?.status ?? 'untested';
  document.body.dataset.characterMcpTest = next.character.lastTest?.status ?? 'untested';
  document.body.dataset.ttsHealth = operational ? next.tts.phase : 'unavailable';
  tone.title = knownToneAvailable ? '' : '先验铃声验收仅由已连接的 local-tts-mcp 参考服务提供';
  const busy = runtime?.getSnapshot().state !== 'idle';
  speak.disabled = busy || !operational;
  tone.disabled = busy || !knownToneAvailable;
  contextMenuHost.refresh();
}

function isOperationalMcpService(service: McpServiceState | undefined = mcpServicesState?.tts): boolean {
  if (!desktopShell) return true;
  return service?.desiredEnabled === true
    && (service.phase === 'ready' || service.phase === 'degraded' || service.phase === 'reload-pending');
}

function createTtsComposition(config: DesktopTtsConfig | undefined): TtsComposition {
  const logger = new JsonConsoleTtsLogger();
  const settings = config ?? browserTtsConfig();
  const baseClient = desktopShell
    ? createDesktopShellMcpClient(desktopShell)
    : createBrowserMcpClient(settings.mcpUrl);
  const supportsKnownToneFixture = settings.mode === 'local';
  const client = supportsKnownToneFixture
    ? createKnownToneFixtureMcpClient(baseClient, settings)
    : baseClient;
  const adapter = new McpTtsAdapter({
    client,
    toolName: settings.mcpTool,
    cancelToolName: settings.mcpCancelTool,
    timeoutMs: settings.timeoutMs,
    requestIdArgument: settings.requestIdArgument,
    textArgument: settings.textArgument,
    providerName: settings.mode === 'local' ? 'desktop-char-local-tts' : 'qwen3-tts-mcp',
    formats: [settings.format],
    deliveryModes: ['stream'],
    supportsAmplitude: false,
    supportsTextCues: false,
    logger,
  });
  return {
    adapter,
    openStream: (source, signal) => openHttpByteStream(source.uri, signal),
    supportsKnownToneFixture,
  };
}

function createKnownToneFixtureMcpClient(
  client: McpClientPort,
  config: DesktopTtsConfig,
): McpClientPort {
  return {
    listTools: options => client.listTools(options),
    callTool(name, args, options) {
      const requestId = args[config.requestIdArgument];
      const segmentId = typeof requestId === 'string' ? segmentIdFromRequestId(requestId) : '';
      return client.callTool(name, name === config.mcpTool && knownToneSegments.has(segmentId)
        ? { ...args, test_fixture: 'known-tone-v1' }
        : args, options);
    },
  };
}

function browserTtsConfig(): DesktopTtsConfig {
  const configuredUrl = new URLSearchParams(location.search).get('ttsMcpUrl') ?? 'http://127.0.0.1:8766/mcp';
  const url = new URL(configuredUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('Browser test TTS MCP URL must use a loopback HTTP origin');
  }
  return {
    mode: 'local',
    mcpUrl: url.href,
    mcpTool: DEFAULT_TTS_CONFIG.mcp.toolName,
    mcpCancelTool: DEFAULT_TTS_CONFIG.mcp.cancelToolName,
    timeoutMs: DEFAULT_TTS_CONFIG.mcp.timeoutMs,
    requestIdArgument: DEFAULT_TTS_CONFIG.mcp.requestIdArgument,
    textArgument: DEFAULT_TTS_CONFIG.mcp.textArgument,
    format: DEFAULT_TTS_CONFIG.mcp.format,
  };
}

function createBrowserMcpClient(url: string): McpClientPort {
  const transport = createBrowserStreamableHttpMcpClient(url);
  return {
    async listTools(options) {
      const result = await transport.request('tools/list', {}, options?.timeoutMs ?? 30_000, options?.signal);
      if (!isRecord(result) || !Array.isArray(result.tools)) throw new Error('MCP tools/list response is malformed');
      return result.tools as Awaited<ReturnType<McpClientPort['listTools']>>;
    },
    async callTool(name, args, options) {
      return await transport.request('tools/call', { name, arguments: args }, options.timeoutMs, options.signal) as unknown as McpCallToolResult;
    },
  };
}

function createBrowserStreamableHttpMcpClient(url: string) {
  let sessionId: string | undefined;
  let initialized: Promise<void> | undefined;
  let nextId = 1;

  async function request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await ensureInitialized(timeoutMs, signal);
    const response = await post({ jsonrpc: '2.0', id: nextId++, method, params }, timeoutMs, signal);
    if (!isRecord(response) || !isRecord(response.result)) throw new Error(`MCP ${method} response has no result`);
    return response.result;
  }

  async function ensureInitialized(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (!initialized) initialized = (async () => {
      const response = await post({
        jsonrpc: '2.0', id: nextId++, method: 'initialize', params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'desktop-char-browser', version: '0.1.0' },
        },
      }, timeoutMs, signal);
      if (!isRecord(response) || !isRecord(response.result)) throw new Error('MCP initialize response is malformed');
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, timeoutMs, signal, false);
    })().catch(error => {
      sessionId = undefined;
      initialized = undefined;
      throw error;
    });
    return initialized;
  }

  async function post(
    message: Record<string, unknown>,
    timeoutMs: number,
    externalSignal?: AbortSignal,
    expectsBody = true,
  ): Promise<Record<string, unknown> | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('MCP request timed out', 'TimeoutError')), timeoutMs);
    const abort = () => controller.abort(externalSignal?.reason ?? new DOMException('MCP request aborted', 'AbortError'));
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-11-25' } : {}),
        },
        body: JSON.stringify(message),
        signal: controller.signal,
        cache: 'no-store',
      });
      const initializedSessionId = response.headers.get('mcp-session-id');
      if (initializedSessionId) sessionId = initializedSessionId;
      if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
      if (!expectsBody || response.status === 202) return undefined;
      const payload = await parseMcpHttpResponse(response);
      if (isRecord(payload.error)) throw new Error(`MCP error: ${String(payload.error.message ?? 'unknown error')}`);
      return payload;
    }
    finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
    }
  }
  return { request };
}

async function parseMcpHttpResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const data = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split(/\r?\n/).find(line => line.startsWith('data:'))?.slice(5).trim()
    : text;
  const value: unknown = JSON.parse(data ?? 'null');
  if (!isRecord(value)) throw new Error('MCP HTTP response is not a JSON-RPC object');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function segmentIdFromRequestId(requestId: string): string {
  const separator = requestId.indexOf(':');
  return separator < 0 ? requestId : requestId.slice(separator + 1);
}

function createDesktopShellMcpClient(shell: NonNullable<typeof desktopShell>): McpClientPort {
  return {
    listTools(options?: { signal?: AbortSignal; timeoutMs?: number }) {
      throwIfAborted(options?.signal);
      return shell.listTtsMcpTools();
    },
    callTool(name: string, args: Record<string, unknown>, options: McpCallOptions) {
      throwIfAborted(options.signal);
      return shell.callTtsMcpTool(name, args, { timeoutMs: options.timeoutMs });
    },
  };
}

function createRuntimeAudioPlayer(openStream: PcmStreamResolver): WebAudioPcmStreamPlayer {
  return new WebAudioPcmStreamPlayer({
    initialBufferMs: 100, levelIntervalMs: 25, levelWindowMs: 20,
    openStream,
  });
}

async function openHttpByteStream(uri: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
  const response = await fetch(uri, { signal, cache: 'no-store' });
  if (!response.ok || !response.body) throw new Error(`PCM stream failed: HTTP ${response.status}`);
  return readByteStream(response.body);
}

async function* readByteStream(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  }
  finally {
    reader.releaseLock();
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('MCP request aborted', 'AbortError');
}

function isPlaybackEvent(event: AvatarEvent): event is Extract<AvatarEvent, { type: `playback.${string}` }> {
  return event.type.startsWith('playback.');
}

function submitBubbleDemo(mode: SpeechBubbleMode): void {
  if (!runtime || runtime.getSnapshot().state !== 'idle') return;
  const suffix = Date.now();
  const displayText = mode === 'complete'
    ? '完整显示：文本会立即完整出现。'
    : mode === 'stream'
      ? '流式显示：文本会跟随播放进度逐步出现，并保持稳定的自动换行。'
      : 'KTV 高亮会随播放时点移动。完整文本保持稳定换行布局。';
  runtime.dispatch({ type: 'plan.submitted', plan: { id: `bubble-${mode}-${suffix}`, segments: [{
    id: `bubble-segment-${suffix}`,
    sequence: 0,
    displayText,
    speechText: displayText,
    bubble: mode === 'karaoke' ? {
      mode,
      cues: [
        { text: 'KTV 高亮', atMs: 0, durationMs: 550 },
        { text: '会随播放时点', atMs: 550, durationMs: 650 },
        { text: '移动。', atMs: 1_200, durationMs: 500 },
        { text: '完整文本保持', atMs: 1_700, durationMs: 700 },
        { text: '稳定换行布局。', atMs: 2_400, durationMs: 700 },
      ],
    } : mode === 'stream' ? { mode, charactersPerSecond: 12 } : { mode },
  }] } });
}

function registerDevelopmentUi(): void {
  immediateUi.register({
    id: 'avatar.runtime-settings',
    target: 'avatar',
    order: 10,
    build: () => {
      const snapshot = runtime?.getSnapshot();
      return {
        label: '角色设置',
        items: [
          {
            type: 'checkbox', id: 'gaze-follow', label: '眼部跟随',
            checked: snapshot?.gaze.active ?? false,
            enabled: snapshot?.capabilities?.supportsGaze ?? false,
            invoke: enabled => runtime?.dispatch({
              type: enabled ? 'user.gaze-follow-enabled' : 'user.gaze-follow-disabled',
            }),
          },
        ],
      };
    },
  });
  immediateUi.register({
    id: 'avatar.bubble-diagnostics',
    target: 'avatar',
    order: 20,
    build: () => {
      const enabled = runtime?.getSnapshot().state === 'idle';
      return {
        label: '聊天气泡测试',
        items: [
          { type: 'action', id: 'complete', label: '完整显示', enabled, invoke: () => submitBubbleDemo('complete') },
          { type: 'action', id: 'stream', label: '流式显示', enabled, invoke: () => submitBubbleDemo('stream') },
          { type: 'action', id: 'karaoke', label: 'KTV 高亮', enabled, invoke: () => submitBubbleDemo('karaoke') },
        ],
      };
    },
  });
  if (desktopShell) immediateUi.register({
    id: 'desktop.mcp-services',
    target: '*',
    order: 900,
    build: () => {
      const services = mcpServicesState;
      if (!services) return null;
      const runtimeIdle = runtime?.getSnapshot().state === 'idle';
      return {
        label: 'MCP 服务',
        items: [
          {
            type: 'checkbox', id: 'character-mcp-enabled',
            label: `角色接入 MCP · ${mcpPhaseLabel(services.character)}`,
            checked: services.character.desiredEnabled,
            enabled: !mcpTransitioning(services.character),
            invoke: enabled => setMcpServiceEnabled('character', enabled),
          },
          {
            type: 'checkbox', id: 'tts-mcp-enabled',
            label: `语音合成 MCP · ${mcpPhaseLabel(services.tts)}`,
            checked: services.tts.desiredEnabled,
            enabled: runtimeIdle && !mcpTransitioning(services.tts),
            invoke: enabled => setMcpServiceEnabled('tts', enabled),
          },
          {
            type: 'action', id: 'mcp-connection-test',
            label: '测试 MCP 连接',
            enabled: runtimeIdle
              && !mcpTransitioning(services.character)
              && !mcpTransitioning(services.tts),
            invoke: testAllMcpServices,
          },
        ],
      };
    },
  });
  if (desktopShell) immediateUi.register({
    id: 'desktop.application-config',
    target: '*',
    order: 950,
    build: () => {
      const services = mcpServicesState;
      if (!services) return null;
      const status = services.config.status === 'error'
        ? `r${services.config.revision} · 错误`
        : `r${services.config.revision}`;
      return {
        label: `应用配置 · ${status}`,
        items: [{
          type: 'action', id: 'desktop-config-reload',
          label: '重新加载配置',
          enabled: !mcpTransitioning(services.character) && !mcpTransitioning(services.tts),
          invoke: reloadDesktopConfig,
        }],
      };
    },
  });
  if (desktopShell) immediateUi.register({
    id: 'desktop.window-settings',
    target: '*',
    order: 1_000,
    build: () => ({
      label: '桌面窗口',
      items: [
        { type: 'action', id: 'hide-avatar', label: '隐藏角色', invoke: () => desktopShell.runWindowCommand('hide-avatar') },
        { type: 'action', id: 'restore-position', label: '恢复默认位置', invoke: () => desktopShell.runWindowCommand('restore-default-position') },
        { type: 'action', id: 'quit', label: '退出 DesktopChar', danger: true, invoke: () => desktopShell.runWindowCommand('quit') },
      ],
    }),
  });
}

async function setMcpServiceEnabled(service: McpServiceId, enabled: boolean): Promise<void> {
  if (!desktopShell) return;
  applyMcpServicesState(await desktopShell.setMcpServiceEnabled(service, enabled));
}

async function testAllMcpServices(): Promise<void> {
  if (!desktopShell) return;
  const results = await desktopShell.testAllMcpServices();
  applyMcpServicesState(await desktopShell.getMcpServicesState());
  runtime?.dispatch({
    type: 'presentation.chat-bubble-requested',
    text: `MCP 连接测试：${formatMcpTestResult('角色接入 MCP', results.character)}。`
      + `${formatMcpTestResult('语音合成 MCP', results.tts)}。`,
    dismissDelayMs: 4_500,
  });
}

async function reloadDesktopConfig(): Promise<void> {
  if (!desktopShell) return;
  const previousRevision = mcpServicesState?.config.revision;
  try {
    const next = await desktopShell.reloadDesktopConfig();
    applyMcpServicesState(next);
    const revisionStatus = previousRevision === undefined || next.config.revision !== previousRevision
      ? '已更新'
      : '无变化';
    showConfigNotification(
      `配置重新加载完成：r${next.config.revision}（${revisionStatus}）。`
      + `${formatMcpServiceState('角色接入 MCP', next.character)}。`
      + `${formatMcpServiceState('语音合成 MCP', next.tts)}。`,
    );
  }
  catch (error) {
    let current = mcpServicesState;
    try {
      current = await desktopShell.getMcpServicesState();
      applyMcpServicesState(current);
    }
    catch {
      // Preserve the last renderer snapshot when the follow-up state request also fails.
    }
    const details = summarizeMcpDetails(current?.config.error ?? error);
    const serviceStatus = current
      ? `。现有${formatMcpServiceState('角色接入 MCP', current.character)}`
        + `。${formatMcpServiceState('语音合成 MCP', current.tts)}`
      : '';
    showConfigNotification(`配置重新加载失败：${details}${serviceStatus}。`);
  }
}

function mcpTransitioning(service: McpServiceState): boolean {
  return ['starting', 'reloading', 'stopping'].includes(service.phase);
}

function mcpPhaseLabel(service: McpServiceState): string {
  const labels: Record<McpServiceState['phase'], string> = {
    disabled: '已禁用', starting: '启动中', ready: '已连接', degraded: '可用（契约不完整）',
    'reload-pending': '等待空闲后重载', reloading: '重载中', reconnecting: `重连中 #${service.reconnectAttempt}`,
    stopping: '停止中',
  };
  return labels[service.phase];
}

function formatMcpTestResult(label: string, result: McpServiceTest): string {
  if (result.status === 'passed') return `${label}：通过（${result.latencyMs} ms）`;
  if (/service is disabled|服务未启用/i.test(result.details)) return `${label}：未启用`;
  return `${label}：失败（${summarizeMcpDetails(result.details)}）`;
}

function formatMcpServiceState(label: string, service: McpServiceState): string {
  return `${label}：${mcpPhaseLabel(service)}`;
}

function summarizeMcpDetails(details: unknown): string {
  const text = (details instanceof Error ? details.message : String(details ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '未知错误';
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function showConfigNotification(text: string): void {
  if (!runtime || runtime.getSnapshot().state !== 'idle') return;
  runtime.dispatch({
    type: 'presentation.chat-bubble-requested',
    text,
    dismissDelayMs: 5_500,
  });
}

function openAvatarContextMenu(event: MouseEvent): void {
  if (!model) return;
  const hitArea = desktopShell
    ? selectedHitArea(event.clientX, event.clientY)
    : model.hitTest(event.clientX, event.clientY)[0];
  if (!hitArea) return;
  event.preventDefault();
  contextMenuHost.open({
    targetId: 'avatar',
    clientX: event.clientX,
    clientY: event.clientY,
    data: { source: 'pointer', hitArea },
  });
}

function renderSpeechBubble(snapshot: import('../../../../packages/contracts/src/index.ts').AvatarSnapshot): void {
  const projection = projectSpeechBubble(snapshot.speechBubble);
  const activeStart = projection.leadingText.length;
  const trailingStart = activeStart + projection.activeText.length;
  speechBubble.hidden = !projection.visible;
  speechBubble.dataset.mode = projection.mode;
  speechBubbleLeading.textContent = formatChatBubbleFragment(projection.fullText, 0, activeStart);
  speechBubbleActive.textContent = formatChatBubbleFragment(projection.fullText, activeStart, trailingStart);
  speechBubbleActive.hidden = !projection.activeText;
  speechBubbleTrailing.textContent = formatChatBubbleFragment(
    projection.fullText,
    trailingStart,
    projection.fullText.length,
  );
  document.body.dataset.speechBubble = projection.visible ? projection.mode : 'hidden';
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
  const model = evaluateKnownToneAcceptance(active.modelLevels, {
    lipSyncGain: active.lipSyncProfile.gain,
    silenceSettleMs: active.lipSyncProfile.peakHoldMs + 25 + active.lipSyncProfile.releaseMs * 1.2,
  });
  const response = evaluateKnownToneResponseTiming(active.traces);
  const passed = player.passed && model.passed && response.passed;
  const metrics = { passed, player, model, response };
  document.body.dataset.toneAcceptance = passed ? 'passed' : 'failed';
  document.body.dataset.toneAcceptanceMetrics = JSON.stringify(metrics);
  knownToneSegments.delete(active.segmentId);
  toneAcceptance = null;
  if (passed) {
    const maximumTimingError = Math.max(...player.transitionErrorsMs, ...model.transitionErrorsMs);
    status.textContent = `口型同步验收通过 · 时轴 ${Math.round(maximumTimingError)} ms · 参数 ${formatMs(response.maximumModelResponseMs ?? 0)} · 屏幕帧 ${formatMs(response.maximumFrameResponseMs ?? 0)}`;
  }
  else status.textContent = `口型同步验收失败：${[...player.issues, ...model.issues, ...response.issues].join('；')}`;
  console.info(JSON.stringify({ event: 'tone.sync.result', ...metrics }));
}

function failToneAcceptance(message: string): void {
  if (toneAcceptance) knownToneSegments.delete(toneAcceptance.segmentId);
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

function initializeDesktopInteraction(initialState: Awaited<ReturnType<NonNullable<typeof desktopShell>['ready']>> | undefined): void {
  if (!desktopShell) return;
  const renderer = app.renderer as Renderer;
  const readback = new WebGLPixelReadbackBackend(
    renderer.gl as WebGLRenderingContext | WebGL2RenderingContext,
    canvas,
    { prepareReadback: () => renderer.framebuffer.bind(), sampleRadiusPixels: 1 },
  );
  pixelPicker = new AsyncPixelCoveragePicker(readback, {
    alphaThreshold: 8 / 255,
    onResult: applyPixelSelection,
    onError: handlePixelSelectionError,
  });
  document.body.dataset.pixelReadback = readback.readbackMode;
  app.renderer.on('postrender', advancePixelPicking);
  desktopShell.onBoundsChanged(updateDesktopBounds);
  desktopShell.onCursorPoint(handleDesktopCursor);
  canvas.addEventListener('pointerdown', beginAvatarDrag);
  canvas.addEventListener('pointermove', moveAvatarDrag);
  canvas.addEventListener('pointerup', endAvatarDrag);
  canvas.addEventListener('pointercancel', endAvatarDrag);
  canvas.addEventListener('webglcontextlost', () => {
    webglContextLosses++;
    document.body.dataset.webglContextLosses = webglContextLosses.toString();
    pixelPicker?.invalidate();
    pixelSelection = undefined;
    pixelCursorPoint = undefined;
    pixelCoverageLatch.reset();
    document.body.dataset.pixelSelection = 'context-lost';
    updatePointerPresentation({ passthrough: true, cursor: 'default' });
    console.warn('[renderer] WebGL context lost', { dragState: document.body.dataset.dragState, webglContextLosses });
  });
  canvas.addEventListener('webglcontextrestored', () => {
    console.info('[renderer] WebGL context restored', { webglContextLosses });
  });
  window.addEventListener('beforeunload', () => {
    app.renderer.off('postrender', advancePixelPicking);
    pixelPicker?.dispose();
    pixelPicker = undefined;
  }, { once: true });
  const applyReadyState = (state: Awaited<ReturnType<NonNullable<typeof desktopShell>['ready']>>) => {
    dragGesture.setHoldDelayMs(state.interaction.dragHoldDelayMs);
    document.body.dataset.dragHoldDelayMs = state.interaction.dragHoldDelayMs.toString();
    document.body.dataset.dragWindowApi = state.interaction.dragWindowApi;
    updateDesktopBounds(state.bounds);
    updatePointerPresentation(state.pointerPresentation ?? {
      passthrough: state.mousePassthrough,
      cursor: state.mousePassthrough ? 'default' : 'pointer',
    });
    document.body.dataset.desktopShell = 'ready';
  };
  desktopShell.onDesktopConfigState(applyReadyState);
  if (initialState) applyReadyState(initialState);
  else void desktopShell.ready().then(applyReadyState).catch(error => {
    document.body.dataset.desktopShell = 'failed';
    console.error('Desktop shell initialization failed', error);
  });
}

function handleDesktopCursor(point: { x: number; y: number }): void {
  if (!desktopShell || !desktopBounds || !model || !runtime) return;
  const localX = point.x - desktopBounds.x;
  const localY = point.y - desktopBounds.y;
  runtime.dispatch({
    type: 'user.look-target-changed',
    x: (point.x - (desktopBounds.x + desktopBounds.width / 2)) / (desktopBounds.width / 2),
    y: -(point.y - (desktopBounds.y + desktopBounds.height / 2)) / (desktopBounds.height / 2),
  });
  if (dragGesture.hasGesture) return;
  const inside = localX >= 0 && localY >= 0 && localX < desktopBounds.width && localY < desktopBounds.height;
  if (!inside) {
    if (contextMenuHost.isOpen) return;
    pixelPicker?.invalidate();
    pixelSelection = undefined;
    pixelCursorPoint = undefined;
    pixelCoverageLatch.reset();
    document.body.dataset.pixelSample = 'outside';
    document.body.dataset.pixelSelection = 'outside';
    updatePointerPresentation({ passthrough: true, cursor: 'default' });
    return;
  }
  if (contextMenuHost.isOpen) {
    const cursor = contextMenuHost.containsClientPoint(localX, localY) ? 'pointer' : 'default';
    updatePointerPresentation({ passthrough: false, cursor });
    return;
  }
  pixelCursorPoint = { x: localX, y: localY };
  pixelPicker?.watch(pixelCursorPoint);
  if (!pixelSelection) document.body.dataset.pixelSelection = 'pending';
}

function beginAvatarDrag(event: PointerEvent): void {
  if (!desktopShell || !model || event.button !== 0) return;
  const hitArea = selectedHitArea(event.clientX, event.clientY);
  if (!hitArea) return;
  if (!dragGesture.begin(event.pointerId, hitArea, { x: event.screenX, y: event.screenY })) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  pixelPicker?.invalidate();
}

function moveAvatarDrag(event: PointerEvent): void {
  dragGesture.move(event.pointerId, { x: event.screenX, y: event.screenY });
}

function endAvatarDrag(event: PointerEvent): void {
  if (!dragGesture.end(
    event.pointerId,
    { x: event.screenX, y: event.screenY },
    event.type === 'pointercancel',
  )) return;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
}

function updateDesktopBounds(bounds: { x: number; y: number; width: number; height: number }): void {
  const sizeChanged = desktopBounds?.width !== bounds.width || desktopBounds.height !== bounds.height;
  desktopBounds = bounds;
  document.body.dataset.windowBounds = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
  if (sizeChanged) fitModel();
}

function updatePointerPresentation(presentation: PointerPresentation, publish = true): void {
  if (!desktopShell || samePointerPresentation(pointerPresentation, presentation)) return;
  pointerPresentation = { ...presentation };
  document.body.dataset.pointerMode = presentation.passthrough ? 'passthrough' : 'interactive';
  document.body.dataset.cursorIntent = presentation.cursor;
  canvas.style.setProperty('cursor', cssCursor(presentation.cursor), 'important');
  document.body.dataset.computedCursor = getComputedStyle(canvas).cursor;
  if (publish) publishPointerPresentation(presentation);
}

function publishPointerPresentation(presentation: PointerPresentation): void {
  desktopShell?.setPointerPresentation(presentation);
}

function selectionPresentation(): PointerPresentation {
  return pixelCoverageLatch.selected
    ? { passthrough: false, cursor: 'pointer' }
    : { passthrough: true, cursor: 'default' };
}

function samePointerPresentation(a: PointerPresentation | undefined, b: PointerPresentation): boolean {
  return a?.passthrough === b.passthrough && a.cursor === b.cursor;
}

function cssCursor(intent: PointerPresentation['cursor']): string {
  return intent === 'pointer' ? 'pointer' : intent === 'move' ? 'move' : 'default';
}

function advancePixelPicking(): void {
  pixelPicker?.afterRender();
  const diagnostics = pixelPicker?.diagnostics();
  if (!diagnostics) return;
  document.body.dataset.pixelPendingReads = diagnostics.pendingReads.toString();
  document.body.dataset.pixelBackpressuredFrames = diagnostics.backpressuredFrames.toString();
}

function applyPixelSelection(result: PixelCoverageResult): void {
  pixelSelection = result;
  const decision = pixelCoverageLatch.update(result.covered);
  document.body.dataset.pixelSample = result.covered ? 'covered' : 'transparent';
  document.body.dataset.pixelSelection = decision.selected ? 'covered' : 'transparent';
  document.body.dataset.pixelCoverageStreak = decision.coveredStreak.toString();
  document.body.dataset.pixelTransparentStreak = decision.transparentStreak.toString();
  document.body.dataset.pixelAlpha = result.rgba[3].toString();
  document.body.dataset.pixelSubmittedFrame = result.submittedFrame.toString();
  document.body.dataset.pixelResolvedFrame = result.resolvedFrame.toString();
  document.body.dataset.pixelReadbackFrames = result.latencyFrames.toString();
  if (!dragGesture.hasGesture && !contextMenuHost.isOpen) updatePointerPresentation(selectionPresentation());
}

function handlePixelSelectionError(error: Error): void {
  const decision = pixelCoverageLatch.update(false);
  document.body.dataset.pixelSample = 'failed';
  document.body.dataset.pixelSelection = decision.selected ? 'covered' : 'transparent';
  document.body.dataset.pixelReadbackError = error.message;
  if (!dragGesture.hasGesture && !contextMenuHost.isOpen) updatePointerPresentation(selectionPresentation());
  console.error('Pixel coverage readback failed', error);
}

function selectedHitArea(x: number, y: number): string | undefined {
  const point = pixelCursorPoint;
  if (!pixelCoverageLatch.selected || !point || Math.abs(point.x - x) > 2 || Math.abs(point.y - y) > 2) return undefined;
  return model?.hitTest(x, y)[0] ?? 'VisiblePixel';
}

function afterRenderedFrames(count: number, callback: () => void): void {
  if (count <= 0) return callback();
  app.renderer.once('postrender', () => afterRenderedFrames(count - 1, callback));
}

function nextRenderedFrame(): Promise<void> {
  return new Promise(resolve => app.renderer.once('postrender', () => resolve()));
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
  const layoutWidth = model.internalModel.width;
  const layoutHeight = model.internalModel.height;
  const scale = desktopShell
    ? Math.min(innerWidth / layoutWidth * 0.92, innerHeight / layoutHeight * 0.94)
    : Math.min(innerWidth / layoutWidth * 0.7, innerHeight / layoutHeight * 0.82);
  model.scale.set(scale);
  model.anchor.set(0.5, 0.5);
  model.position.set(innerWidth * (desktopShell ? 0.5 : 0.68), innerHeight * 0.5);
  document.body.dataset.modelScale = scale.toFixed(6);
}
