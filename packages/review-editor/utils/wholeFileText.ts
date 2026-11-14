export interface WholeFileText {
  oldContent: string | null;
  newContent: string | null;
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
