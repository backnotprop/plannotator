export type ReviewSearchSide = 'addition' | 'deletion' | 'context';

const DIFF_METADATA_PREFIXES = [
  'diff ',
  'index ',
  '--- ',
  '+++ ',
  'new file mode ',
  'deleted file mode ',
  'similarity index ',
  'rename from ',
  'rename to ',
  'old mode ',
  'new mode ',
] as const;

const SNIPPET_CONTEXT = 28;

export interface ReviewSearchableDiffFile {
  path: string;
  oldPath?: string;
  patch: string;
  additions: number;
  deletions: number;
}

export interface ReviewSearchMatch {
  id: string;
  filePath: string;
  side: ReviewSearchSide;
  lineNumber: number;
  altLineNumber?: number;
  text: string;
  matchStart: number;
  matchEnd: number;
  snippet: string;
}

export interface ReviewSearchFileGroup {
  filePath: string;
  fileIndex: number;
  matches: ReviewSearchMatch[];
}

interface SearchableLine {
  filePath: string;
  side: ReviewSearchSide;
  lineNumber: number;
  altLineNumber?: number;
  text: string;
}

function isDiffMetadataLine(line: string): boolean {
  return DIFF_METADATA_PREFIXES.some(prefix => line.startsWith(prefix));
}

function buildSearchableLinesForPatch(file: ReviewSearchableDiffFile): SearchableLine[] {
  const lines = file.patch.split('\n');
  const searchableLines: SearchableLine[] = [];

  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10) - 1;
      newLine = parseInt(hunkMatch[2], 10) - 1;
      continue;
    }

    if (isDiffMetadataLine(line)) {
      continue;
    }

    const prefix = line[0];
    const text = line.slice(1);
    if (prefix === ' ') {
      oldLine += 1;
      newLine += 1;
      searchableLines.push({
        filePath: file.path,
        side: 'context',
        lineNumber: newLine,
        altLineNumber: oldLine,
        text,
      });
      continue;
    }

    if (prefix === '-') {
      oldLine += 1;
      searchableLines.push({
        filePath: file.path,
        side: 'deletion',
        lineNumber: oldLine,
        text,
      });
      continue;
    }

    if (prefix === '+') {
      newLine += 1;
      searchableLines.push({
        filePath: file.path,
        side: 'addition',
        lineNumber: newLine,
        text,
      });
    }
  }

  return searchableLines;
}

function buildSnippet(text: string, start: number, end: number): string {
  const snippetStart = Math.max(0, start - SNIPPET_CONTEXT);
  const snippetEnd = Math.min(text.length, end + SNIPPET_CONTEXT);
  const prefix = snippetStart > 0 ? '...' : '';
  const suffix = snippetEnd < text.length ? '...' : '';
  return `${prefix}${text.slice(snippetStart, snippetEnd)}${suffix}`;
}

export function findReviewSearchMatches(files: ReviewSearchableDiffFile[], query: string): ReviewSearchMatch[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const normalizedQuery = trimmedQuery.toLowerCase();
  const matches: ReviewSearchMatch[] = [];

  files.forEach((file) => {
    const searchableLines = buildSearchableLinesForPatch(file);

    searchableLines.forEach((line) => {
      const normalizedText = line.text.toLowerCase();
      let fromIndex = 0;
      let matchCountForLine = 0;

      while (fromIndex <= normalizedText.length) {
        const matchStart = normalizedText.indexOf(normalizedQuery, fromIndex);
        if (matchStart === -1) break;

        const matchEnd = matchStart + normalizedQuery.length;
        matches.push({
          id: `${line.filePath}:${line.side}:${line.lineNumber}:${matchStart}:${matchCountForLine}`,
          filePath: line.filePath,
          side: line.side,
          lineNumber: line.lineNumber,
          altLineNumber: line.altLineNumber,
          text: line.text,
          matchStart,
          matchEnd,
          snippet: buildSnippet(line.text, matchStart, matchEnd),
        });

        matchCountForLine += 1;
        fromIndex = matchStart + Math.max(1, normalizedQuery.length);
      }
    });
  });

  return matches;
}

export function groupReviewSearchMatches(
  files: ReviewSearchableDiffFile[],
  matches: ReviewSearchMatch[],
): ReviewSearchFileGroup[] {
  const fileIndexByPath = new Map(files.map((file, index) => [file.path, index]));
  const groups = new Map<string, ReviewSearchFileGroup>();

  matches.forEach((match) => {
    const existing = groups.get(match.filePath);
    if (existing) {
      existing.matches.push(match);
      return;
    }

    groups.set(match.filePath, {
      filePath: match.filePath,
      fileIndex: fileIndexByPath.get(match.filePath) ?? -1,
      matches: [match],
    });
  });

  return files
    .map((file, fileIndex) => groups.get(file.path) ?? null)
    .filter((group): group is ReviewSearchFileGroup => group !== null)
    .map(group => ({
      ...group,
      fileIndex: group.fileIndex >= 0 ? group.fileIndex : (fileIndexByPath.get(group.filePath) ?? -1),
    }));
}

export function getReviewSearchSideLabel(side: ReviewSearchSide): string {
  if (side === 'addition') return 'new';
  if (side === 'deletion') return 'old';
  return 'ctx';
}
