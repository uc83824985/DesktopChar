import assert from 'node:assert/strict';
import test from 'node:test';
import { formatChatBubbleFragment } from '../src/index.ts';

test('starts each sentence on a new visual line without changing the source text', () => {
  const source = '第一句。第二句！第三句？';
  assert.equal(formatChatBubbleFragment(source, 0, source.length), '第一句。\n第二句！\n第三句？');
  assert.equal(source, '第一句。第二句！第三句？');
  const spaced = '第一句。  第二句。';
  assert.equal(formatChatBubbleFragment(spaced, 0, spaced.length), '第一句。\n第二句。');
});

test('keeps closing quotes with sentence punctuation and preserves authored newlines', () => {
  const quoted = '她说：“你好。”然后挥手。';
  assert.equal(formatChatBubbleFragment(quoted, 0, quoted.length), '她说：“你好。”\n然后挥手。');
  assert.equal(formatChatBubbleFragment('已有换行。\n下一句。', 0, 10), '已有换行。\n下一句。');
});

test('fragment boundaries insert the same break while streaming or highlighting', () => {
  const source = '上一句。下一句。';
  assert.equal(formatChatBubbleFragment(source, 0, 4), '上一句。\n');
  assert.equal(formatChatBubbleFragment(source, 4, source.length), '下一句。');
  assert.throws(() => formatChatBubbleFragment(source, -1, 2), /range/);
});
