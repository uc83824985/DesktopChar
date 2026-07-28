const ACTIVITY_LIMIT = 50;

export function createConversationReplyGateway(options) {
  const createManagedExecutor = options.createManagedExecutor;
  const onStateChanged = options.onStateChanged ?? (() => {});
  let config = structuredClone(options.config);
  let managedExecutor;
  let managedExecutorTimeoutMs;
  let managedActive = 0;
  let managedPhase = 'standby';
  let recreateWhenIdle = false;
  let closed = false;
  const activities = [];

  return {
    execute,
    configure,
    snapshot,
    close,
  };

  async function execute(logicalAgentId, task, signal) {
    if (closed) throw new Error('Conversation reply gateway is closed');
    const activity = {
      activityId: `${task.taskId}:${task.attemptId}`,
      logicalAgentId,
      providerKind: 'managed',
      providerAgentId: 'codex-app-server',
      providerInstanceId: 'managed-main',
      state: 'running',
      input: task.userMessage,
      reply: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    };
    upsertActivity(activity);
    try {
      managedActive++;
      managedPhase = 'active';
      publish();
      if (!managedExecutor) {
        managedExecutorTimeoutMs = config.reply.requestTimeoutMs;
        managedExecutor = createManagedExecutor(managedExecutorTimeoutMs);
      }
      let result;
      try {
        result = await managedExecutor.execute(logicalAgentId, task, signal);
      }
      finally {
        managedActive--;
        managedPhase = managedExecutor ? 'ready' : 'standby';
        if (recreateWhenIdle && managedActive === 0) {
          recreateWhenIdle = false;
          await closeManagedExecutor();
        }
        publish();
      }
      activity.state = 'completed';
      activity.reply = result.segments.map(segment => segment.text).join('\n');
      activity.completedAt = new Date().toISOString();
      upsertActivity(activity);
      return result;
    }
    catch (error) {
      activity.state = signal.aborted ? 'cancelled' : 'failed';
      activity.error = error instanceof Error ? error.message : String(error);
      activity.completedAt = new Date().toISOString();
      upsertActivity(activity);
      throw error;
    }
  }

  function configure(nextConfig) {
    if (closed) return;
    const timeoutChanged = config.reply.requestTimeoutMs !== nextConfig.reply.requestTimeoutMs;
    config = structuredClone(nextConfig);
    if (timeoutChanged && managedExecutor && managedActive === 0) {
      void closeManagedExecutor().then(publish);
    }
    else if (timeoutChanged && managedExecutor) {
      recreateWhenIdle = true;
    }
    publish();
  }

  function snapshot() {
    return {
      maxAssistants: config.maxAssistants,
      managed: {
        phase: managedPhase,
        active: managedActive,
        requestTimeoutMs: managedExecutorTimeoutMs ?? config.reply.requestTimeoutMs,
      },
      activities: activities.map(item => ({ ...item })),
    };
  }

  async function close() {
    if (closed) return;
    closed = true;
    await closeManagedExecutor();
    publish();
  }

  async function closeManagedExecutor() {
    const current = managedExecutor;
    managedExecutor = undefined;
    managedExecutorTimeoutMs = undefined;
    if (!current) {
      managedPhase = 'standby';
      return;
    }
    managedPhase = 'stopping';
    publish();
    await current.close();
    managedPhase = 'standby';
  }

  function upsertActivity(activity) {
    const index = activities.findIndex(item => item.activityId === activity.activityId);
    if (index >= 0) activities.splice(index, 1);
    activities.push({ ...activity });
    if (activities.length > ACTIVITY_LIMIT) activities.splice(0, activities.length - ACTIVITY_LIMIT);
    publish();
  }

  function publish() {
    onStateChanged();
  }
}
