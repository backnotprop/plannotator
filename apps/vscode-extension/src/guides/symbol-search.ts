/**
 * Finding where a symbol is defined by text, in the changed files at the
 * head: the fallback when no language server answers (SPEC 4.4: "or by text
 * search in changed files when no server is running"). Pure apart from
 * reading files.
 */

import { readFile } from "node:fs/promises";
import { realFileInside } from "./safe-path";

/** Imports and re-exports name a symbol without defining it. */
const IMPORT_LINE = /^\s*(import\b|export\s*(\*|\{|type\s*\{)|from\s+["'])/;

export interface SymbolHit {
  path: string;
  line: number;
}

function definitionPatterns(name: string): RegExp[] {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(`\\b(?:function\\*?|class|interface|type|enum|struct|trait|def|fn|func|module|namespace)\\s+${n}\\b`),
    new RegExp(`\\b(?:const|let|var|val)\\s+${n}\\s*[:=]`),
    new RegExp(`^\\s*(?:export\\s+)?(?:public|private|protected|static|async|readonly|\\s)*${n}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::[^={]*)?\\{`),
    new RegExp(`^\\s*${n}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\()`),
  ];
}

/**
 * Definitions of `name` in the given files (repo-relative, read under `root`).
 * A file is read only when it is a regular file inside `root` once symlinks
 * are followed; any other path is skipped unread.
 */
export async function searchDefinitions(root: string, paths: readonly string[], name: string): Promise<SymbolHit[]> {
  const short = name.includes(".") ? name.split(".").pop()! : name;
  const patterns = definitionPatterns(short);
  const hits: SymbolHit[] = [];
  for (const path of paths) {
    const real = realFileInside(root, path);
    if (!real) continue;
    let text: string;
    try {
      text = await readFile(real, "utf8");
    } catch {
      continue;
    }
    if (!text.includes(short)) continue;
    const lines = text.split("\n");
    let inImport = false;
    for (let i = 0; i < lines.length; i++) {
      if (inImport) {
        if (/\bfrom\s+["']|^\s*\}\s*;?\s*$/.test(lines[i])) inImport = false;
        continue;
      }
      if (IMPORT_LINE.test(lines[i])) {
        // A multi-line import or re-export runs until its `from`.
        inImport = /^\s*(import|export)\b.*\{[^}]*$/.test(lines[i]);
        continue;
      }
      if (patterns.some((p) => p.test(lines[i]))) {
        hits.push({ path, line: i + 1 });
        break;
      }
    }
  }
  return hits;
}
