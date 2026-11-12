import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

function readPreload(bunfigPath: string): string[] {
  const parsed = Bun.TOML.parse(readFileSync(bunfigPath, "utf-8")) as {
    test?: { preload?: string[] };
  };
  return parsed.test?.preload ?? [];
}

function hasTestFiles(dir: string): boolean {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (hasTestFiles(full)) return true;
    } else if (/\.test\.tsx?$/.test(entry)) {
      return true;
    }
  }
  return false;
}

const rootPreload = readPreload(join(repoRoot, "bunfig.toml")).map((p) => resolve(repoRoot, p));

const extraDirs = ["apps/hook/server", "tests", "scripts"].map((dir) => join(repoRoot, dir));

const packageDirs = [
  ...["apps", "packages"].flatMap((group) =>
    readdirSync(join(repoRoot, group))
      .map((name) => join(repoRoot, group, name))
      .filter((dir) => statSync(dir).isDirectory() && hasTestFiles(dir)),
  ),
  ...extraDirs,
];

describe("package-directory bunfig.toml", () => {
  test("root preload sandboxes the data dir", () => {
    expect(rootPreload).toContain(resolve(repoRoot, "tests/setup/feedback-archive-off.ts"));
  });

  test("root preload puts the tripwire gh on PATH first, before anything can spawn", () => {
    expect(rootPreload[0]).toBe(resolve(repoRoot, "tests/setup/gh-tripwire.ts"));
  });

  for (const dir of packageDirs) {
    const label = relative(repoRoot, dir);
    test(`${label} mirrors the root test preloads`, () => {
      const bunfig = join(dir, "bunfig.toml");
      expect(existsSync(bunfig)).toBe(true);
      expect(readPreload(bunfig).map((p) => resolve(dir, p))).toEqual(rootPreload);
    });
  }
});

const ASSET_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])[^'"\n]+?(\.(?:webp|png|jpe?g|gif|svg|avif|ico|bmp|mp3|wav|ogg|mp4|webm|woff2?|ttf|otf))(?:\?[^'"\n]*)?\1/gi;

function readLoader(bunfigPath: string): Record<string, string> {
  const parsed = Bun.TOML.parse(readFileSync(bunfigPath, "utf-8")) as { loader?: Record<string, string> };
  return parsed.loader ?? {};
}

function importedAssetTypes(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "packages/**/*.ts", "packages/**/*.tsx", "apps/**/*.ts", "apps/**/*.tsx"], { cwd: repoRoot }).stdout.toString();
  const types = new Set<string>();
  for (const file of out.split("\n").filter(Boolean)) {
    if (file.includes("node_modules/")) continue;
    for (const match of readFileSync(join(repoRoot, file), "utf-8").matchAll(ASSET_IMPORT_RE)) types.add(match[2]!.toLowerCase());
  }
  return [...types].sort();
}

describe("bunfig.toml [loader]: asset imports load as files", () => {
  const rootLoader = readLoader(join(repoRoot, "bunfig.toml"));

  test("every asset type the source imports has a file loader at the root", () => {
    const types = importedAssetTypes();
    expect(types).toContain(".webp");
    expect(types.filter((type) => rootLoader[type] !== "file")).toEqual([]);
  });

  const bunfigs = Bun.spawnSync(["git", "ls-files", "*bunfig.toml"], { cwd: repoRoot })
    .stdout.toString()
    .split("\n")
    .filter((file) => file && file !== "bunfig.toml");
  for (const file of bunfigs) {
    test(`${file} mirrors the root [loader]`, () => {
      expect(readLoader(join(repoRoot, file))).toEqual(rootLoader);
    });
  }
});
