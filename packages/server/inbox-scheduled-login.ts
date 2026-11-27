/**
 * Start at login while routines are on (the owner, 2026-11-15): one login item that starts the Inbox in
 * the background with no window, removed when the switch goes off and by `plannotator uninstall`.
 *
 * macOS: `~/Library/LaunchAgents/ai.plannotator.inbox.plist`, loaded by launchd at the next login (writing it starts
 * nothing now). Linux: a systemd user unit, `~/.config/systemd/user/plannotator-inbox.service`, enabled for
 * `default.target`, only when `systemctl --user` answers; otherwise there is no login item and the Settings row says
 * so. Windows: none (routines are not offered there). Tests pass their own `home` and `run`.
 */
import { execFile } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const INBOX_LOGIN_LABEL = "ai.plannotator.inbox";
export const INBOX_LOGIN_UNIT = "plannotator-inbox.service";

export type LoginRunner = (argv: string[]) => Promise<{ code: number; stdout?: string }>;

/** The real runner: `systemctl` or `plutil`, its exit code and output, bounded so a hung one never holds Settings. */
export const execLoginCommand: LoginRunner = ([file, ...args]) =>
  new Promise((resolve) => execFile(file!, args, { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? "") })));

export type InboxLoginItem = {
  /** Where it would be written, or null where there is none (Windows). */
  path: string | null;
  add(): Promise<"added" | "unavailable">;
  remove(): Promise<void>;
};

// `\r` as a reference: an XML reader turns a literal one into `\n`.
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\r/g, "&#13;");
/** A character XML 1.0 cannot carry at all (a binary plist can): such an entry would make the whole file unloadable. */
const isXmlText = (s: string) => {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 ? c !== 0x9 && c !== 0xa && c !== 0xd : (c >= 0xd800 && c <= 0xdfff) || c === 0xfffe || c === 0xffff) return false;
  }
  return true;
};

/**
 * String-valued entries of the existing plist's `EnvironmentVariables`, read by `plutil` so any plist launchd reads
 * reads the same here (binary, as `defaults write` leaves it; XML with comments, CDATA or character references).
 * Other values are skipped. A missing file, no such key, or plutil missing, failing, timing out or printing anything
 * but a JSON object gives none: the file is then written as on a fresh install. The values can be secrets: never logged.
 */
async function existingEnvOf(path: string, run: LoginRunner): Promise<Record<string, string>> {
  if (!existsSync(path)) return {};
  try {
    const { code, stdout } = await run(["/usr/bin/plutil", "-extract", "EnvironmentVariables", "json", "-o", "-", path]);
    if (code !== 0 || !stdout) return {};
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && isXmlText(key) && isXmlText(value)) env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}
/** One argument of a systemd ExecStart line: quoted, with `%` doubled (systemd's specifiers). */
const unitArg = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/** The plist launchd reads at login: the Inbox, no window, its output in the Inbox's own log. Person-added env entries are carried over; the generated data dir stays authoritative. */
export function inboxLoginPlist(o: { argv: readonly string[]; dataDir: string; log: string }, env: Record<string, string> = {}): string {
  const string = (s: string) => `<string>${xml(s)}</string>`;
  const merged: Record<string, string> = { ...env, PLANNOTATOR_DATA_DIR: o.dataDir };
  const envEntries = Object.keys(merged).sort().map((k) => `    <key>${xml(k)}</key>${string(merged[k]!)}`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>${string(INBOX_LOGIN_LABEL)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...[...o.argv, "inbox", "--no-open"].map((a) => `    ${string(a)}`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...envEntries,
    "  </dict>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>ProcessType</key><string>Background</string>",
    `  <key>StandardOutPath</key>${string(o.log)}`,
    `  <key>StandardErrorPath</key>${string(o.log)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function inboxLoginUnit(o: { argv: readonly string[]; dataDir: string }): string {
  return [
    "[Unit]",
    "Description=Plannotator Inbox",
    "",
    "[Service]",
    `ExecStart=${[...o.argv, "inbox", "--no-open"].map(unitArg).join(" ")}`,
    `Environment=${unitArg(`PLANNOTATOR_DATA_DIR=${o.dataDir}`)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

const writeAtomic = (path: string, text: string) => {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o644 });
  renameSync(temp, path);
};

export function inboxLoginItem(o: { platform: NodeJS.Platform; home: string; argv: readonly string[]; dataDir: string; run: LoginRunner }): InboxLoginItem {
  if (o.platform === "darwin") {
    const dir = join(o.home, "Library", "LaunchAgents");
    const path = join(dir, `${INBOX_LOGIN_LABEL}.plist`);
    return {
      path,
      async add() {
        mkdirSync(dir, { recursive: true });
        const existing = await existingEnvOf(path, o.run);
        writeAtomic(path, inboxLoginPlist({ argv: o.argv, dataDir: o.dataDir, log: join(o.dataDir, "inbox", "inbox.log") }, existing));
        return "added";
      },
      // Only the file: launchd reads it at login, and an unload would end this Inbox if the login started it.
      async remove() {
        rmSync(path, { force: true });
      },
    };
  }
  if (o.platform === "linux") {
    const dir = join(o.home, ".config", "systemd", "user");
    const path = join(dir, INBOX_LOGIN_UNIT);
    return {
      path,
      async add() {
        const works = await o.run(["systemctl", "--user", "show-environment"]).catch(() => ({ code: 1 }));
        if (works.code !== 0) return "unavailable";
        mkdirSync(dir, { recursive: true });
        writeAtomic(path, inboxLoginUnit({ argv: o.argv, dataDir: o.dataDir }));
        const enabled = await o.run(["systemctl", "--user", "enable", INBOX_LOGIN_UNIT]).catch(() => ({ code: 1 }));
        if (enabled.code === 0) return "added";
        rmSync(path, { force: true });
        return "unavailable";
      },
      // Disabled, not stopped: this Inbox may be the unit the login started.
      async remove() {
        if (!existsSync(path)) return;
        await o.run(["systemctl", "--user", "disable", INBOX_LOGIN_UNIT]).catch(() => undefined);
        rmSync(path, { force: true });
      },
    };
  }
  return { path: null, add: async () => "unavailable", remove: async () => {} };
}
