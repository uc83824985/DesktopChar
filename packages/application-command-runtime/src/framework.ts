import { ApplicationAccessScheduler } from './access-scheduler.ts';
import {
  ApplicationCommandCatalog,
  ApplicationQueryCatalog,
} from './catalog.ts';
import { ApplicationCommandRuntime } from './command-runtime.ts';
import { ApplicationQueryRuntime } from './query-runtime.ts';

export interface ApplicationCommandFrameworkOptions {
  maxRetainedCommandExecutions?: number;
  now?: () => number;
}

export interface ApplicationCommandFramework {
  scheduler: ApplicationAccessScheduler;
  queryCatalog: ApplicationQueryCatalog;
  commandCatalog: ApplicationCommandCatalog;
  queries: ApplicationQueryRuntime;
  commands: ApplicationCommandRuntime;
}

/**
 * Creates the application-scoped composition root. Query and command runtimes
 * deliberately share one scheduler so their read/write claims can conflict.
 */
export function createApplicationCommandFramework(
  options: ApplicationCommandFrameworkOptions = {},
): ApplicationCommandFramework {
  const scheduler = new ApplicationAccessScheduler();
  const queryCatalog = new ApplicationQueryCatalog();
  const commandCatalog = new ApplicationCommandCatalog();
  return {
    scheduler,
    queryCatalog,
    commandCatalog,
    queries: new ApplicationQueryRuntime({ scheduler, catalog: queryCatalog }),
    commands: new ApplicationCommandRuntime({
      scheduler,
      catalog: commandCatalog,
      ...(options.maxRetainedCommandExecutions !== undefined
        ? { maxRetainedExecutions: options.maxRetainedCommandExecutions }
        : {}),
      ...(options.now ? { now: options.now } : {}),
    }),
  };
}
