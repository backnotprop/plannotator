/**
 * The root AGENTS.md (CLAUDE.md links to it) is read whole by every agent on
 * every session, and some harnesses refuse or cut a large file: it grew to
 * 1.2 MB once (#2192). It is a map now; the detail lives in
 * docs/agent-guides/. This keeps it a map and keeps its links true.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const ROOT_BUDGET_BYTES = 12 * 1024;

/** Relative markdown link targets in a file, without any `#anchor`. */
function localLinks(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const targets: string[] = [];
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1]!.split("#")[0]!;
    if (!target || /^[a-z]+:/i.test(target)) continue;
    targets.push(join(dirname(file), target));
  }
  return targets;
}

describe("root AGENTS.md", () => {
  const agents = join(root, "AGENTS.md");

  test(`stays a map: at most ${ROOT_BUDGET_BYTES} bytes`, () => {
    const size = readFileSync(agents).byteLength;
    expect(size, "AGENTS.md grew past its budget: move the detail into a guide under docs/agent-guides/").toBeLessThanOrEqual(ROOT_BUDGET_BYTES);
  });

  test("CLAUDE.md is a symlink to AGENTS.md", () => {
    const claude = join(root, "CLAUDE.md");
    expect(lstatSync(claude).isSymbolicLink()).toBe(true);
    expect(readlinkSync(claude)).toBe("AGENTS.md");
  });

  test("every local link in the root and the Inbox index exists", () => {
    const files = [agents, join(root, "docs/agent-guides/inbox.md")];
    const links = files.flatMap(localLinks);
    expect(links.length).toBeGreaterThan(0);
    const missing = links.filter((target) => !existsSync(target)).map((target) => target.slice(root.length + 1));
    expect(missing).toEqual([]);
  });
});
