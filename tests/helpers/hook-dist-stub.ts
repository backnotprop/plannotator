/**
 * Stub pages for apps/hook/dist, for tests that run the CLI from source.
 *
 * The CLI imports apps/hook/dist/{index,review,inbox}.html at module load; a
 * checkout that never ran `build:hook` (CI's test job) has none of them. A
 * test writes a stub for each one missing and removes exactly those stubs
 * afterwards: each stub carries a marker, so a real page a build wrote
 * meanwhile (`build:hook` in another terminal) is never deleted, and the dist
 * folder itself is never removed (a build may be writing into it).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const HOOK_DIST_DIR = resolve(import.meta.dirname, "..", "..", "apps", "hook", "dist");

/** What a stub page holds, marked so `removeStubbedHtml` can tell it from a real build. */
export const STUB_HTML = "<!doctype html><title>test</title><!-- plannotator test stub: tests/helpers/hook-dist-stub.ts -->";

const PAGES = ["index.html", "review.html", "inbox.html"] as const;

/** Write a marked stub for each built page that is missing. Returns what to pass to `removeStubbedHtml`. */
export function stubHookDistHtml(): string[] {
  mkdirSync(HOOK_DIST_DIR, { recursive: true });
  const made: string[] = [];
  for (const path of PAGES.map((name) => join(HOOK_DIST_DIR, name))) {
    if (existsSync(path)) continue;
    try {
      // `wx`: never over a page that appeared since the check.
      writeFileSync(path, STUB_HTML, { flag: "wx" });
      made.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return made;
}

/**
 * Remove the stubs `stubHookDistHtml` wrote, and only them: a page that no
 * longer holds the stub (a build replaced it) stays, and so does the folder.
 */
export function removeStubbedHtml(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      if (readFileSync(path, "utf8") === STUB_HTML) rmSync(path, { force: true });
    } catch {
      // Already gone.
    }
  }
}
