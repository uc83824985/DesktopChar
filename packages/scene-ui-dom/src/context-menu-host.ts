import {
  ImmediateUiRegistry,
  type ImmediateUiContext,
  type ImmediateUiItem,
} from './immediate-ui.ts';

export interface DomContextMenuHostOptions {
  root?: HTMLElement;
  onVisibilityChanged?(visible: boolean): void;
  onError?(error: unknown): void;
}

/** Shared DOM host for the immediate UI context-menu surface. */
export class DomContextMenuHost {
  readonly #registry: ImmediateUiRegistry;
  readonly #root: HTMLElement;
  readonly #onVisibilityChanged: ((visible: boolean) => void) | undefined;
  readonly #onError: (error: unknown) => void;
  #element: HTMLElement | undefined;
  #abort: AbortController | undefined;
  #context: ImmediateUiContext | undefined;
  #signature = '';

  constructor(registry: ImmediateUiRegistry, options: DomContextMenuHostOptions = {}) {
    this.#registry = registry;
    this.#root = options.root ?? document.body;
    this.#onVisibilityChanged = options.onVisibilityChanged;
    this.#onError = options.onError ?? (error => console.error('[scene-ui-dom] context menu action failed', error));
  }

  get isOpen(): boolean {
    return this.#element !== undefined;
  }

  open(context: Readonly<ImmediateUiContext>): boolean {
    this.close();
    const sections = this.#registry.resolve(context);
    if (sections.length === 0) return false;

    const abort = new AbortController();
    const menu = document.createElement('div');
    menu.className = 'scene-context-menu';
    menu.dataset.targetId = context.targetId;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', `${context.targetId} 设置`);
    menu.tabIndex = -1;
    menu.style.left = `${context.clientX}px`;
    menu.style.top = `${context.clientY}px`;
    this.#renderSections(menu, sections);

    menu.addEventListener('contextmenu', event => event.preventDefault(), { signal: abort.signal });
    menu.addEventListener('keydown', event => this.#handleKeydown(event), { signal: abort.signal });
    this.#root.append(menu);
    this.#element = menu;
    this.#abort = abort;
    this.#context = { ...context };
    this.#signature = sectionSignature(sections);
    // Keep the open surface geometrically stable while checkbox state and
    // status-dependent labels are refreshed. Intrinsic text/marker metrics can
    // otherwise change offsetWidth by a few pixels and make a right-clamped
    // menu visibly jump sideways.
    menu.style.width = `${menu.offsetWidth}px`;
    clampToViewport(menu);
    document.addEventListener('pointerdown', event => this.#dismissFromOutside(event), {
      capture: true,
      signal: abort.signal,
    });
    menu.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus();
    this.#onVisibilityChanged?.(true);
    return true;
  }

  close(): void {
    if (!this.#element) return;
    this.#abort?.abort();
    this.#element.remove();
    this.#element = undefined;
    this.#abort = undefined;
    this.#context = undefined;
    this.#signature = '';
    this.#onVisibilityChanged?.(false);
  }

  /** Re-evaluates providers while preserving the open menu and its position. */
  refresh(): boolean {
    const menu = this.#element;
    const context = this.#context;
    if (!menu || !context) return false;
    const sections = this.#registry.resolve(context);
    if (sections.length === 0) {
      this.close();
      return true;
    }
    const signature = sectionSignature(sections);
    if (signature === this.#signature) return false;
    const activeItemId = menu.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.itemId
      : undefined;
    menu.replaceChildren();
    this.#renderSections(menu, sections);
    this.#signature = signature;
    clampToViewport(menu);
    if (activeItemId) {
      menu.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(activeItemId)}"]:not([aria-disabled="true"])`)?.focus();
    }
    return true;
  }

  containsClientPoint(x: number, y: number): boolean {
    const bounds = this.#element?.getBoundingClientRect();
    return Boolean(bounds && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom);
  }

  dispose(): void {
    this.close();
  }

  #renderSections(menu: HTMLElement, sections: ReturnType<ImmediateUiRegistry['resolve']>): void {
    sections.forEach((section, sectionIndex) => {
      if (sectionIndex > 0) {
        const separator = document.createElement('div');
        separator.className = 'scene-context-menu__separator';
        separator.setAttribute('role', 'separator');
        menu.append(separator);
      }
      if (section.label) {
        const heading = document.createElement('div');
        heading.className = 'scene-context-menu__heading';
        heading.textContent = section.label;
        menu.append(heading);
      }
      for (const item of section.items) menu.append(this.#createItem(item));
    });
  }

  #createItem(item: ImmediateUiItem): HTMLButtonElement {
    const button = document.createElement('button');
    const enabled = item.enabled !== false;
    button.type = 'button';
    button.className = 'scene-context-menu__item';
    button.dataset.itemId = item.id;
    button.disabled = !enabled;
    button.setAttribute('aria-disabled', String(!enabled));
    button.setAttribute('role', item.type === 'checkbox' ? 'menuitemcheckbox' : 'menuitem');
    if (item.type === 'checkbox') button.setAttribute('aria-checked', String(item.checked));
    if (item.type === 'action' && item.danger) button.dataset.danger = 'true';

    const marker = document.createElement('span');
    marker.className = 'scene-context-menu__marker';
    marker.textContent = item.type === 'checkbox' && item.checked ? '✓' : '';
    const label = document.createElement('span');
    label.textContent = item.label;
    button.append(marker, label);
    button.addEventListener('click', () => {
      if (!enabled) return;
      if (item.type === 'action') this.close();
      try {
        const result = item.type === 'checkbox' ? item.invoke(!item.checked) : item.invoke();
        if (result instanceof Promise) void result
          .then(() => { if (item.type === 'checkbox') this.refresh(); })
          .catch(this.#onError);
        else if (item.type === 'checkbox') this.refresh();
      }
      catch (error) {
        this.#onError(error);
      }
    });
    return button;
  }

  #dismissFromOutside(event: PointerEvent): void {
    if (!this.#element || this.#element.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  }

  #handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...(this.#element?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (current + 1 + items.length) % items.length
      : (current - 1 + items.length) % items.length;
    items[next]?.focus();
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

function clampToViewport(menu: HTMLElement): void {
  const margin = 8;
  // getBoundingClientRect() includes the menu's entry transform. Measuring
  // during the scale/translate animation and measuring again after an async
  // checkbox refresh made the menu appear to grow and permanently re-clamp
  // upward. Offset geometry is the stable, untransformed fixed-position box.
  const parsedLeft = Number.parseFloat(menu.style.left);
  const parsedTop = Number.parseFloat(menu.style.top);
  const requestedLeft = Number.isFinite(parsedLeft) ? parsedLeft : menu.offsetLeft;
  const requestedTop = Number.isFinite(parsedTop) ? parsedTop : menu.offsetTop;
  const left = Math.max(margin, Math.min(requestedLeft, window.innerWidth - menu.offsetWidth - margin));
  const top = Math.max(margin, Math.min(requestedTop, window.innerHeight - menu.offsetHeight - margin));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}
