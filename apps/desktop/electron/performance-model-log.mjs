export function filterPerformanceModelOutput(chunk, healthUrl) {
  const output = String(chunk);
  const healthTarget = requestTarget(healthUrl);
  if (!healthTarget) return output;

  return output
    .split(/(?<=\n)/u)
    .filter(line => !isSuccessfulHealthAccessLog(line, healthTarget))
    .join('');
}

export function createPerformanceModelStateLogger(write) {
  let previousKey = '';
  return state => {
    const key = JSON.stringify([
      state.lifecycle,
      state.phase,
      state.lastError,
    ]);
    if (key === previousKey) return false;
    previousKey = key;

    const processDetail = Number.isInteger(state.processId)
      ? ` pid=${state.processId}`
      : '';
    const errorDetail = state.lastError
      ? ` error=${state.lastError}`
      : '';
    write(
      `[performance-model] lifecycle=${state.lifecycle} phase=${state.phase}`
      + `${processDetail}${errorDetail}`,
    );
    return true;
  };
}

function requestTarget(healthUrl) {
  try {
    const url = new URL(healthUrl);
    return `${url.pathname}${url.search}`;
  }
  catch {
    return '';
  }
}

function isSuccessfulHealthAccessLog(line, healthTarget) {
  const request = `"GET ${healthTarget} HTTP/`;
  if (!line.includes(request)) return false;
  const statusStart = line.indexOf('"', line.indexOf(request) + request.length);
  if (statusStart < 0) return false;
  return /^\s+2\d{2}(?:\s|$)/u.test(line.slice(statusStart + 1));
}
