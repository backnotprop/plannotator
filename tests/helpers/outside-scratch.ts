/**
 * A real folder that is not a scratch one, for a test that proves a sandbox
 * stays out of folders like the person's home, without touching theirs. It is
 * made inside this checkout, so the caller removes it. `checkoutIsScratch` is
 * true for a checkout under the temp dir, where no such folder can be made here:
 * those tests skip.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isScratchDataDir } from "./real-data-dir";

export const checkoutIsScratch = isScratchDataDir(import.meta.dir);

export function makeOutsideScratch(): string {
  return realpathSync(mkdtempSync(join(import.meta.dir, ".outside-scratch-")));
}
