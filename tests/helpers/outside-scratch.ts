import { mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isScratchDataDir } from "./real-data-dir";

export const checkoutIsScratch = isScratchDataDir(import.meta.dir);

export function makeOutsideScratch(): string {
  return realpathSync(mkdtempSync(join(import.meta.dir, ".outside-scratch-")));
}
