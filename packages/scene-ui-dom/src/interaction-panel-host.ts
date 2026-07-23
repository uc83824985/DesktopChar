import {
  HoverDismissController,
  type HoverDismissPhase,
} from './hover-dismiss.ts';
import {
  ImmediateUiRegistry,
  type ImmediateUiContext,
  type ImmediateUiItem,
} from './immediate-ui.ts';

export interface DomInteractionPanelHostOptions {
  root?: HTMLElement;
  dismissDelayMs?: number;
  fadeOutMs?: number;
  label?: string;
  onPhaseChanged?(phase: HoverDismissPhase): void;
  onVisibilityChanged?(visible: boolean): void;
  onError?(error: unknown): void;
}

/**
 * Persistent immediate-mode panel used by primary actor interaction. Unlike a
 * context menu, actions never dismiss it; hover owns the delayed fade-out.
 */
export class DomInteractionPanelHost {
  readonly #registry: ImmediateUiRegistry;
  readonly #root: HTMLElement;
  readonly #label: string;
  readonly #onVisibilityChanged: ((visible: boolean) => void) | undefined;
  readonly #onError: (error: unknown) => void;
  readonly #visibility: HoverDismissController;
  #element: HTMLElement | undefined;
  #abort: AbortController | undefined;
  #context: ImmediateUiContext | undefined;
  #signature = '';

  constructor(registry: ImmediateUiRegistry, options: DomInteractionPanelHostOptions = {}) {
    this.#registry = registry;
    this.#root = options.root ?? document.body;
    this.#label = options.label ?? '角色交互';
    this.#onVisibilityChanged = options.onVisibilityChanged;
    this.#onError = options.onError
      ?? (error => console.error('[scene-ui-dom] interaction panel action failed', error));
    this.#visibility = new HoverDismissController({
      ...(options.dismissDelayMs !== undefined ? { dismissDelayMs: options.dismissDelayMs } : {}),
      ...(options.fadeOutMs !== undefined ? { fadeOutMs: options.fadeOutMs } : {}),
      onPhaseChanged: phase => {
        this.#applyPhase(phase);
        options.onPhaseChanged?.(phase);
      },
    });
  }

  get isOpen(): boolean {
    return this.#element !== undefined;
  }

  get phase(): HoverDismissPhase {
    return this.#visibility.phase;
  }

  open(context: Readonly<ImmediateUiContext>): boolean {
    const sections = this.#registry.resolve(context);
    if (sections.length === 0) return false;
    this.#context = { ...context };
    if (!this.#element) this.#createElement();
    const signature = sectionSignature(sections);
    if (signature !== this.#signature) {
      this.#renderSections(sections);
      this.#signature = signature;
    }
    this.#visibility.show();
    return true;
  }

  refresh(): boolean {
    if (!this.#element || !this.#context) return false;
    const sections = this.#registry.resolve(this.#context);
    if (sections.length === 0) {
      this.close();
      return true;
    }
    const signature = sectionSignature(sections);
    if (signature === this.#signature) return false;
    this.#renderSections(sections);
    this.#signature = signature;
    return true;
  }

  trackClientPoint(x: number, y: number): boolean {
    const inside = this.containsClientPoint(x, y);
    this.#visibility.trackInside(inside);
    return inside;
  }

  containsClientPoint(x: number, y: number): boolean {
    const bounds = this.#element?.getBoundingClientRect();
    return Boolean(bounds && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom);
  }

  close(): void {
    this.#visibility.close();
  }

  dispose(): void {
    this.#visibility.dispose();
    this.#destroyElement();
  }

  #createElement(): void {
    const abort = new AbortController();
    const panel = document.createElement('section');
    panel.className = 'scene-interaction-panel';
    panel.dataset.phase = 'visible';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', this.#label);
    panel.addEventListener('pointerenter', () => this.#visibility.trackInside(true), {
      signal: abort.signal,
    });
    panel.addEventListener('pointerleave', () => this.#visibility.trackInside(false), {
      signal: abort.signal,
    });
    panel.addEventListener('contextmenu', event => event.preventDefault(), {
      signal: abort.signal,
    });
    this.#root.append(panel);
    this.#element = panel;
    this.#abort = abort;
    this.#onVisibilityChanged?.(true);
  }

  #renderSections(sections: ReturnType<ImmediateUiRegistry['resolve']>): void {
    const panel = this.#element;
    if (!panel) return;
    const activeItemId = panel.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.itemId
      : undefined;
    panel.replaceChildren();
    for (const section of sections) {
      const group = document.createElement('section');
      group.className = 'scene-interaction-panel__section';
      group.dataset.registrationId = section.registrationId;
      if (section.label) {
        const heading = document.createElement('h2');
        heading.className = 'scene-interaction-panel__heading';
        heading.textContent = section.label;
        group.append(heading);
      }
      const items = document.createElement('div');
      items.className = 'scene-interaction-panel__items';
      for (const item of section.items) items.append(this.#createItem(item));
      group.append(items);
      panel.append(group);
    }
    if (activeItemId) {
      panel.querySelector<HTMLElement>(
        `[data-item-id="${CSS.escape(activeItemId)}"]:not(:disabled)`,
      )?.focus();
    }
  }

  #createItem(item: ImmediateUiItem): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scene-interaction-panel__item';
    button.dataset.itemId = item.id;
    button.disabled = item.enabled === false;
    if (item.type === 'checkbox') {
      button.setAttribute('aria-pressed', String(item.checked));
      if (item.checked) button.dataset.checked = 'true';
    }
    button.textContent = item.label;
    button.addEventListener('click', () => {
      if (button.disabled) return;
      this.#visibility.trackInside(true);
      try {
        const result = item.type === 'checkbox' ? item.invoke(!item.checked) : item.invoke();
        if (result instanceof Promise) {
          void result.then(() => this.refresh()).catch(this.#onError);
        }
        else this.refresh();
      }
      catch (error) {
        this.#onError(error);
      }
    });
    return button;
  }

  #applyPhase(phase: HoverDismissPhase): void {
    if (phase === 'hidden') {
      this.#destroyElement();
      return;
    }
    if (this.#element) this.#element.dataset.phase = phase;
  }

  #destroyElement(): void {
    if (!this.#element) return;
    this.#abort?.abort();
    this.#element.remove();
    this.#element = undefined;
    this.#abort = undefined;
    this.#context = undefined;
    this.#signature = '';
    this.#onVisibilityChanged?.(false);
  }
}

function sectionSignature(sections: ReturnType<ImmediateUiRegistry['resolve']>): string {
  return JSON.stringify(sections.map(section => ({
    registrationId: section.registrationId,
    label: section.label,
    items: section.items.map(item => ({
      type: item.type,
      id: item.id,
      label: item.label,
      enabled: item.enabled !== false,
      ...(item.type === 'checkbox' ? { checked: item.checked } : { danger: item.danger === true }),
    })),
  })));
}
