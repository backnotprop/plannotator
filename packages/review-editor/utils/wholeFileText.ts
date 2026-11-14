export const WHOLE_FILE_EAGER_LINE_LIMIT = 1200;

export interface WholeFileText {
  oldContent: string | null;
  newContent: string | null;
}

function lineCount(text: string | null): number {
  if (!text) return 0;
  let lines = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines += 1;
  return text.endsWith('\n') ? lines - 1 : lines;
}

export function opensWholeFileEagerly(text: WholeFileText, limit = WHOLE_FILE_EAGER_LINE_LIMIT): boolean {
  return Math.max(lineCount(text.oldContent), lineCount(text.newContent)) <= limit;
}

export interface KeptWholeFiles {
  keep(itemId: string, generation: string, text: WholeFileText): void;
  read(
    itemId: string,
    generation: string,
    readFresh: () => Promise<WholeFileText | null>,
  ): Promise<WholeFileText | null>;
  keepOnly(generation: string): void;
}

export function createKeptWholeFiles(): KeptWholeFiles {
  const kept = new Map<string, { generation: string; text: WholeFileText }>();
  return {
    keep(itemId, generation, text) {
      kept.set(itemId, { generation, text });
    },
    read(itemId, generation, readFresh) {
      const entry = kept.get(itemId);
      kept.delete(itemId);
      if (entry && entry.generation === generation) return Promise.resolve(entry.text);
      return readFresh();
    },
    keepOnly(generation) {
      for (const [itemId, entry] of kept) if (entry.generation !== generation) kept.delete(itemId);
    },
  };
}
