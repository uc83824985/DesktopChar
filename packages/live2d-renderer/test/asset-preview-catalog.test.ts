import assert from 'node:assert/strict';
import test from 'node:test';
import { createLive2dAssetPreviewCatalog } from '../src/index.ts';

test('asset preview catalog keeps raw expression and motion identities', () => {
  const catalog = createLive2dAssetPreviewCatalog({
    FileReferences: {
      Expressions: [
        { Name: 'exp_01', File: 'expressions/exp_01.exp3.json' },
        { Name: 'exp_02', File: 'expressions/exp_02.exp3.json' },
      ],
      Motions: {
        Idle: [{ File: 'motions/idle.motion3.json' }],
        TapBody: [
          { File: 'motions/tap_01.motion3.json' },
          { File: 'motions/tap_02.motion3.json' },
        ],
      },
    },
  });

  assert.deepEqual(catalog, {
    expressions: [
      { id: 'exp_01', file: 'expressions/exp_01.exp3.json' },
      { id: 'exp_02', file: 'expressions/exp_02.exp3.json' },
    ],
    motions: [
      { id: 'Idle:0', group: 'Idle', index: 0, file: 'motions/idle.motion3.json' },
      { id: 'TapBody:0', group: 'TapBody', index: 0, file: 'motions/tap_01.motion3.json' },
      { id: 'TapBody:1', group: 'TapBody', index: 1, file: 'motions/tap_02.motion3.json' },
    ],
  });
});

test('asset preview catalog rejects malformed resource definitions', () => {
  assert.throws(
    () => createLive2dAssetPreviewCatalog({ FileReferences: { Expressions: [{ File: 'missing-name' }] } }),
    /Name/,
  );
  assert.throws(
    () => createLive2dAssetPreviewCatalog({ FileReferences: { Motions: { TapBody: {} } } }),
    /must be an array/,
  );
});
