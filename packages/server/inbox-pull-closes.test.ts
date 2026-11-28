/**
 * The board's close and reopen lines, kept (inbox-pull-closes.ts). What regresses: a line not appended (the second
 * overwriting the first), a line without its time, a file others can read, or a write that fails throwing into the
 * close's answer.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepPullClose, PULL_CLOSES_FILE } from "./inbox-pull-closes";

const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-pull-closes-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("each close and reopen is one more line, with its time, readable by the owner alone", () => {
  const dir = join(root, "inbox");
  keepPullClose(dir, { act: "close", key: "github.com/northwind/web-app#2039", ok: true }, 1_000);
  keepPullClose(dir, { act: "reopen", key: "github.com/northwind/web-app#2039", ok: true }, 2_000);
  const file = join(dir, PULL_CLOSES_FILE);
  const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(lines).toEqual([
    { t: 1_000, act: "close", key: "github.com/northwind/web-app#2039", ok: true },
    { t: 2_000, act: "reopen", key: "github.com/northwind/web-app#2039", ok: true },
  ]);
  if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
});

test("a line that cannot be written does not throw", () => {
  const notADir = join(root, "a-file");
  writeFileSync(notADir, "");
  expect(() => keepPullClose(notADir, { act: "close", key: "github.com/northwind/web-app#1", ok: true })).not.toThrow();
});
