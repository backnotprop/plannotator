import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { findExecutable } from "./which";

test.skipIf(process.platform === "win32")("finds a launchable adapter after a non-executable PATH entry", () => {
  const root = mkdtempSync(join(tmpdir(), "plannotator-acp-which-"));
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    const name = "fixture-acp-adapter";
    const blocked = join(first, name);
    const launchable = join(second, name);
    writeFileSync(blocked, "#!/bin/sh\nexit 0\n");
    chmodSync(blocked, 0o644);
    writeFileSync(launchable, "#!/bin/sh\nexit 0\n");
    chmodSync(launchable, 0o755);

    expect(findExecutable(name, { PATH: [first, second].join(delimiter) })).toBe(launchable);
    expect(findExecutable(blocked)).toBeNull();
    expect(findExecutable(launchable)).toBe(launchable);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
