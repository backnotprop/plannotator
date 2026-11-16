import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentFile, withBom, writeAgentFileAtomic } from "./agent-files";

test("editing agent notes preserves U+FEFF after the file's UTF-8 BOM", () => {
  const folder = mkdtempSync(join(tmpdir(), "plannotator-agent-encoding-"));
  try {
    const path = join(folder, "AGENTS.md");
    const original = Buffer.from("\uFEFF\uFEFFExisting notes\n");
    writeFileSync(path, original);

    const read = readAgentFile(path);
    if (read.kind !== "file") throw new Error("Expected readable UTF-8 agent notes");
    writeAgentFileAtomic(read.target, withBom(read.text + "Extra note\n", read.bom), read.mode);

    expect(readFileSync(path)).toEqual(Buffer.concat([original, Buffer.from("Extra note\n")]));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
