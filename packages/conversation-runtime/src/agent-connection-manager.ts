import type {
  AgentConnectionSnapshot,
  AgentRegistration,
  CharAgentEndpoint,
  CharAgentExecution,
  CharReplyTask,
} from './types.ts';

interface ConnectionRecord {
  registration: AgentRegistration;
  endpoint: CharAgentEndpoint;
  active: number;
  healthy: boolean;
  registrationOrder: number;
  lastAssignedOrder: number;
  controllers: Set<AbortController>;
}

interface PendingDispatch {
  task: CharReplyTask;
  signal: AbortSignal;
  resolve: (execution: CharAgentExecution) => void;
  reject: (error: unknown) => void;
  removeAbortListener: () => void;
}

export class AgentConnectionManager {
  private readonly records = new Map<string, ConnectionRecord>();
  private readonly pending: PendingDispatch[] = [];
  private registrationSequence = 0;
  private assignmentSequence = 0;
  private closed = false;

  register(registration: AgentRegistration, endpoint: CharAgentEndpoint): () => void {
    if (this.closed) throw new Error('AgentConnectionManager is closed');
    validateRegistration(registration);
    const key = connectionKey(registration.agentId, registration.instanceId);
    if (this.records.has(key)) throw new Error(`Agent instance is already registered: ${key}`);
    this.records.set(key, {
      registration: cloneRegistration(registration),
      endpoint,
      active: 0,
      healthy: true,
      registrationOrder: this.registrationSequence++,
      lastAssignedOrder: -1,
      controllers: new Set(),
    });
    this.pump();
    return () => this.unregister(registration.agentId, registration.instanceId);
  }

  unregister(agentId: string, instanceId: string): void {
    const key = connectionKey(agentId, instanceId);
    const record = this.records.get(key);
    if (!record) return;
    this.records.delete(key);
    record.healthy = false;
    for (const controller of record.controllers) controller.abort(new Error(`Agent instance disconnected: ${key}`));
    this.pump();
  }

  setHealthy(agentId: string, instanceId: string, healthy: boolean): void {
    const record = this.records.get(connectionKey(agentId, instanceId));
    if (!record) throw new Error(`Unknown agent instance: ${agentId}/${instanceId}`);
    record.healthy = healthy;
    if (!healthy) {
      for (const controller of record.controllers) controller.abort(new Error(`Agent instance became unhealthy: ${agentId}/${instanceId}`));
    }
    this.pump();
  }

  dispatch(task: CharReplyTask, signal: AbortSignal): Promise<CharAgentExecution> {
    if (this.closed) return Promise.reject(new Error('AgentConnectionManager is closed'));
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.pending.indexOf(entry);
        if (index >= 0) this.pending.splice(index, 1);
        reject(abortReason(signal));
      };
      const entry: PendingDispatch = {
        task,
        signal,
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener('abort', onAbort),
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.push(entry);
      this.pump();
    });
  }

  getSnapshot(nowMs = Date.now()): readonly AgentConnectionSnapshot[] {
    return [...this.records.values()]
      .sort((a, b) => a.registrationOrder - b.registrationOrder)
      .map(record => {
        const registration = record.registration;
        const healthy = record.healthy
          && (registration.leaseExpiresAtMs === undefined || registration.leaseExpiresAtMs > nowMs);
        return {
          agentId: registration.agentId,
          instanceId: registration.instanceId,
          protocolVersion: registration.protocolVersion,
          capabilities: [...registration.capabilities],
          maxConcurrency: registration.maxConcurrency,
          active: record.active,
          healthy,
          ...(registration.leaseExpiresAtMs === undefined ? {} : { leaseExpiresAtMs: registration.leaseExpiresAtMs }),
        };
      });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error('AgentConnectionManager is closed');
    for (const entry of this.pending.splice(0)) {
      entry.removeAbortListener();
      entry.reject(error);
    }
    for (const record of this.records.values()) {
      for (const controller of record.controllers) controller.abort(error);
    }
    this.records.clear();
  }

  private pump(): void {
    if (this.closed) return;
    while (this.pending.length > 0) {
      const record = this.selectConnection();
      if (!record) return;
      const entry = this.pending.shift();
      if (!entry) return;
      entry.removeAbortListener();
      if (entry.signal.aborted) {
        entry.reject(abortReason(entry.signal));
        continue;
      }
      this.start(record, entry);
    }
  }

  private selectConnection(nowMs = Date.now()): ConnectionRecord | undefined {
    return [...this.records.values()]
      .filter(record => record.healthy
        && record.registration.capabilities.includes('char-reply')
        && record.active < record.registration.maxConcurrency
        && (record.registration.leaseExpiresAtMs === undefined || record.registration.leaseExpiresAtMs > nowMs))
      .sort((a, b) => {
        const utilization = a.active / a.registration.maxConcurrency - b.active / b.registration.maxConcurrency;
        if (utilization !== 0) return utilization;
        if (a.lastAssignedOrder !== b.lastAssignedOrder) return a.lastAssignedOrder - b.lastAssignedOrder;
        return a.registrationOrder - b.registrationOrder;
      })[0];
  }

  private start(record: ConnectionRecord, entry: PendingDispatch): void {
    const controller = new AbortController();
    const onAbort = () => controller.abort(abortReason(entry.signal));
    entry.signal.addEventListener('abort', onAbort, { once: true });
    record.controllers.add(controller);
    record.active++;
    record.lastAssignedOrder = this.assignmentSequence++;
    void Promise.resolve()
      .then(() => record.endpoint.execute(entry.task, controller.signal))
      .then(result => entry.resolve({
        agentId: record.registration.agentId,
        instanceId: record.registration.instanceId,
        result,
      }), entry.reject)
      .finally(() => {
        entry.signal.removeEventListener('abort', onAbort);
        record.controllers.delete(controller);
        record.active--;
        this.pump();
      });
  }
}

function validateRegistration(value: AgentRegistration): void {
  if (!value.agentId.trim() || !value.instanceId.trim()) throw new TypeError('Agent registration requires agentId and instanceId');
  if (!value.protocolVersion.trim()) throw new TypeError('Agent registration requires protocolVersion');
  if (!value.capabilities.includes('char-reply')) {
    throw new TypeError('Agent registration must include the char-reply capability');
  }
  if (!Number.isInteger(value.maxConcurrency) || value.maxConcurrency <= 0) {
    throw new RangeError('Agent maxConcurrency must be a positive integer');
  }
  if (value.leaseExpiresAtMs !== undefined && !Number.isFinite(value.leaseExpiresAtMs)) {
    throw new RangeError('Agent leaseExpiresAtMs must be finite');
  }
}

function cloneRegistration(value: AgentRegistration): AgentRegistration {
  return {
    agentId: value.agentId,
    instanceId: value.instanceId,
    protocolVersion: value.protocolVersion,
    capabilities: [...value.capabilities],
    maxConcurrency: value.maxConcurrency,
    ...(value.leaseExpiresAtMs === undefined ? {} : { leaseExpiresAtMs: value.leaseExpiresAtMs }),
  };
}

function connectionKey(agentId: string, instanceId: string): string {
  return `${agentId}\u0000${instanceId}`;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}
