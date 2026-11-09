/**
 * The folder rules' own source (`inbox-home-folders.ts`), for the child process that reads folders outside home
 * (`inbox-folder-reader.ts`). Imported as a Bun macro, so it runs when the Inbox is built (and when Bun loads it from
 * source): the compiled binary carries the text, with no file to read at run time.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function homeFoldersSource(): string {
  return readFileSync(join(import.meta.dir, "inbox-home-folders.ts"), "utf8");
}
