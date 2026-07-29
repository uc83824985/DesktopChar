import { createSessionMonitorClient } from '../task-manager/session-monitor-client.mjs';
import { createTaskManagerRuntime } from '../task-manager/task-manager-runtime.mjs';

const markerPath = process.env.SESSION_MONITOR_MARKER;
if (!markerPath) {
  throw new Error('Set SESSION_MONITOR_MARKER to the live Session Monitor marker path');
}

const monitor = createSessionMonitorClient({ markerPath });
const runtime = createTaskManagerRuntime({ monitor });
try {
  const discovery = await monitor.discover();
  await runtime.pollOnce();
  const snapshot = runtime.getSnapshot();
  if (snapshot.sessionCount < 1 || snapshot.lastError) {
    throw new Error(`Task Manager did not observe live sessions: ${JSON.stringify(snapshot)}`);
  }
  const running = snapshot.sessions.filter(session => session.state === 'running').length;
  console.log(
    `Task Manager live read smoke passed (marker v${discovery.markerVersion}; `
      + `${snapshot.sessionCount} sessions, ${running} running; no input submitted).`,
  );
}
finally {
  await runtime.close();
}
