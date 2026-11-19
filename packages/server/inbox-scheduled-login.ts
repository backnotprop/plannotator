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

/**
 * Set on the login item's start: our launcher naming itself, so it starts the Inbox only while it is on and never
 * turns it on (apps/hook/server/inbox-on-command.ts, isOurLoginItem; launchd's job label names a login item written
 * before this).
 */
export const INBOX_LOGIN_ITEM_ENV = "PLANNOTATOR_INBOX_LOGIN_ITEM";

export type LoginRunner = (argv: string[]) => Promise<{ code: number }>;

/** The real runner: `launchctl` or `systemctl`, its exit code only, bounded so a hung one never holds Settings. */
export const execLoginCommand: LoginRunner = ([file, ...args]) =>
  new Promise((resolve) => execFile(file!, args, { timeout: 10_000, windowsHide: true }, (error) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0 })));

export type InboxLoginItem = {
  /** Where it would be written, or null where there is none (Windows). */
  path: string | null;
  add(): Promise<"added" | "unavailable">;
  remove(): Promise<void>;
  /** Add the marker to one written before it (withLoginItemMarker); whether the file changed. */
  mark(): Promise<boolean>;
};

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** One argument of a systemd ExecStart line: quoted, with `%` doubled (systemd's specifiers). */
const unitArg = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/** The plist launchd reads at login: the Inbox, no window, its output in the Inbox's own log. */
export function inboxLoginPlist(o: { argv: readonly string[]; dataDir: string; log: string }): string {
  const string = (s: string) => `<string>${xml(s)}</string>`;
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
    `    <key>PLANNOTATOR_DATA_DIR</key>${string(o.dataDir)}`,
    `    <key>${INBOX_LOGIN_ITEM_ENV}</key>${string("1")}`,
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
    `Environment=${unitArg(`PLANNOTATOR_DATA_DIR=${o.dataDir}`)} ${unitArg(`${INBOX_LOGIN_ITEM_ENV}=1`)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * A login item's text with the marker added, or null when it already has it (or has no place for it). For one
 * written before the marker (0.29's unit and plist), so its run is known as the start at login.
 */
export function withLoginItemMarker(text: string): string | null {
  if (text.includes(INBOX_LOGIN_ITEM_ENV)) return null;
  const lines = text.split("\n");
  if (text.includes("[Service]")) {
    const exec = lines.findIndex((line) => line.startsWith("ExecStart="));
    const at = exec >= 0 ? exec : lines.indexOf("[Service]");
    if (at < 0) return null;
    lines.splice(at + 1, 0, `Environment=${unitArg(`${INBOX_LOGIN_ITEM_ENV}=1`)}`);
    return lines.join("\n");
  }
  const env = lines.findIndex((line) => line.trim() === "<key>EnvironmentVariables</key>");
  if (env >= 0 && lines[env + 1]?.trim() === "<dict>") {
    lines.splice(env + 2, 0, `    <key>${INBOX_LOGIN_ITEM_ENV}</key><string>1</string>`);
    return lines.join("\n");
  }
  const end = lines.lastIndexOf("</dict>");
  if (end < 0) return null;
  lines.splice(end, 0, "  <key>EnvironmentVariables</key>", "  <dict>", `    <key>${INBOX_LOGIN_ITEM_ENV}</key><string>1</string>`, "  </dict>");
  return lines.join("\n");
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
        writeAtomic(path, inboxLoginPlist({ argv: o.argv, dataDir: o.dataDir, log: join(o.dataDir, "inbox", "inbox.log") }));
        return "added";
      },
      // Only the file: launchd reads it at login, and an unload would end this Inbox if the login started it.
      async remove() {
        rmSync(path, { force: true });
      },
      async mark() {
        const marked = existsSync(path) ? withLoginItemMarker(readFileSync(path, "utf8")) : null;
        if (marked === null) return false;
        writeAtomic(path, marked);
        return true;
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
      // systemd reads the changed file at the next login, or now after a daemon-reload.
      async mark() {
        const marked = existsSync(path) ? withLoginItemMarker(readFileSync(path, "utf8")) : null;
        if (marked === null) return false;
        writeAtomic(path, marked);
        await o.run(["systemctl", "--user", "daemon-reload"]).catch(() => undefined);
        return true;
      },
    };
  }
  return { path: null, add: async () => "unavailable", remove: async () => {}, mark: async () => false };
}
