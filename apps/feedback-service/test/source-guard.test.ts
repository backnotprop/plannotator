/**
 * The owner's rule for this Worker: the public endpoint can only submit,
 * never read, and never change or remove what is already stored. This test
 * reads every code file in the package, wherever it sits (all of
 * apps/feedback-service but test/, node_modules/ and wrangler's .wrangler/),
 * so a new folder cannot hide a read route, and fails on any SQL verb but
 * INSERT, any D1 read method, any second statement, and any route but
 * POST /feedback. It also walks the imports from wrangler's `main` (what
 * wrangler bundles): every one stays in this package's code, which the
 * scan covers. The only .sql file is schema.sql, the migration.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = join(import.meta.dir, "..");
const SKIP = new Set(["test", "node_modules", ".wrangler"]);
const CODE = /\.(?:[cm]?[jt]sx?)$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name) && dir === root) return [];
    if (name === "node_modules") return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : CODE.test(name) || name.endsWith(".sql") ? [full] : [];
  });
}

const all = walk(root).map((file) => ({ file: relative(root, file), text: readFileSync(file, "utf-8") }));
const sources = all.filter((s) => CODE.test(s.file));
const sqlFiles = all.filter((s) => s.file.endsWith(".sql"));

describe("the Worker only ever inserts", () => {
  test("the guard sees the Worker's files (it cannot pass on an empty set)", () => {
    const names = sources.map((s) => s.file).sort();
    expect(names).toContain("core/handler.ts");
    expect(names).toContain("stores/d1.ts");
    expect(names).toContain("targets/cloudflare.ts");
  });

  test("wrangler.toml has only the known tables: nothing else (alias, build, rules, env.*) can change what it bundles or runs", () => {
    const config = Bun.TOML.parse(readFileSync(join(root, "wrangler.toml"), "utf-8")) as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual(["compatibility_date", "d1_databases", "main", "name", "ratelimits", "vars"]);
  });

  test("everything wrangler bundles from `main` is this package's own code, which the scan covers", () => {
    const main = /^main\s*=\s*"([^"]+)"/m.exec(readFileSync(join(root, "wrangler.toml"), "utf-8"))![1]!;
    const scanned = new Set(sources.map((s) => s.file));
    const seen = new Set<string>();
    const queue = [main];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      expect(scanned.has(file), `${file} is bundled but not scanned`).toBe(true);
      const text = readFileSync(join(root, file), "utf-8");
      for (const m of text.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/gm)) {
        const typeOnly = Boolean(m[2]);
        const spec = (m[3] ?? m[4] ?? m[5] ?? m[6])!;
        if (!spec.startsWith(".")) {
          // A package would bundle code this guard never reads; types only are erased.
          expect(typeOnly, `${file} imports the package "${spec}"`).toBe(true);
          continue;
        }
        const base = resolve(dirname(join(root, file)), spec);
        const target = [base, `${base}.ts`, `${base}.js`, join(base, "index.ts")].find((p) => existsSync(p) && statSync(p).isFile());
        expect(target, `${file} imports ${spec}, which does not resolve`).toBeDefined();
        const rel = relative(root, target!);
        expect(rel.startsWith(".."), `${file} imports ${spec}, outside the package`).toBe(false);
        if (!typeOnly) queue.push(rel);
      }
    }
    expect([...seen].sort()).toContain("stores/d1.ts");
  });

  test("the only SQL file is the migration, and it keeps the append-only triggers", () => {
    expect(sqlFiles.map((s) => s.file)).toEqual(["schema.sql"]);
    const schema = sqlFiles[0]!.text.replace(/--[^\n]*/g, "");
    expect(schema).toMatch(/BEFORE UPDATE ON feedback\s+BEGIN\s+SELECT RAISE\(ABORT/);
    expect(schema).toMatch(/BEFORE DELETE ON feedback\s+BEGIN\s+SELECT RAISE\(ABORT/);
    expect(/\b(drop|alter|insert|update\s+feedback|delete\s+from)\b/i.exec(schema)?.[0] ?? null).toBeNull();
  });

  test("no SQL verb but INSERT appears anywhere in the source, comments included", () => {
    // A JavaScript method call (`map.delete(key)`, `text.replace(re, "")`) is not SQL: a word right after a
    // `.` is skipped. Everything else counts, comments and strings included.
    const banned = /(?<!\.)\b(select|update|delete|replace|drop|alter|upsert|truncate|pragma|attach|vacuum|returning|create)\b|\bon\s+conflict\b|\bor\s+ignore\b/i;
    for (const { file, text } of sources) {
      expect(banned.exec(text)?.[0] ?? null, `${file} contains a banned SQL word`).toBeNull();
    }
  });

  test("no D1 read or multi-statement method is called", () => {
    const readMethods = /\.(first|all|raw|exec|batch|dump|withSession)\s*\(/;
    for (const { file, text } of sources) {
      expect(readMethods.exec(text)?.[0] ?? null, `${file} calls a D1 read method`).toBeNull();
    }
  });

  test("exactly one prepared statement, a parameterised INSERT into feedback", () => {
    const prepared = sources.flatMap(({ file, text }) => [...text.matchAll(/\.prepare\(\s*`([^`]*)`/g)].map((m) => ({ file, sql: m[1]!.replace(/\s+/g, " ").trim() })));
    expect(prepared).toHaveLength(1);
    expect(prepared[0]!.file).toBe("stores/d1.ts");
    expect(prepared[0]!.sql).toMatch(/^INSERT INTO feedback \([a-z_, ]+\) VALUES \((\?, )*\?\)$/);
    // No `${...}` interpolation into SQL: values go through bind().
    expect(prepared[0]!.sql).not.toContain("${");
    // Every `.prepare(` call is the template one above (no string-built SQL).
    const calls = sources.reduce((n, { text }) => n + (text.match(/\.prepare\(/g)?.length ?? 0), 0);
    expect(calls).toBe(1);
  });

  test("the store interface exposes one method, insert", () => {
    const storage = sources.find((s) => s.file === "core/storage.ts")!.text;
    const iface = /export interface FeedbackStore \{([\s\S]*?)\n\}/.exec(storage)![1]!;
    const methods = [...iface.matchAll(/^\s*([a-zA-Z_]\w*)\s*\(/gm)].map((m) => m[1]);
    expect(methods).toEqual(["insert"]);
  });

  test("one path in all the code: /feedback", () => {
    const paths = [...new Set(sources.flatMap(({ text }) => [...text.matchAll(/["'`](\/[a-z][a-z0-9/_-]*)["'`]/g)].map((m) => m[1])))];
    expect(paths).toEqual(["/feedback"]);
  });

  test("nothing sets a cookie", () => {
    for (const { file, text } of sources) expect(/set-cookie/i.test(text), file).toBe(false);
  });
});
