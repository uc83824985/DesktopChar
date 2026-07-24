export interface AssetPreviewExpressionManager {
  resetExpression(): void;
}

export interface AssetPreviewMotionManager {
  readonly groups: { idle: string };
  readonly expressionManager?: AssetPreviewExpressionManager;
  stopAllMotions(): void;
}

const SUPPRESSED_IDLE_GROUP = '__desktop_char_asset_preview_no_idle__';

/**
 * Owns the renderer-side baseline used to inspect raw Live2D resources.
 * Locking suppresses automatic Idle selection while explicit preview motions
 * remain available to the development UI.
 */
export class AssetPreviewIsolationController {
  readonly #motionManager: AssetPreviewMotionManager;
  #restoreIdleGroup: string | undefined;

  constructor(motionManager: AssetPreviewMotionManager) {
    this.#motionManager = motionManager;
  }

  get locked(): boolean {
    return this.#restoreIdleGroup !== undefined;
  }

  setLocked(locked: boolean): boolean {
    if (locked === this.locked) return false;
    this.resetBaseline();
    if (locked) {
      this.#restoreIdleGroup = this.#motionManager.groups.idle;
      this.#motionManager.groups.idle = SUPPRESSED_IDLE_GROUP;
    }
    else {
      this.#motionManager.groups.idle = this.#restoreIdleGroup!;
      this.#restoreIdleGroup = undefined;
    }
    return true;
  }

  prepareExpressionPreview(): void {
    if (!this.locked) return;
    this.#motionManager.stopAllMotions();
    this.resetExpression();
  }

  prepareMotionPreview(): void {
    if (!this.locked) return;
    this.#motionManager.stopAllMotions();
    this.resetExpression();
  }

  finishMotionPreview(): void {
    if (this.locked) this.#motionManager.stopAllMotions();
  }

  resetBaseline(): void {
    this.#motionManager.stopAllMotions();
    this.resetExpression();
  }

  dispose(): void {
    if (this.locked) this.setLocked(false);
  }

  private resetExpression(): void {
    this.#motionManager.expressionManager?.resetExpression();
  }
}
