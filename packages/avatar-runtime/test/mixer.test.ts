import assert from 'node:assert/strict';
import test from 'node:test';
import { ParameterMixer } from '../src/mixer.ts';
import { capabilities } from './helpers.ts';

test('mouth owns mouth-open even when gesture and expression write it', () => {
  const mixer = new ParameterMixer({
    ranges: { ParamMouthOpenY: { min: 0, max: 1 } },
  });
  const frame = mixer.mix({
    base: { ParamMouthOpenY: { value: 0.1 } },
    gaze: {},
    expression: { ParamMouthOpenY: { value: 0.2 } },
    gesture: { ParamMouthOpenY: { value: 0.3 } },
    mouth: { ParamMouthOpenY: { value: 1.4 } },
  }, capabilities);
  assert.equal(frame.ParamMouthOpenY, 1);
});

test('mixer filters unsupported parameters and applies layer priority', () => {
  const frame = new ParameterMixer().mix({
    base: { ParamAngleX: { value: 1 }, Unsupported: { value: 9 } },
    gaze: { ParamAngleX: { value: 2 } },
    expression: { ParamAngleX: { value: 3 } },
    gesture: { ParamAngleX: { value: 4 } },
    mouth: {},
  }, capabilities);
  assert.deepEqual(frame, { ParamAngleX: 4 });
});
