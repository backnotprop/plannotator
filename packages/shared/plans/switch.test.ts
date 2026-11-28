/**
 * Plans' switch over config.json `inboxPlans`, on a scratch data dir. What regresses if these fail:
 * - Plans is on without the person turning it on (unset, a string, a broken config.json);
 * - turning it on or off does not stick, touches the person's other settings, or reports a save that did not happen;
 * - the Spaces home's view (config.json `inboxSpacesView`) is not the person's across windows: it is not cards
 *   unless they chose the list, a choice does not stick, or it touches their other settings.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plansOn, setPlansSwitch, setSpacesView, spacesView } from "./switch";

let dataDir = "";
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.PLANNOTATOR_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "plans-switch-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = saved;
  rmSync(dataDir, { recursive: true, force: true });
});

const config = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));

describe("Plans' switch", () => {
  test("off by default: no config.json, unset, or anything but true", () => {
    expect(plansOn()).toBe(false);
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxShape: true }));
    expect(plansOn()).toBe(false);
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxPlans: "true" }));
    expect(plansOn()).toBe(false);
    writeFileSync(join(dataDir, "config.json"), "{ not json");
    expect(plansOn()).toBe(false);
  });

  test("on and off stick, and keep the person's other settings", () => {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxShape: true, theme: "dark" }));
    expect(setPlansSwitch(true)).toBe(true);
    expect(plansOn()).toBe(true);
    expect(config()).toEqual({ inboxShape: true, theme: "dark", inboxPlans: true });
    expect(setPlansSwitch(false)).toBe(true);
    expect(plansOn()).toBe(false);
    expect(config().inboxPlans).toBe(false);
  });

  test("a config.json that is not JSON is never written over: the save says so", () => {
    writeFileSync(join(dataDir, "config.json"), "{ not json");
    const write = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(setPlansSwitch(true)).toBe(false);
    } finally {
      process.stderr.write = write;
    }
    expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe("{ not json");
    expect(plansOn()).toBe(false);
  });

  test("the Spaces view is cards unless the person chose the list; a choice sticks beside their other settings", () => {
    expect(spacesView()).toBe("cards");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxPlans: true, inboxSpacesView: "grid" }));
    expect(spacesView()).toBe("cards");
    expect(setSpacesView("list")).toBe(true);
    expect(spacesView()).toBe("list");
    expect(config()).toEqual({ inboxPlans: true, inboxSpacesView: "list" });
    expect(setSpacesView("cards")).toBe(true);
    expect(spacesView()).toBe("cards");
    expect(plansOn()).toBe(true);
  });
});
