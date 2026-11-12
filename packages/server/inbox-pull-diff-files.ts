import { parseDiffToFiles, type DiffFile } from "@plannotator/core/diff-files";

const parsed = new WeakMap<object, Map<string, DiffFile>>();

export function changedFileOf(answer: { readonly patch: string }, path: string): DiffFile | undefined {
  let files = parsed.get(answer);
  if (!files) {
    files = new Map();
    for (const file of parseDiffToFiles(answer.patch)) if (!files.has(file.path)) files.set(file.path, file);
    parsed.set(answer, files);
  }
  return files.get(path);
}
