import type { PerformanceTextAnchor } from '../../contracts/src/index.ts';

export interface PerformanceClause {
  text: string;
  anchor: PerformanceTextAnchor;
}

const STRONG_BOUNDARY = /[。！？!?；;\n]/u;
const SOFT_BOUNDARY = /[，,：:]/u;
const MIN_SOFT_CLAUSE_CHARACTERS = 6;
const DEFAULT_MAX_CLAUSES = 6;

/**
 * Splits one TTS segment into a small number of stable semantic clauses.
 *
 * Offsets are Unicode code-point offsets so the result can be carried through
 * inference and later rebound to either estimated playback positions or exact
 * TTS/forced-alignment timestamps.
 */
export function splitPerformanceClauses(
  text: string,
  maxClauses = DEFAULT_MAX_CLAUSES,
): PerformanceClause[] {
  if (!Number.isInteger(maxClauses) || maxClauses <= 0) {
    throw new RangeError('maxClauses must be a positive integer');
  }
  const characters = Array.from(text);
  if (!characters.length) return [];

  const raw: Array<{ start: number; end: number }> = [];
  let start = 0;
  let spokenCharacters = 0;
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index]!;
    if (!/\s/u.test(character) && !STRONG_BOUNDARY.test(character) && !SOFT_BOUNDARY.test(character)) {
      spokenCharacters++;
    }
    const boundary = STRONG_BOUNDARY.test(character)
      || (SOFT_BOUNDARY.test(character) && spokenCharacters >= MIN_SOFT_CLAUSE_CHARACTERS);
    if (!boundary) continue;
    raw.push({ start, end: index + 1 });
    start = index + 1;
    spokenCharacters = 0;
  }
  if (start < characters.length) raw.push({ start, end: characters.length });

  const nonEmpty = raw.filter(range => characters.slice(range.start, range.end).some(char => !/\s/u.test(char)));
  if (!nonEmpty.length) return [];
  const capped = nonEmpty.length <= maxClauses
    ? nonEmpty
    : [
        ...nonEmpty.slice(0, maxClauses - 1),
        {
          start: nonEmpty[maxClauses - 1]!.start,
          end: nonEmpty.at(-1)!.end,
        },
      ];

  return capped.map((range, clauseIndex) => {
    let startCharacter = range.start;
    let endCharacter = range.end;
    while (startCharacter < endCharacter && /\s/u.test(characters[startCharacter]!)) {
      startCharacter++;
    }
    while (endCharacter > startCharacter && /\s/u.test(characters[endCharacter - 1]!)) {
      endCharacter--;
    }
    return {
      text: characters.slice(startCharacter, endCharacter).join(''),
      anchor: {
        clauseIndex,
        clauseCount: capped.length,
        startCharacter,
        endCharacter,
        totalCharacters: characters.length,
      },
    };
  });
}

export function performanceRequestKey(
  segmentId: string,
  anchor: PerformanceTextAnchor,
): string {
  return anchor.clauseCount === 1 ? segmentId : `${segmentId}:clause-${anchor.clauseIndex}`;
}
