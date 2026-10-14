/**
 * The source scan behind tests/no-browser-sentinel.test.ts: finds a test or
 * script that gives PLANNOTATOR_BROWSER (or the CLI's `--browser`) a no-op
 * sentinel value. Pure functions over one file's text, so the test runs them
 * over the repo AND over fixtures in memory.
 *
 * Why it matters: packages/server/browser.ts treats `none`, `true`, `false`,
 * `:`, `0` and `1` (any case, surrounding spaces ignored) as "no browser
 * configured" (#756) and falls through to the system default, which opens a
 * real tab on the developer's screen. Use NO_BROWSER from
 * tests/helpers/no-browser.ts instead.
 *
 * Comments are blanked first (a comment that explains the bug is not the bug).
 * A line that tests the sentinel handling itself, in process, without opening
 * anything, may carry `no-browser-guard: sentinel under test` in a comment on
 * that line or the line above.
 */
import { stripComments } from "./real-inbox-scan";

/** The marker for a line that deliberately sets a sentinel to test its handling. */
export const SENTINEL_UNDER_TEST_MARK = "no-browser-guard: sentinel under test";

/** The values packages/server/browser.ts NOOP_BROWSER_VALUES reads as unset. */
const SENTINEL = String.raw`\s*(?:none|true|false|0|1|:)\s*`;

/** A sentinel value, quoted (a TS, JSON, YAML or shell string) or bare (shell, YAML). */
const VALUE = String.raw`(?:"${SENTINEL}"|'${SENTINEL}'|\`${SENTINEL}\`|(?:none|true|false|0|1|:)(?=[\s;,)}\]&|]|$))`;

const PATTERNS: RegExp[] = [
  // `PLANNOTATOR_BROWSER: "none"`, `"PLANNOTATOR_BROWSER": "none"`,
  // `process.env.PLANNOTATOR_BROWSER = "none"`, `process.env["PLANNOTATOR_BROWSER"] = 'none'`,
  // `PLANNOTATOR_BROWSER=none cmd`, `export PLANNOTATOR_BROWSER=true`,
  // `$env:PLANNOTATOR_BROWSER = "none"`, YAML `PLANNOTATOR_BROWSER: none`.
  new RegExp(String.raw`PLANNOTATOR_BROWSER["'\]]*\s*(?:=|:)\s*${VALUE}`, "gim"),
  // The CLI flag sets PLANNOTATOR_BROWSER (apps/hook/server/index.ts):
  // `--browser none`, `--browser=none`, `"--browser", "none"`.
  new RegExp(String.raw`--browser(?:=|\s+)${VALUE}`, "gim"),
  new RegExp(String.raw`["'\`]--browser["'\`]\s*,\s*${VALUE}`, "gim"),
];

/** `text` with `#` comments blanked (shell, YAML, PowerShell); strings are not tracked. */
export function stripHashComments(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, (match, lead: string) => lead + " ".repeat(match.length - lead.length)))
    .join("\n");
}

/** True for a source whose comments are `//` and `/* *\/`; everything else is read as `#`-commented. */
function isJsLike(file: string): boolean {
  return /\.(?:ts|tsx|mts|js|mjs|cjs)$/.test(file);
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** Each `<line>: <match>` where `source` sets PLANNOTATOR_BROWSER (or `--browser`) to a no-op sentinel. */
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
