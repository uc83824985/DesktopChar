export interface ImmediateUiContext {
  targetId: string;
  clientX: number;
  clientY: number;
  data?: Readonly<Record<string, unknown>>;
}

export type ImmediateUiItem = ImmediateUiAction | ImmediateUiCheckbox;

export interface ImmediateUiAction {
  type: 'action';
  id: string;
  label: string;
  enabled?: boolean;
  danger?: boolean;
  invoke(): void | Promise<void>;
}

export interface ImmediateUiCheckbox {
  type: 'checkbox';
  id: string;
  label: string;
  checked: boolean;
  enabled?: boolean;
  invoke(checked: boolean): void | Promise<void>;
}

export interface ImmediateUiSection {
  label?: string;
  items: readonly ImmediateUiItem[];
}

export interface ImmediateUiRegistration {
  id: string;
  target: string | readonly string[] | '*';
  order?: number;
  build(context: Readonly<ImmediateUiContext>): ImmediateUiSection | null;
}

export interface ResolvedImmediateUiSection extends ImmediateUiSection {
  registrationId: string;
}

/**
 * Application-owned immediate UI declarations. Registrations contain no UI
 * state: providers are evaluated again whenever a surface is opened.
 */
export class ImmediateUiRegistry {
  readonly #registrations = new Map<string, ImmediateUiRegistration>();

  register(registration: ImmediateUiRegistration): () => void {
    validateRegistration(registration);
    if (this.#registrations.has(registration.id)) {
      throw new Error(`Immediate UI registration "${registration.id}" already exists`);
    }
    this.#registrations.set(registration.id, registration);
    return () => {
      if (this.#registrations.get(registration.id) === registration) {
        this.#registrations.delete(registration.id);
      }
    };
  }

  resolve(context: Readonly<ImmediateUiContext>): ResolvedImmediateUiSection[] {
    const sections: ResolvedImmediateUiSection[] = [];
    const registrations = [...this.#registrations.values()].sort((left, right) =>
      (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id));

    for (const registration of registrations) {
      if (!matchesTarget(registration.target, context.targetId)) continue;
      const section = registration.build(context);
      if (!section || section.items.length === 0) continue;
      validateSection(registration.id, section);
      sections.push({ registrationId: registration.id, ...section, items: [...section.items] });
    }
    return sections;
  }
}

function matchesTarget(target: ImmediateUiRegistration['target'], targetId: string): boolean {
  return target === '*' || target === targetId || (Array.isArray(target) && target.includes(targetId));
}

function validateRegistration(registration: ImmediateUiRegistration): void {
  nonEmpty(registration.id, 'Immediate UI registration id');
  if (registration.target !== '*') {
    const targets = typeof registration.target === 'string' ? [registration.target] : registration.target;
    if (targets.length === 0) throw new Error(`Immediate UI registration "${registration.id}" has no targets`);
    for (const target of targets) nonEmpty(target, `Immediate UI registration "${registration.id}" target`);
  }
  if (registration.order !== undefined && !Number.isFinite(registration.order)) {
    throw new Error(`Immediate UI registration "${registration.id}" order must be finite`);
  }
}

function validateSection(registrationId: string, section: ImmediateUiSection): void {
  if (section.label !== undefined) nonEmpty(section.label, `Immediate UI section "${registrationId}" label`);
  const itemIds = new Set<string>();
  for (const item of section.items) {
    nonEmpty(item.id, `Immediate UI registration "${registrationId}" item id`);
    nonEmpty(item.label, `Immediate UI registration "${registrationId}" item label`);
    if (itemIds.has(item.id)) {
      throw new Error(`Immediate UI registration "${registrationId}" has duplicate item "${item.id}"`);
    }
    itemIds.add(item.id);
  }
}

function nonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
}
