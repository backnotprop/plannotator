import { stripComments } from "./real-inbox-scan";

export const SENTINEL_UNDER_TEST_MARK = "no-browser-guard: sentinel under test";

const SENTINEL = String.raw`\s*(?:none|true|false|0|1|:)\s*`;

const VALUE = String.raw`(?:"${SENTINEL}"|'${SENTINEL}'|\`${SENTINEL}\`|(?:none|true|false|0|1|:)(?=[\s;,)}\]&|]|$))`;

const PATTERNS: RegExp[] = [
  new RegExp(String.raw`PLANNOTATOR_BROWSER["'\]]*\s*(?:=|:)\s*${VALUE}`, "gim"),
  new RegExp(String.raw`--browser(?:=|\s+)${VALUE}`, "gim"),
  new RegExp(String.raw`["'\`]--browser["'\`]\s*,\s*${VALUE}`, "gim"),
];

export function stripHashComments(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, (match, lead: string) => lead + " ".repeat(match.length - lead.length)))
    .join("\n");
}

function isJsLike(file: string): boolean {
  return /\.(?:ts|tsx|mts|js|mjs|cjs)$/.test(file);
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

export function sentinelBrowserFindings(source: string, file = "x.ts"): string[] {
  const raw = source.split("\n");
  const text = file.endsWith(".json") ? source : isJsLike(file) ? stripComments(source) : stripHashComments(source);
  const found = new Map<number, string>();
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const line = lineOf(text, match.index ?? 0);
      if ([raw[line - 1], raw[line - 2]].some((l) => l?.includes(SENTINEL_UNDER_TEST_MARK))) continue;
      if (!found.has(line)) found.set(line, `${line}: ${match[0].trim()}`);
    }
  }
  return [...found.entries()].sort(([a], [b]) => a - b).map(([, finding]) => finding);
}
