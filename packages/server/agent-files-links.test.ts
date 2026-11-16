import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentFile, writeAgentFileAtomic } from "./agent-files";

test.skipIf(process.platform === "win32")("creates the missing target of a chain without replacing its links", () => {
  const folder = mkdtempSync(join(tmpdir(), "plannotator-agent-links-"));
  try {
    const path = join(folder, "AGENTS.md");
    const intermediate = join(folder, "shared.md");
    const target = join(folder, "notes.md");
    symlinkSync("shared.md", path);
    symlinkSync("notes.md", intermediate);

    const read = readAgentFile(path);
    expect(read.kind).toBe("missing");
    writeAgentFileAtomic(read.target, "New notes\n", 0o644);

    expect(readlinkSync(path)).toBe("shared.md");
    expect(readlinkSync(intermediate)).toBe("notes.md");
    expect(readFileSync(target, "utf8")).toBe("New notes\n");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("refuses cyclic links without reporting a writable target", () => {
  const folder = mkdtempSync(join(tmpdir(), "plannotator-agent-cycle-"));
  try {
    const path = join(folder, "AGENTS.md");
    symlinkSync("shared.md", path);
    symlinkSync("AGENTS.md", join(folder, "shared.md"));

    expect(readAgentFile(path).kind).toBe("refused");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
