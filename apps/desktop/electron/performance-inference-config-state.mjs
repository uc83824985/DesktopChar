export function createPerformanceInferenceConfigState(initialConfig) {
  let baseline = validatedConfig(initialConfig);
  let enabledOverride;

  return {
    replace(config) {
      baseline = validatedConfig(config);
      enabledOverride = undefined;
      return this.snapshot();
    },
    setEnabled(enabled) {
      if (typeof enabled !== 'boolean') {
        throw new TypeError('Performance inference enabled state must be boolean');
      }
      enabledOverride = enabled;
      return this.snapshot();
    },
    snapshot() {
      return {
        ...baseline,
        enabled: enabledOverride ?? baseline.enabled,
      };
    },
  };
}

function validatedConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Performance inference config must be an object');
  }
  if (typeof config.enabled !== 'boolean') {
    throw new TypeError('Performance inference config enabled state must be boolean');
  }
  return { ...config };
}
