import { diffLines } from 'diff';

export interface SuggestionHunk {
  lineStart: number;
  lineEnd: number;
  originalCode: string;
  suggestedCode: string;
}

function normalize(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

interface RawRegion {
  start: number;
  originalLines: string[];
  suggestedLines: string[];
}

interface PendingHunk {
  lineStart: number;
  lineEnd: number;
  origLines: string[];
  suggLines: string[];
}

export function deriveSuggestionHunks(preEditContent: string, editedContent: string): SuggestionHunk[] {
  const original = normalize(preEditContent);
  const edited = normalize(editedContent);
  if (original === edited) return [];

  const originalLines = splitLines(original);
  const parts = diffLines(original, edited);

  const regions: RawRegion[] = [];
  let current: RawRegion | null = null;
  let origLine = 1;

  for (const part of parts) {
    const lines = splitLines(part.value);
    if (part.added) {
      if (!current) current = { start: origLine, originalLines: [], suggestedLines: [] };
      current.suggestedLines.push(...lines);
    } else if (part.removed) {
      if (!current) current = { start: origLine, originalLines: [], suggestedLines: [] };
      current.originalLines.push(...lines);
      origLine += lines.length;
    } else {
      if (current) {
        regions.push(current);
        current = null;
      }
      origLine += lines.length;
    }
  }
  if (current) regions.push(current);

  const lineCount = originalLines.length;
  const hunks: PendingHunk[] = [];
  const prevEnd = () => (hunks.length > 0 ? hunks[hunks.length - 1].lineEnd : 0);

  for (const region of regions) {
    const rawStart = region.start;
    const rawEnd = rawStart + region.originalLines.length - 1;
    const isInsert = region.originalLines.length === 0;
    const isDelete = !isInsert && region.suggestedLines.length === 0;

    if (!isInsert && !isDelete) {
      hunks.push({
        lineStart: rawStart,
        lineEnd: rawEnd,
        origLines: [...region.originalLines],
        suggLines: [...region.suggestedLines],
      });
      continue;
    }

    const backwardLine = rawStart - 1;
    const canBackward = backwardLine >= 1 && backwardLine > prevEnd();
    const forwardLine = rawEnd + 1;
    const canForward = forwardLine <= lineCount;

    if (canBackward) {
      const anchor = originalLines[backwardLine - 1];
      hunks.push(
        isInsert
          ? {
              lineStart: backwardLine,
              lineEnd: backwardLine,
              origLines: [anchor],
              suggLines: [anchor, ...region.suggestedLines],
            }
          : {
              lineStart: backwardLine,
              lineEnd: rawEnd,
              origLines: [anchor, ...region.originalLines],
              suggLines: [anchor],
            },
      );
    } else if (canForward) {
      const anchor = originalLines[forwardLine - 1];
      hunks.push(
        isInsert
          ? {
              lineStart: forwardLine,
              lineEnd: forwardLine,
              origLines: [anchor],
              suggLines: [...region.suggestedLines, anchor],
            }
          : {
              lineStart: rawStart,
              lineEnd: forwardLine,
              origLines: [...region.originalLines, anchor],
              suggLines: [anchor],
            },
      );
    } else if (hunks.length > 0 && prevEnd() === rawStart - 1) {
      const prev = hunks[hunks.length - 1];
      prev.lineEnd = Math.max(prev.lineEnd, rawEnd);
      prev.origLines.push(...region.originalLines);
      prev.suggLines.push(...region.suggestedLines);
    } else {
      hunks.push({
        lineStart: rawStart,
        lineEnd: Math.max(rawEnd, rawStart),
        origLines: [...region.originalLines],
        suggLines: [...region.suggestedLines],
      });
    }
  }

  const folded: PendingHunk[] = [];
  for (const hunk of hunks) {
    const prev = folded[folded.length - 1];
    if (prev && hunk.lineStart <= prev.lineEnd) {
      prev.lineEnd = Math.max(prev.lineEnd, hunk.lineEnd);
      prev.origLines = originalLines.slice(prev.lineStart - 1, prev.lineEnd);
      prev.suggLines = [...prev.suggLines, ...hunk.suggLines];
      continue;
    }
    folded.push(hunk);
  }

  return folded.map((hunk) => ({
    lineStart: hunk.lineStart,
    lineEnd: hunk.lineEnd,
    originalCode: hunk.origLines.join('\n'),
    suggestedCode: hunk.suggLines.join('\n'),
  }));
}
