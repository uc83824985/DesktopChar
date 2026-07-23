import {
  PARAMETER_UPDATE_ORDER,
  ParameterUpdateScheduler,
} from './parameter-update-scheduler.ts';

export interface Cubism4CoreModelTarget {
  saveParameters(): void;
  update(): void;
  loadParameters(): void;
}

export interface Cubism4UpdateContext {
  readonly coreModel: Cubism4CoreModelTarget;
  readonly deltaSeconds: number;
  readonly nowSeconds: number;
  readonly motionUpdated: boolean;
}

export interface Cubism4UpdateTarget {
  readonly coreModel: Cubism4CoreModelTarget;
  readonly motionManager: {
    update(model: Cubism4CoreModelTarget, nowSeconds: number): boolean;
    readonly expressionManager?: {
      update(model: Cubism4CoreModelTarget, nowSeconds: number): boolean;
    };
  };
  readonly focusController: {
    update(deltaMilliseconds: number): void;
  };
  readonly eyeBlink?: {
    updateParameters(model: Cubism4CoreModelTarget, deltaSeconds: number): void;
  };
  readonly physics?: {
    evaluate(model: Cubism4CoreModelTarget, deltaSeconds: number): void;
  };
  readonly pose?: {
    updateParameters(model: Cubism4CoreModelTarget, deltaSeconds: number): void;
  };
  updateFocus(): void;
  updateNaturalMovements(deltaMilliseconds: number, nowMilliseconds: number): void;
  update(deltaMilliseconds: number, nowMilliseconds: number): void;
  emit(event: 'beforeMotionUpdate' | 'afterMotionUpdate' | 'beforeModelUpdate'): unknown;
  once?(event: 'destroy', listener: () => void): unknown;
  off?(event: 'destroy', listener: () => void): unknown;
}

export interface Cubism4UpdatePipelineHandle {
  readonly scheduler: ParameterUpdateScheduler<Cubism4UpdateContext>;
  readonly active: boolean;
  restore(): void;
}

const installedPipelines = new WeakMap<object, Cubism4UpdatePipelineHandle>();

/**
 * Replaces one pixi-live2d-display Cubism4InternalModel instance's hard-coded
 * effect order with the official Cubism 5-r.5 order. No second Cubism model is
 * created and node_modules remains untouched.
 */
export function installCubism4UpdatePipeline(
  target: Cubism4UpdateTarget,
): Cubism4UpdatePipelineHandle {
  const existing = installedPipelines.get(target);
  if (existing?.active) return existing;

  const scheduler = new ParameterUpdateScheduler<Cubism4UpdateContext>();
  scheduler.register({
    id: 'cubism.eye-blink',
    executionOrder: PARAMETER_UPDATE_ORDER.EYE_BLINK,
    update: context => {
      if (!context.motionUpdated) {
        target.eyeBlink?.updateParameters(context.coreModel, context.deltaSeconds);
      }
    },
  });
  scheduler.register({
    id: 'cubism.expression',
    executionOrder: PARAMETER_UPDATE_ORDER.EXPRESSION,
    update: context => {
      target.motionManager.expressionManager?.update(context.coreModel, context.nowSeconds);
    },
  });
  scheduler.register({
    id: 'cubism.gaze-focus',
    executionOrder: PARAMETER_UPDATE_ORDER.GAZE_FOCUS,
    update: () => target.updateFocus(),
  });
  scheduler.register({
    id: 'cubism.breath',
    executionOrder: PARAMETER_UPDATE_ORDER.BREATH,
    update: context => target.updateNaturalMovements(
      context.deltaSeconds * 1_000,
      context.nowSeconds * 1_000,
    ),
  });
  scheduler.register({
    id: 'cubism.physics',
    executionOrder: PARAMETER_UPDATE_ORDER.PHYSICS,
    update: context => target.physics?.evaluate(context.coreModel, context.deltaSeconds),
  });
  scheduler.register({
    id: 'cubism.pose',
    executionOrder: PARAMETER_UPDATE_ORDER.POSE,
    update: context => target.pose?.updateParameters(context.coreModel, context.deltaSeconds),
  });
  scheduler.register({
    id: 'desktop-char.runtime-final',
    executionOrder: PARAMETER_UPDATE_ORDER.RUNTIME_FINAL,
    update: () => target.emit('beforeModelUpdate'),
  });

  const ownUpdateDescriptor = Object.getOwnPropertyDescriptor(target, 'update');
  let active = true;
  const scheduledUpdate = (deltaMilliseconds: number, nowMilliseconds: number): void => {
    target.focusController.update(deltaMilliseconds);
    const deltaSeconds = deltaMilliseconds / 1_000;
    const nowSeconds = nowMilliseconds / 1_000;
    const coreModel = target.coreModel;
    target.emit('beforeMotionUpdate');
    const motionUpdated = target.motionManager.update(coreModel, nowSeconds);
    target.emit('afterMotionUpdate');
    coreModel.saveParameters();
    scheduler.run({ coreModel, deltaSeconds, nowSeconds, motionUpdated });
    coreModel.update();
    coreModel.loadParameters();
  };
  target.update = scheduledUpdate;

  const onDestroy = (): void => handle.restore();
  const handle: Cubism4UpdatePipelineHandle = {
    scheduler,
    get active() { return active; },
    restore() {
      if (!active) return;
      active = false;
      target.off?.('destroy', onDestroy);
      if (target.update === scheduledUpdate) {
        if (ownUpdateDescriptor) Object.defineProperty(target, 'update', ownUpdateDescriptor);
        else Reflect.deleteProperty(target, 'update');
      }
      scheduler.clear();
      installedPipelines.delete(target);
    },
  };
  installedPipelines.set(target, handle);
  target.once?.('destroy', onDestroy);
  return handle;
}
