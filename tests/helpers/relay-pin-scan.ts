import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const DEAD_RELAY = "http://127.0.0.1:9";

const PINNED = /PLANNOTATOR_RELAY_URL|\.\.\.\s*process\.env\b|\.\.\.\s*worldEnv\(/;

function enclosingObject(text: string, at: number): { start: number; end: number } | null {
  let depth = 0;
  let start = -1;
  for (let i = at; i >= 0; i--) {
    const c = text[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return null;
  depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return { start, end: i };
  }
  return null;
}

export function unpinnedInboxEnvs(text: string): number[] {
  const offsets: number[] = [];
  for (const match of text.matchAll(/\bPLANNOTATOR_DATA_DIR\s*:/g)) {
    const object = enclosingObject(text, match.index!);
    if (!object) continue;
    if (!PINNED.test(text.slice(object.start, object.end + 1))) offsets.push(match.index!);
  }
  return offsets;
}

export function unpinnedE2eEnvs(root: string): string[] {
  const dir = join(root, "tests", "e2e");
  const lines: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const file = join(entry.parentPath, entry.name);
    const text = readFileSync(file, "utf8");
    for (const at of unpinnedInboxEnvs(text)) lines.push(`${relative(root, file)}:${text.slice(0, at).split("\n").length}`);
  }
  return lines;
}

const ENV_BOUND = /(?:\benv|Env)\s*(?::\s*Record<[^>]*>)?\s*[:=]\s*$/;

export function unpinnedChildEnvs(text: string): number[] {
  return unpinnedInboxEnvs(text).filter((at) => {
    const object = enclosingObject(text, at);
    return object !== null && ENV_BOUND.test(text.slice(Math.max(0, object.start - 80), object.start));
  });
}

const OWN_RELAY_OR_NOT_A_CHILD = ["apps/relay/test/", "tests/e2e/", "tests/e2e-relay-pin.test.ts", "packages/system/test/schedule.test.ts"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".local", ".wrangler"]);

export function unpinnedUnitEnvs(root: string): string[] {
  const lines: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      const path = relative(root, file);
      if (!/\.test\.tsx?$/.test(entry.name) || OWN_RELAY_OR_NOT_A_CHILD.some((skip) => path.startsWith(skip))) continue;
      const text = readFileSync(file, "utf8");
      for (const at of unpinnedChildEnvs(text)) lines.push(`${path}:${text.slice(0, at).split("\n").length}`);
    }
  };
  for (const top of ["tests", "packages", "apps"]) walk(join(root, top));
  return lines;
}
