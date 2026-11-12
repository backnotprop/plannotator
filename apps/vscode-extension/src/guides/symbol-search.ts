import { readFile } from "node:fs/promises";
import { realFileInside } from "./safe-path";

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
