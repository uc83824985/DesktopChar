const SENTENCE_END = /[。！？!?]+[”’」』）》】]*/gu;

export function formatChatBubbleFragment(
  fullText: string,
  start: number,
  end: number,
): string {
  if (!Number.isInteger(start) || !Number.isInteger(end)
    || start < 0 || end < start || end > fullText.length) {
    throw new RangeError('Chat bubble fragment range is invalid');
  }
  const breakOffsets = sentenceBreakOffsets(fullText);
  let formatted = '';
  for (let index = start; index < end;) {
    const codePoint = fullText.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    if ((character === ' ' || character === '\t')
      && followsInsertedBreak(fullText, index, breakOffsets)) {
      index += character.length;
      continue;
    }
    formatted += character;
    index += character.length;
    if (breakOffsets.has(index)) formatted += '\n';
  }
  return formatted;
}

function followsInsertedBreak(fullText: string, index: number, breakOffsets: ReadonlySet<number>): boolean {
  let whitespaceStart = index;
  while (whitespaceStart > 0 && (fullText[whitespaceStart - 1] === ' ' || fullText[whitespaceStart - 1] === '\t')) {
    whitespaceStart--;
  }
  return breakOffsets.has(whitespaceStart);
}

function sentenceBreakOffsets(fullText: string): Set<number> {
  const offsets = new Set<number>();
  for (const match of fullText.matchAll(SENTENCE_END)) {
    const offset = match.index + match[0].length;
    if (offset >= fullText.length || fullText[offset] === '\r' || fullText[offset] === '\n') continue;
    offsets.add(offset);
  }
  return offsets;
}
