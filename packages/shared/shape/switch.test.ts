/**
 * The board style in config.json (`shapeBoardStyle`, switch.ts), the one place the Inbox writes it and the Inbox
 * and the Shapes server read it. What regresses: a person who never chose being shown Rounded (the default is
 * Sharp), a pick that does not come back on the next read, a value no build wrote read as itself, or a save that
 * loses the config.json keys beside it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setShapeBoardStyle, shapeBoardStyle } from "./switch";

const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
let dataDir = "";

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-shape-style-")));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const onDisk = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as Record<string, unknown>;

test("Sharp until the person picks; a pick is kept in config.json and read back, the other keys kept", () => {
  expect(shapeBoardStyle()).toBe("sharp");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxShape: true, inboxTextSize: 13 }));
  expect(shapeBoardStyle()).toBe("sharp");
  expect(setShapeBoardStyle("rounded")).toBe(true);
  expect(onDisk()).toEqual({ inboxShape: true, inboxTextSize: 13, shapeBoardStyle: "rounded" });
  expect(shapeBoardStyle()).toBe("rounded");
  expect(setShapeBoardStyle("sharp")).toBe(true);
  expect(onDisk().shapeBoardStyle).toBe("sharp");
  expect(shapeBoardStyle()).toBe("sharp");
});

test("a value no build writes reads as Sharp", () => {
  for (const junk of ["square", "Rounded", 1, true, null, { style: "rounded" }]) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ shapeBoardStyle: junk }));
    expect(shapeBoardStyle()).toBe("sharp");
  }
});

test("a config.json that is not JSON is never written over: the save says so and nothing changes", () => {
  writeFileSync(join(dataDir, "config.json"), "{ not json");
  expect(setShapeBoardStyle("rounded")).toBe(false);
  expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe("{ not json");
});
