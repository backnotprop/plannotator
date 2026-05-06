import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "plannotator-clear-context-test-"));
  mock.module("os", () => {
    const realOs = require("node:os");
    return { ...realOs, homedir: () => tmpHome };
  });
});

afterEach(() => {
  mock.restore();
  rmSync(tmpHome, { recursive: true, force: true });
});

async function freshImport() {
  return (await import(
    `./clearContextSetting?t=${Date.now()}-${Math.random()}`
  )) as typeof import("./clearContextSetting");
}

function writeConsent() {
  mkdirSync(join(tmpHome, ".plannotator", "consent"), { recursive: true });
  writeFileSync(
    join(tmpHome, ".plannotator", "consent", "clear-context-setting.json"),
    JSON.stringify({ consented: true }),
    "utf8",
  );
}

describe("clearContextSetting", () => {
  test("does not create settings without consent", async () => {
    const { ensureClearContextSettingEnabled } = await freshImport();
    await ensureClearContextSettingEnabled();
    expect(existsSync(join(tmpHome, ".claude", "settings.json"))).toBe(false);
  });

  test("creates settings with showClearContextOnPlanAccept when consent exists", async () => {
    writeConsent();
    const { ensureClearContextSettingEnabled } = await freshImport();
    await ensureClearContextSettingEnabled();

    const settings = JSON.parse(
      readFileSync(join(tmpHome, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.showClearContextOnPlanAccept).toBe(true);
  });

  test("preserves existing settings keys", async () => {
    writeConsent();
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".claude", "settings.json"),
      JSON.stringify({ theme: "dark", env: { A: "B" } }),
      "utf8",
    );

    const { ensureClearContextSettingEnabled } = await freshImport();
    await ensureClearContextSettingEnabled();

    const settings = JSON.parse(
      readFileSync(join(tmpHome, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.theme).toBe("dark");
    expect(settings.env).toEqual({ A: "B" });
    expect(settings.showClearContextOnPlanAccept).toBe(true);
  });

  test("is idempotent when setting is already enabled", async () => {
    writeConsent();
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".claude", "settings.json"),
      JSON.stringify({ showClearContextOnPlanAccept: true }),
      "utf8",
    );

    const { ensureClearContextSettingEnabled } = await freshImport();
    await ensureClearContextSettingEnabled();
    await ensureClearContextSettingEnabled();

    const settings = JSON.parse(
      readFileSync(join(tmpHome, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.showClearContextOnPlanAccept).toBe(true);
  });

  test("leaves malformed settings JSON untouched", async () => {
    writeConsent();
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    const malformed = "{ this is not valid json";
    writeFileSync(join(tmpHome, ".claude", "settings.json"), malformed, "utf8");

    const { ensureClearContextSettingEnabled } = await freshImport();
    await ensureClearContextSettingEnabled();

    expect(readFileSync(join(tmpHome, ".claude", "settings.json"), "utf8")).toBe(
      malformed,
    );
  });

  test("records consent atomically", async () => {
    const { recordConsent } = await freshImport();
    recordConsent();

    const consentPath = join(
      tmpHome,
      ".plannotator",
      "consent",
      "clear-context-setting.json",
    );
    expect(existsSync(consentPath)).toBe(true);
    const consent = JSON.parse(readFileSync(consentPath, "utf8"));
    expect(consent.consented).toBe(true);
    expect(typeof consent.recordedAt).toBe("string");
  });

  test("reports disabled when settings are missing", async () => {
    const { isClearContextSettingEnabled } = await freshImport();
    expect(isClearContextSettingEnabled()).toBe(false);
  });

  test("reports enabled when setting is true", async () => {
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".claude", "settings.json"),
      JSON.stringify({ showClearContextOnPlanAccept: true }),
      "utf8",
    );

    const { isClearContextSettingEnabled } = await freshImport();
    expect(isClearContextSettingEnabled()).toBe(true);
  });
});
