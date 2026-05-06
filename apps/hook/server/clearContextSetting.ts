import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { randomBytes } from "crypto";
import { homedir } from "os";
import { dirname, join } from "path";

const SETTING_KEY = "showClearContextOnPlanAccept";

function consentPath(): string {
  return join(
    homedir(),
    ".plannotator",
    "consent",
    "clear-context-setting.json",
  );
}

function settingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function hasConsent(): boolean {
  try {
    if (!existsSync(consentPath())) return false;
    const data = JSON.parse(readFileSync(consentPath(), "utf8"));
    return data?.consented === true;
  } catch {
    return false;
  }
}

function writeJsonAtomic(path: string, data: Record<string, unknown>): void {
  const tmp = join(
    dirname(path),
    `plannotator-settings-${randomBytes(4).toString("hex")}.json`,
  );
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function recordConsent(): void {
  const dir = join(homedir(), ".plannotator", "consent");
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(consentPath(), {
    consented: true,
    recordedAt: new Date().toISOString(),
  });
}

export function isClearContextSettingEnabled(): boolean {
  try {
    if (!existsSync(settingsPath())) return false;
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
    return settings?.[SETTING_KEY] === true;
  } catch {
    return false;
  }
}

export async function ensureClearContextSettingEnabled(): Promise<boolean> {
  if (!hasConsent()) {
    console.error(
      "[plannotator] clearContextSetting: no consent recorded; skipping settings mutation",
    );
    return isClearContextSettingEnabled();
  }

  let settings: Record<string, unknown>;
  try {
    settings = existsSync(settingsPath())
      ? JSON.parse(readFileSync(settingsPath(), "utf8"))
      : {};
  } catch (error: any) {
    console.error(
      `[plannotator] clearContextSetting: malformed settings JSON; skipping mutation: ${error?.message}`,
    );
    return false;
  }

  if (settings[SETTING_KEY] === true) return true;

  settings[SETTING_KEY] = true;
  mkdirSync(join(homedir(), ".claude"), { recursive: true });

  try {
    writeJsonAtomic(settingsPath(), settings);
  } catch (error: any) {
    try {
      await Bun.sleep(50);
      writeJsonAtomic(settingsPath(), settings);
    } catch (retryError: any) {
      console.error(
        `[plannotator] clearContextSetting: write failed after retry; skipping: ${retryError?.message}`,
      );
      return false;
    }
  }

  return true;
}
