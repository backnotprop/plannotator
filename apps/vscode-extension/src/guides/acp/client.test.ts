import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CLIENT_READ_BYTES, readTextFileForAgent } from "./client";

const dir = mkdtempSync(join(tmpdir(), "pn-client-read-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("fs/read_text_file for an agent that calls it", () => {
  it("reads a file, or the lines asked for", async () => {
    const p = join(dir, "a.ts");
    writeFileSync(p, "one\ntwo\nthree\n");
    expect(await readTextFileForAgent({ path: p })).toEqual({ content: "one\ntwo\nthree\n" });
    expect(await readTextFileForAgent({ path: p, line: 2, limit: 1 })).toEqual({ content: "two" });
  });

  it("refuses a relative path, a folder, and a file over 10 MB", async () => {
    await expect(readTextFileForAgent({ path: "a.ts" })).rejects.toThrow();
    await expect(readTextFileForAgent({ path: dir })).rejects.toThrow("is not a file");
    const big = join(dir, "big.log");
    writeFileSync(big, "");
    truncateSync(big, MAX_CLIENT_READ_BYTES + 1);
    await expect(readTextFileForAgent({ path: big })).rejects.toThrow("reads files up to");
  });
});
