import {
  createApplicationCommandFramework,
  type ApplicationCommandFramework,
} from '../../../../packages/application-command-runtime/src/index.ts';
import {
  ConfiguredApplicationOperationBindingRuntime,
  type ConfiguredApplicationOperationGateway,
  type ConfiguredOperationBinding,
} from './configured-operation-binding.ts';
import { registerSessionWindowManagement } from './session-window-management.ts';

export interface DesktopApplicationCommandConfig {
  bindings: Readonly<Record<string, ConfiguredOperationBinding>>;
}

export interface DesktopApplicationCommandRuntime extends ApplicationCommandFramework {
  configure(config: DesktopApplicationCommandConfig): void;
  close(): void;
}

/** Application composition root; concrete transport remains behind gateway. */
export function createDesktopApplicationCommandRuntime(options: {
  gateway: ConfiguredApplicationOperationGateway;
  config?: DesktopApplicationCommandConfig;
}): DesktopApplicationCommandRuntime {
  const initialConfig = validateConfig(options.config ?? { bindings: {} });
  const framework = createApplicationCommandFramework();
  const operations = new ConfiguredApplicationOperationBindingRuntime(
    options.gateway,
    initialConfig.bindings,
  );
  const unregister = registerSessionWindowManagement({
    queryCatalog: framework.queryCatalog,
    commandCatalog: framework.commandCatalog,
    operations,
  });
  let closed = false;
  return {
    ...framework,
    configure(config) {
      if (closed) throw new Error('Desktop application command runtime is closed');
      operations.replaceBindings(validateConfig(config).bindings);
    },
    close() {
      if (closed) return;
      closed = true;
      unregister();
    },
  };
}

function validateConfig(config: DesktopApplicationCommandConfig): DesktopApplicationCommandConfig {
  if (!config || typeof config !== 'object' || !config.bindings
    || typeof config.bindings !== 'object' || Array.isArray(config.bindings)) {
    throw new TypeError('Desktop application command config bindings must be an object');
  }
  const bounds = config.bindings['session.window.bounds'];
  if (bounds) requireArgumentSource(bounds, 'target.id', 'session.window.bounds');
  const place = config.bindings['session.window.place'];
  if (place) {
    requireArgumentSource(place, 'target.id', 'session.window.place');
    requireArgumentSource(place, 'target.expectedRevision', 'session.window.place');
  }
  return config;
}

function requireArgumentSource(
  binding: ConfiguredOperationBinding,
  source: string,
  bindingId: string,
): void {
  const forwarded = Object.values(binding.arguments).some(
    rule => rule.source === source && rule.required !== false,
  );
  if (!forwarded) {
    throw new TypeError(`${bindingId} binding must forward required source ${source}`);
  }
}
