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
  views?: readonly DomInteractionPanelView[];
  initialViewId?: string;
  onPhaseChanged?(phase: HoverDismissPhase): void;
  onVisibilityChanged?(visible: boolean): void;
  onError?(error: unknown): void;
}

export interface DomInteractionPanelViewController {
  refresh?(context: Readonly<ImmediateUiContext>): void;
  dispose?(): void;
}

export type DomInteractionPanelView =
  | {
    id: string;
    label: string;
    kind: 'registry';
  }
  | {
    id: string;
    label: string;
    kind: 'custom';
    mount(
      container: HTMLElement,
      context: Readonly<ImmediateUiContext>,
    ): DomInteractionPanelViewController | void;
  };

/**
 * Persistent immediate-mode panel used by primary actor interaction. Unlike a
 * context menu, actions never dismiss it; hover owns the delayed fade-out.
 */
export class DomInteractionPanelHost {
  readonly #registry: ImmediateUiRegistry;
  readonly #root: HTMLElement;
  readonly #label: string;
  readonly #views: readonly DomInteractionPanelView[];
  readonly #onVisibilityChanged: ((visible: boolean) => void) | undefined;
  readonly #onError: (error: unknown) => void;
  readonly #visibility: HoverDismissController;
  #element: HTMLElement | undefined;
  #content: HTMLElement | undefined;
  #abort: AbortController | undefined;
  #context: ImmediateUiContext | undefined;
  #activeViewId: string;
  #mountedViewId: string | undefined;
  #viewController: DomInteractionPanelViewController | undefined;
  #signature = '';

  constructor(registry: ImmediateUiRegistry, options: DomInteractionPanelHostOptions = {}) {
    this.#registry = registry;
    this.#root = options.root ?? document.body;
    this.#label = options.label ?? '角色交互';
    this.#views = normalizedViews(options.views);
    this.#activeViewId = options.initialViewId ?? this.#views[0]!.id;
    if (!this.#views.some(view => view.id === this.#activeViewId)) {
      throw new Error(`Unknown initial interaction panel view "${this.#activeViewId}"`);
    }
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
    if (sections.length === 0 && !this.#views.some(view => view.kind === 'custom')) return false;
    this.#context = { ...context };
    if (!this.#element) this.#createElement();
    this.#renderActiveView(sections);
    this.#visibility.show();
    return true;
  }

  refresh(): boolean {
    if (!this.#element || !this.#context) return false;
    const sections = this.#registry.resolve(this.#context);
    if (sections.length === 0 && !this.#views.some(view => view.kind === 'custom')) {
      this.close();
      return true;
    }
    return this.#renderActiveView(sections);
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
    panel.addEventListener('pointerleave', () => {
      this.#visibility.trackInside(panel.contains(document.activeElement));
    }, {
      signal: abort.signal,
    });
    panel.addEventListener('focusin', () => this.#visibility.trackInside(true), { signal: abort.signal });
    panel.addEventListener('focusout', event => {
      const focusRemainsInside = event.relatedTarget instanceof Node && panel.contains(event.relatedTarget);
      this.#visibility.trackInside(focusRemainsInside || panel.matches(':hover'));
    }, { signal: abort.signal });
    panel.addEventListener('contextmenu', event => event.preventDefault(), {
      signal: abort.signal,
    });
    if (this.#views.length > 1) {
      const navigation = document.createElement('nav');
      navigation.className = 'scene-interaction-panel__tabs';
      navigation.setAttribute('aria-label', '交互分类');
      for (const view of this.#views) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'scene-interaction-panel__tab';
        button.dataset.viewId = view.id;
        button.setAttribute('aria-pressed', String(view.id === this.#activeViewId));
        button.textContent = view.label;
        button.addEventListener('click', () => this.#selectView(view.id), { signal: abort.signal });
        navigation.append(button);
      }
      panel.append(navigation);
    }
    const content = document.createElement('div');
    content.className = 'scene-interaction-panel__content';
    panel.append(content);
    this.#root.append(panel);
    this.#element = panel;
    this.#content = content;
    this.#abort = abort;
    this.#onVisibilityChanged?.(true);
  }

  #renderActiveView(sections: ReturnType<ImmediateUiRegistry['resolve']>): boolean {
    const content = this.#content;
    const context = this.#context;
    const view = this.#views.find(candidate => candidate.id === this.#activeViewId);
    if (!content || !context || !view) return false;
    this.#element!.dataset.view = view.id;
    this.#refreshTabs();
    if (view.kind === 'custom') {
      if (this.#mountedViewId !== view.id) {
        this.#disposeViewController();
        content.replaceChildren();
        this.#viewController = view.mount(content, context) ?? undefined;
        this.#mountedViewId = view.id;
        this.#signature = '';
        return true;
      }
      this.#viewController?.refresh?.(context);
      return false;
    }
    const signature = sectionSignature(sections);
    if (this.#mountedViewId === view.id && signature === this.#signature) return false;
    this.#disposeViewController();
    this.#renderSections(content, sections);
    this.#mountedViewId = view.id;
    this.#signature = signature;
    return true;
  }

  #renderSections(
    content: HTMLElement,
    sections: ReturnType<ImmediateUiRegistry['resolve']>,
  ): void {
    const activeItemId = content.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.itemId
      : undefined;
    content.replaceChildren();
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
      content.append(group);
    }
    if (activeItemId) {
      content.querySelector<HTMLElement>(
        `[data-item-id="${CSS.escape(activeItemId)}"]:not(:disabled)`,
      )?.focus();
    }
  }

  #selectView(viewId: string): void {
    if (viewId === this.#activeViewId || !this.#views.some(view => view.id === viewId)) return;
    this.#activeViewId = viewId;
    this.#signature = '';
    this.#mountedViewId = undefined;
    this.#disposeViewController();
    const sections = this.#context ? this.#registry.resolve(this.#context) : [];
    this.#renderActiveView(sections);
    this.#visibility.trackInside(true);
  }

  #refreshTabs(): void {
    this.#element?.querySelectorAll<HTMLButtonElement>('.scene-interaction-panel__tab')
      .forEach(button => button.setAttribute('aria-pressed', String(button.dataset.viewId === this.#activeViewId)));
  }

  #disposeViewController(): void {
    this.#viewController?.dispose?.();
    this.#viewController = undefined;
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
    if (item.type === 'radio') {
      button.setAttribute('aria-pressed', String(item.selected));
      if (item.selected) button.dataset.checked = 'true';
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
    this.#disposeViewController();
    this.#abort?.abort();
    this.#element.remove();
    this.#element = undefined;
    this.#content = undefined;
    this.#abort = undefined;
    this.#context = undefined;
    this.#mountedViewId = undefined;
    this.#signature = '';
    this.#onVisibilityChanged?.(false);
  }
}

function normalizedViews(views: readonly DomInteractionPanelView[] | undefined): readonly DomInteractionPanelView[] {
  const result = views?.length
    ? views.map(view => ({ ...view }))
    : [{ id: 'default', label: '交互', kind: 'registry' as const }];
  const ids = new Set<string>();
  for (const view of result) {
    if (!view.id.trim() || !view.label.trim()) throw new TypeError('Interaction panel views require non-empty id and label');
    if (ids.has(view.id)) throw new Error(`Duplicate interaction panel view "${view.id}"`);
    ids.add(view.id);
  }
  return result;
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
      ...(item.type === 'checkbox' ? { checked: item.checked }
        : item.type === 'radio' ? { selected: item.selected }
        : { danger: item.danger === true }),
    })),
  })));
}
