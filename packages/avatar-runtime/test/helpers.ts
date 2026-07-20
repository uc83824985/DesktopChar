import type { AvatarCapabilities, PerformancePlan } from '../../contracts/src/index.ts';

export const capabilities: AvatarCapabilities = {
  emotions: ['neutral', 'happy'],
  actions: ['nod'],
  parameters: ['ParamAngleX', 'ParamAngleY', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamMouthOpenY', 'ParamMouthForm'],
  supportsMouthForm: true,
  supportsGaze: true,
  supportsHitTest: false,
};

export const plan: PerformancePlan = {
  id: 'plan-1',
  segments: [
    {
      id: 'segment-1',
      sequence: 0,
      displayText: '你好。',
      speechText: '你好。',
      emotion: { emotion: 'happy', intensity: 0.6, atMs: 0 },
      actions: [{ id: 'nod-1', action: 'nod', atMs: 200 }],
    },
  ],
};
