import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastRunLog, stagingFailureIn } from "./update-log";

test("the update log tail has a byte budget even when most of the log is multibyte text", () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-update-log-"));
  try {
    const log = join(dir, "update.log");
    writeFileSync(log, [
      "update: could not prepare the update: an old error; nothing was changed",
      "界".repeat(25000),
      "latest diagnostic",
      "[2026-11-15] update: install.sh exited 75",
      "",
    ].join("\n"));

    const tail = lastRunLog(log);
    expect(tail).toContain("latest diagnostic");
    expect(stagingFailureIn(tail)).toBeNull();
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(65_536);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
