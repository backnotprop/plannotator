import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FsPasteStore } from "./fs";

const dirs: string[] = [];
const stores: FsPasteStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a running store deletes expired pastes nobody reads again, not only at its next start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paste-fs-"));
  dirs.push(dir);
  const store = new FsPasteStore(dir, 50);
  stores.push(store);

  await store.put("short1", "a", 1);
  await store.put("short2", "b", 1);
  await store.put("long", "c", 3600);

  // Past the 1 s TTL plus a few sweep intervals; nothing reads the expired ids.
  await Bun.sleep(1300);

  expect(existsSync(join(dir, "short1.json"))).toBe(false);
  expect(existsSync(join(dir, "short2.json"))).toBe(false);
  expect(await store.get("long")).toBe("c");
});
