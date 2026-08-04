export function createApplicationServiceTestRegistry(registrations, options = {}) {
  const clock = options.clock ?? (() => new Date().toISOString());
  const now = options.now ?? (() => performance.now());
  const entries = registrations.map(validateRegistration);
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`Duplicate application service test id: ${entry.id}`);
    ids.add(entry.id);
  }

  async function testAll() {
    return Promise.all(entries.map(run));
  }

  async function run(entry) {
    const startedAt = now();
    try {
      if (!entry.enabled()) return result(entry, 'skipped', '服务未启用', startedAt);
      const tested = await entry.test();
      const details = typeof tested === 'string'
        ? tested
        : typeof tested?.details === 'string' ? tested.details : '连接正常';
      return result(entry, 'passed', details, startedAt);
    }
    catch (error) {
      return result(entry, 'failed', errorMessage(error), startedAt);
    }
  }

  function result(entry, status, details, startedAt) {
    return {
      id: entry.id,
      label: entry.label,
      enabled: status !== 'skipped',
      status,
      testedAt: clock(),
      latencyMs: Math.max(0, Math.round(now() - startedAt)),
      details,
    };
  }

  return { testAll };
}

function validateRegistration(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Application service test registration ${index} must be an object`);
  }
  if (typeof value.id !== 'string' || !value.id.trim()) {
    throw new TypeError(`Application service test registration ${index} requires an id`);
  }
  if (typeof value.label !== 'string' || !value.label.trim()) {
    throw new TypeError(`Application service test registration ${index} requires a label`);
  }
  if (typeof value.enabled !== 'function' || typeof value.test !== 'function') {
    throw new TypeError(`Application service test registration ${value.id} requires enabled and test functions`);
  }
  return { id: value.id.trim(), label: value.label.trim(), enabled: value.enabled, test: value.test };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
