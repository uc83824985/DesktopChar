import assert from 'node:assert/strict';
import test from 'node:test';
import { createPerformanceInferenceConfigState } from './performance-inference-config-state.mjs';

function config(enabled = false, provider = 'qwen35-transformers') {
  return {
    enabled,
    lifecycle: 'external',
    provider,
    baseUrl: 'http://127.0.0.1:18090/v1',
    timeoutMs: 5_000,
    maxOutputTokens: 256,
    temperature: 0.1,
    fallbackToRules: true,
  };
}

test('runtime performance inference toggle preserves the remaining validated config', () => {
  const state = createPerformanceInferenceConfigState(config());
  assert.equal(state.snapshot().enabled, false);
  assert.deepEqual(state.setEnabled(true), { ...config(), enabled: true });
  assert.equal(state.snapshot().provider, 'qwen35-transformers');
});

test('config replacement clears a temporary menu override and adopts the new JSON baseline', () => {
  const state = createPerformanceInferenceConfigState(config(false));
  state.setEnabled(true);
  assert.equal(state.replace(config(false, 'replacement-provider')).enabled, false);
  assert.equal(state.snapshot().provider, 'replacement-provider');
});

test('runtime performance inference toggle rejects malformed state', () => {
  const state = createPerformanceInferenceConfigState(config());
  assert.throws(() => state.setEnabled('true'), /must be boolean/);
  assert.throws(() => state.replace({}), /enabled state must be boolean/);
});
