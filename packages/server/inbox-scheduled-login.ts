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
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const INBOX_LOGIN_LABEL = "ai.plannotator.inbox";
export const INBOX_LOGIN_UNIT = "plannotator-inbox.service";

export type LoginRunner = (argv: string[]) => Promise<{ code: number }>;

/** The real runner: `launchctl` or `systemctl`, its exit code only, bounded so a hung one never holds Settings. */
export const execLoginCommand: LoginRunner = ([file, ...args]) =>
  new Promise((resolve) => execFile(file!, args, { timeout: 10_000, windowsHide: true }, (error) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0 })));

export type InboxLoginItem = {
  /** Where it would be written, or null where there is none (Windows). */
  path: string | null;
  add(): Promise<"added" | "unavailable">;
  remove(): Promise<void>;
};

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Reverse `xml` for a value read back out of an existing plist, so entities are not escaped twice on rewrite. */
const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** String-valued entries of a prior plist's `EnvironmentVariables`; a missing, corrupt or env-less file gives none. */
function existingEnvOf(plistText: string): Record<string, string> {
  const dict = plistText.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (!dict) return {};
  const env: Record<string, string> = {};
  const pair = /<key>([^<]*)<\/key>\s*<string>([\s\S]*?)<\/string>/g;
  let match: RegExpExecArray | null;
  while ((match = pair.exec(dict[1]!))) env[unescapeXml(match[1]!)] = unescapeXml(match[2]!);
  // Anything else in the dictionary (an integer, an array) is not an environment entry we can carry: start fresh.
  return dict[1]!.replace(pair, "").trim() === "" ? env : {};
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
        let existing: Record<string, string> = {};
        if (existsSync(path)) {
          try {
            existing = existingEnvOf(readFileSync(path, "utf8"));
          } catch {
            existing = {};
          }
        }
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
