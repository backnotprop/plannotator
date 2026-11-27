/**
 * Playwright loads its specs and what they import under Node, not Bun. tests/e2e/inbox-worst-case.spec.ts seeds its
 * world through scripts/inbox-worst-case.ts, which imports packages/server/inbox-guides.ts and so the send path
 * (inbox-mcp.ts, its `links_not_found` check). A static import from there that reaches a module importing "bun" fails
 * the whole browser shard before any test runs ("Cannot find module 'bun'"): the send's link check once reached the
 * open-in routes that way. This walks the static, non-type imports from those entries and names any path to "bun".
 *
 * A source scan (relative and `@plannotator/*` workspace imports; dynamic imports are not followed, as they load late).
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const ENTRIES = ["tests/e2e/inbox-worst-case.spec.ts", "scripts/inbox-worst-case.ts"];
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/g;

const exportMaps = new Map<string, Record<string, unknown>>();
function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else if (spec.startsWith("@plannotator/")) {
    const [, pkg, ...rest] = spec.split("/");
    const dir = join(root, "packages", pkg!);
    if (!existsSync(join(dir, "package.json"))) return null;
    if (!exportMaps.has(pkg!)) exportMaps.set(pkg!, (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).exports ?? {}) as Record<string, unknown>);
    const target = exportMaps.get(pkg!)![rest.length ? `./${rest.join("/")}` : "."];
    base = typeof target === "string" ? join(dir, target) : join(dir, rest.join("/"));
  } else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Each chain from an entry to a module that imports "bun" (or `bun:*`). */
function pathsToBun(entries: string[]): string[] {
  const parent = new Map<string, string | null>();
  const reachesBun: string[] = [];
  const stack: [string, string | null][] = entries.map((entry) => [join(root, entry), null]);
  while (stack.length) {
    const [file, from] = stack.pop()!;
    if (parent.has(file)) continue;
    parent.set(file, from);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
      if (match[1]) continue;
      const spec = match[2]!;
      if (spec === "bun" || spec.startsWith("bun:")) {
        reachesBun.push(file);
        continue;
      }
      const next = resolveImport(file, spec);
      if (next && !parent.has(next)) stack.push([next, file]);
    }
  }
  return [...new Set(reachesBun)].map((file) => {
    const chain: string[] = [];
    for (let at: string | null | undefined = file; at; at = parent.get(at)) chain.unshift(relative(root, at));
    return chain.join(" -> ");
  });
}

test("the worst-case world a browser spec seeds under Node reaches no module that imports bun", () => {
  expect(pathsToBun(ENTRIES)).toEqual([]);
});

test("the scan sees a bun import: the Inbox server itself reaches one", () => {
  expect(pathsToBun(["packages/server/inbox.ts"]).length).toBeGreaterThan(0);
});
