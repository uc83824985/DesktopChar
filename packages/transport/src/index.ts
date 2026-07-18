import type { PerformancePlan } from '../../contracts/src/index';

export type RuntimeCommand =
  | { type: 'perform'; plan: PerformancePlan }
  | { type: 'interrupt' }
  | { type: 'look-at'; x: number; y: number };

export interface RuntimeTransport {
  send(command: RuntimeCommand): void;
  subscribe(listener: (command: RuntimeCommand) => void): () => void;
}
