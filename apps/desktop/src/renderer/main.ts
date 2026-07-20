import { Application, Ticker } from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display/cubism4';
import type { AvatarEvent, RuntimeEffect } from '../../../../packages/contracts/src/index.ts';
import { AvatarRuntime, DefaultAvatarPlanner, ParameterMixer } from '../../../../packages/avatar-runtime/src/index.ts';
import { DEFAULT_TTS_CONFIG } from '../../../../packages/config/src/index.ts';
import { JsonConsoleTtsLogger, MockTtsAdapter, TtsRuntimeEffectHandler } from '../../../../packages/tts-mcp-adapter/src/index.ts';
import './style.css';

Live2DModel.registerTicker(Ticker);
const canvas = document.querySelector<HTMLCanvasElement>('#avatar')!;
const status = document.querySelector<HTMLElement>('#status')!;
const speak = document.querySelector<HTMLButtonElement>('#speak')!;
const motion = document.querySelector<HTMLButtonElement>('#motion')!;
const reset = document.querySelector<HTMLButtonElement>('#reset')!;
const app = new Application({ view: canvas, resizeTo: window, backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: Math.min(devicePixelRatio, 2) });

type CubismCoreModel = { setParameterValueById(id: string, value: number): void };
let model: Live2DModel | undefined;
let runtime: AvatarRuntime | undefined;
let playbackTimer: ReturnType<typeof setInterval> | undefined;
let gestureUntil = 0;
let gesturePhase = 0;
const ttsAdapter = new MockTtsAdapter({ ...DEFAULT_TTS_CONFIG.mock, logger: new JsonConsoleTtsLogger() });
const ttsEffects = new TtsRuntimeEffectHandler(ttsAdapter);

try {
  model = await Live2DModel.from('/models/Mao/Mao.model3.json', { autoInteract: false });
  app.stage.addChild(model);
  fitModel();
  window.addEventListener('resize', fitModel);

  runtime = new AvatarRuntime({
    planner: new DefaultAvatarPlanner(),
    mixer: new ParameterMixer({ ranges: { ParamA: { min: 0, max: 1 }, ParamAngleX: { min: -30, max: 30 }, ParamAngleY: { min: -30, max: 30 } } }),
    effects: { execute },
  });
  runtime.dispatch({ type: 'renderer.ready', capabilities: {
    emotions: ['neutral', 'happy'], actions: ['nod'],
    parameters: ['ParamA', 'ParamMouthOpenY', 'ParamMouthForm', 'ParamAngleX', 'ParamAngleY'],
    supportsMouthForm: true, supportsGaze: true, supportsHitTest: true,
  } });
  const ttsHealth = await ttsAdapter.health();
  document.body.dataset.ttsHealth = ttsHealth.status;
  runtime.subscribe(snapshot => {
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
  motion.addEventListener('click', () => submitDemo(true));
  reset.addEventListener('click', () => runtime?.dispatch({ type: 'user.interrupt-requested' }));
  app.ticker.add(delta => {
    if (!model || performance.now() >= gestureUntil) return;
    gesturePhase += delta * 0.18;
    coreModel(model).setParameterValueById('ParamAngleZ', Math.sin(gesturePhase) * 10);
  });

  for (const button of [speak, motion, reset]) button.disabled = false;
  document.body.dataset.ready = 'true';
}
catch (error) {
  status.textContent = `加载失败：${error instanceof Error ? error.message : String(error)}`;
  document.body.dataset.ready = 'false';
  console.error(error);
}

function submitDemo(withAction: boolean): void {
  if (!runtime || runtime.getSnapshot().state !== 'idle') return;
  runtime.dispatch({ type: 'plan.submitted', plan: { id: `demo-${Date.now()}`, segments: [{
    id: `segment-${Date.now()}`, sequence: 0, displayText: '运行时演示', speechText: '运行时演示',
    emotion: { emotion: 'happy', intensity: 0.7, atMs: 100 },
    actions: withAction ? [{ id: 'nod-demo', action: 'nod', atMs: 350 }] : [],
  }] } });
}

function execute(effect: RuntimeEffect, dispatch: (event: AvatarEvent) => void): void {
  if (ttsEffects.handle(effect, dispatch)) return;
  if (effect.type === 'audio.play') {
    clearPlayback();
    const startedAt = performance.now();
    const durationMs = effect.source.durationMs ?? 1_800;
    dispatch({ type: 'playback.started', generation: effect.generation, segmentId: effect.segmentId, positionMs: 0 });
    playbackTimer = setInterval(() => {
      const positionMs = performance.now() - startedAt;
      if (positionMs >= durationMs) {
        clearPlayback();
        dispatch({ type: 'playback.completed', generation: effect.generation, segmentId: effect.segmentId, positionMs: durationMs });
      } else dispatch({ type: 'playback.progress', generation: effect.generation, segmentId: effect.segmentId, positionMs });
    }, 50);
  }
  else if (effect.type === 'audio.stop') clearPlayback();
  else if (effect.type === 'renderer.apply-frame' && model) {
    const core = coreModel(model);
    for (const [id, value] of Object.entries(effect.frame)) core.setParameterValueById(id === 'ParamMouthOpenY' ? 'ParamA' : id, value);
  }
  else if (effect.type === 'renderer.play-motion') {
    gestureUntil = performance.now() + 1200;
    setTimeout(() => dispatch({ type: 'renderer.motion-completed', generation: effect.generation, actionId: effect.command.actionId }), 1200);
  }
}

function clearPlayback(): void { if (playbackTimer) clearInterval(playbackTimer); playbackTimer = undefined; }
function coreModel(target: Live2DModel): CubismCoreModel { return target.internalModel.coreModel as CubismCoreModel; }
function fitModel(): void {
  if (!model) return;
  const scale = Math.min(innerWidth / model.width * 0.7, innerHeight / model.height * 0.82);
  model.scale.set(scale); model.anchor.set(0.5, 0.5); model.position.set(innerWidth * 0.68, innerHeight * 0.5);
}
