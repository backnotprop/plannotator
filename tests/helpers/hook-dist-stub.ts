import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export const HOOK_DIST_DIR = resolve(import.meta.dirname, "..", "..", "apps", "hook", "dist");

export const STUB_HTML = "<!doctype html><title>test</title><!-- plannotator test stub: tests/helpers/hook-dist-stub.ts -->";

const PAGES = ["index.html", "review.html", "inbox.html", "shape.html.gz"] as const;

const stubBytes = (path: string): string | Buffer => (path.endsWith(".gz") ? gzipSync(STUB_HTML) : STUB_HTML);
const isStub = (path: string): boolean => {
  const bytes = readFileSync(path);
  return (path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8") === STUB_HTML;
};

export function stubHookDistHtml(): string[] {
  mkdirSync(HOOK_DIST_DIR, { recursive: true });
  const made: string[] = [];
  for (const path of PAGES.map((name) => join(HOOK_DIST_DIR, name))) {
    if (existsSync(path)) continue;
    try {
      writeFileSync(path, stubBytes(path), { flag: "wx" });
      made.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return made;
}

export function removeStubbedHtml(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      if (isStub(path)) rmSync(path, { force: true });
    } catch {
    }
  }
}
