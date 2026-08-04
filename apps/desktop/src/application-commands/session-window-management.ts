import type {
  ApplicationCommandCatalog,
  ApplicationData,
  ApplicationQueryCatalog,
  ApplicationTarget,
} from '../../../../packages/application-command-runtime/src/index.ts';
import { ConfiguredApplicationOperationBindingRuntime } from './configured-operation-binding.ts';

export const SESSION_WINDOW_BOUNDS_QUERY = 'session.window.bounds';
export const SESSION_WINDOW_PLACE_COMMAND = 'session.window.place';

export type SessionWindowRegion =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'center';

interface SessionWindowPlaceParameters extends Record<string, ApplicationData> {
  region: SessionWindowRegion;
  displayId?: string;
  marginDip?: number;
}

interface SessionWindowBounds extends Record<string, ApplicationData> {
  x: number;
  y: number;
  width: number;
  height: number;
  displayId?: string;
  revision?: string;
}

interface SessionWindowPlaceResult extends Record<string, ApplicationData> {
  applied: true;
  bounds: SessionWindowBounds;
}

export function registerSessionWindowManagement(options: {
  queryCatalog: ApplicationQueryCatalog;
  commandCatalog: ApplicationCommandCatalog;
  operations: ConfiguredApplicationOperationBindingRuntime;
}): () => void {
  const disposeBounds = options.queryCatalog.register({
    type: SESSION_WINDOW_BOUNDS_QUERY,
    validateParameters: emptyParameters,
    access(query) {
      return [{ resource: sessionWindowResource(requireConversationTarget(query.target)), mode: 'read' }];
    },
    async execute({ query, parameters, signal }) {
      const target = requireConversationTarget(query.target);
      const projected = await options.operations.invoke(
        SESSION_WINDOW_BOUNDS_QUERY,
        { target, parameters, contextRevision: query.contextRevision },
        signal,
      );
      return sessionWindowBounds(projected, `${SESSION_WINDOW_BOUNDS_QUERY} result`);
    },
  });
  const disposePlace = options.commandCatalog.register({
    type: SESSION_WINDOW_PLACE_COMMAND,
    validateParameters: placeParameters,
    access(command) {
      return [{ resource: sessionWindowResource(requireRevisionedConversationTarget(command.target)), mode: 'write' }];
    },
    async execute({ command, parameters, signal }) {
      const target = requireRevisionedConversationTarget(command.target);
      const projected = await options.operations.invoke(
        SESSION_WINDOW_PLACE_COMMAND,
        { target, parameters, contextRevision: command.contextRevision },
        signal,
      );
      return placeResult(projected);
    },
  });
  return () => {
    disposePlace();
    disposeBounds();
  };
}

function emptyParameters(value: ApplicationData): Record<string, ApplicationData> {
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    throw new TypeError(`${SESSION_WINDOW_BOUNDS_QUERY} parameters must be an empty object`);
  }
  return {};
}

function placeParameters(value: ApplicationData): SessionWindowPlaceParameters {
  if (!isRecord(value)) throw new TypeError(`${SESSION_WINDOW_PLACE_COMMAND} parameters must be an object`);
  exactKeys(value, ['region', 'displayId', 'marginDip'], `${SESSION_WINDOW_PLACE_COMMAND} parameters`);
  const regions = new Set<SessionWindowRegion>([
    'top-left', 'top-right', 'bottom-left', 'bottom-right', 'center',
  ]);
  if (typeof value.region !== 'string' || !regions.has(value.region as SessionWindowRegion)) {
    throw new TypeError(`${SESSION_WINDOW_PLACE_COMMAND} region is invalid`);
  }
  if (value.displayId !== undefined && (typeof value.displayId !== 'string' || !value.displayId.trim())) {
    throw new TypeError(`${SESSION_WINDOW_PLACE_COMMAND} displayId must be a non-empty string`);
  }
  if (value.marginDip !== undefined
    && (typeof value.marginDip !== 'number'
      || !Number.isFinite(value.marginDip)
      || value.marginDip < 0
      || value.marginDip > 4_096)) {
    throw new TypeError(`${SESSION_WINDOW_PLACE_COMMAND} marginDip must be from 0 to 4096`);
  }
  return {
    region: value.region as SessionWindowRegion,
    ...(typeof value.displayId === 'string' ? { displayId: value.displayId.trim() } : {}),
    ...(typeof value.marginDip === 'number' ? { marginDip: value.marginDip } : {}),
  };
}

function requireConversationTarget(value: ApplicationTarget | undefined): ApplicationTarget {
  if (!value || value.kind !== 'conversation-session') {
    throw new TypeError('Session window operation target kind must be conversation-session');
  }
  return value;
}

function requireRevisionedConversationTarget(value: ApplicationTarget | undefined): ApplicationTarget {
  const target = requireConversationTarget(value);
  if (!target.expectedRevision) {
    throw new TypeError('Session window command target must include expectedRevision');
  }
  return target;
}

function sessionWindowResource(target: ApplicationTarget): string {
  return `session-window:${target.id}`;
}

function sessionWindowBounds(value: ApplicationData | undefined, label: string): SessionWindowBounds {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  exactKeys(value, ['x', 'y', 'width', 'height', 'displayId', 'revision'], label);
  const x = finite(value.x, `${label}.x`);
  const y = finite(value.y, `${label}.y`);
  const width = positive(value.width, `${label}.width`);
  const height = positive(value.height, `${label}.height`);
  const displayId = optionalNonEmpty(value.displayId, `${label}.displayId`);
  const revision = optionalNonEmpty(value.revision, `${label}.revision`);
  return {
    x, y, width, height,
    ...(displayId ? { displayId } : {}),
    ...(revision ? { revision } : {}),
  };
}

function placeResult(value: ApplicationData): SessionWindowPlaceResult {
  if (!isRecord(value)) throw new TypeError(`${SESSION_WINDOW_PLACE_COMMAND} result must be an object`);
  exactKeys(value, ['applied', 'bounds'], `${SESSION_WINDOW_PLACE_COMMAND} result`);
  if (value.applied !== true) throw new TypeError(`${SESSION_WINDOW_PLACE_COMMAND} result.applied must be true`);
  return {
    applied: true,
    bounds: sessionWindowBounds(value.bounds, `${SESSION_WINDOW_PLACE_COMMAND} result.bounds`),
  };
}

function finite(value: ApplicationData | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function positive(value: ApplicationData | undefined, label: string): number {
  const result = finite(value, label);
  if (result <= 0) throw new TypeError(`${label} must be positive`);
  return result;
}

function optionalNonEmpty(value: ApplicationData | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function exactKeys(value: Record<string, ApplicationData>, allowed: string[], label: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter(key => !known.has(key));
  if (unknown.length) throw new TypeError(`${label} contains unknown field ${unknown[0]}`);
}

function isRecord(value: ApplicationData | undefined): value is Record<string, ApplicationData> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
