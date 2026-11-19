/**
 * Start at login for routines, on an injected home and command runner (never this computer's). What each
 * test guards: macOS writes a launchd item that starts the Inbox with no window for this data dir, and removing it
 * unloads it first; Linux writes and enables a systemd user unit only when `systemctl --user` answers, and says
 * unavailable otherwise with nothing left behind; Windows has none.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxLoginItem } from "./inbox-scheduled-login";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world(answers: Record<string, number> = {}) {
  const home = mkdtempSync(join(tmpdir(), "plannotator-login-item-"));
  roots.push(home);
  const ran: string[] = [];
  const run = async (argv: string[]) => (ran.push(argv.join(" ")), { code: answers[argv.slice(0, 3).join(" ")] ?? 0 });
  return { home, ran, run, dataDir: join(home, "Plannotator Data") };
}

test("macOS: a launchd item that starts the Inbox with no window; removing it deletes the file and never unloads this Inbox", async () => {
  const w = world();
  const item = inboxLoginItem({ platform: "darwin", home: w.home, argv: ["/opt/plannotator & co/plannotator"], dataDir: w.dataDir, run: w.run });
  expect(await item.add()).toBe("added");
  expect(item.path).toBe(join(w.home, "Library", "LaunchAgents", "ai.plannotator.inbox.plist"));
  const plist = readFileSync(item.path!, "utf8");
  expect(plist).toContain("<string>/opt/plannotator &amp; co/plannotator</string>\n    <string>inbox</string>\n    <string>--no-open</string>");
  expect(plist).toContain(`<key>PLANNOTATOR_DATA_DIR</key><string>${w.dataDir}</string>`);
  expect(plist).toContain("<key>RunAtLoad</key><true/>");
  // Writing it starts nothing now: launchd reads it at the next login.
  expect(w.ran).toEqual([]);
  await item.remove();
  expect(w.ran).toEqual([]);
  expect(existsSync(item.path!)).toBe(false);
});

test("Linux: a user unit only where systemctl --user answers", async () => {
  const none = world({ "systemctl --user show-environment": 1 });
  const missing = inboxLoginItem({ platform: "linux", home: none.home, argv: ["plannotator"], dataDir: none.dataDir, run: none.run });
  expect(await missing.add()).toBe("unavailable");
  expect(existsSync(missing.path!)).toBe(false);

  const w = world();
  const item = inboxLoginItem({ platform: "linux", home: w.home, argv: ["/usr/local/bin/plannotator"], dataDir: "/srv/100%/data", run: w.run });
  expect(await item.add()).toBe("added");
  const unit = readFileSync(item.path!, "utf8");
  expect(unit).toContain('ExecStart="/usr/local/bin/plannotator" "inbox" "--no-open"');
  expect(unit).toContain('Environment="PLANNOTATOR_DATA_DIR=/srv/100%%/data"');
  expect(w.ran).toEqual(["systemctl --user show-environment", "systemctl --user enable plannotator-inbox.service"]);
  await item.remove();
  expect(w.ran.at(-1)).toBe("systemctl --user disable plannotator-inbox.service");
  expect(existsSync(item.path!)).toBe(false);
});

test("Windows: none", async () => {
  const w = world();
  const item = inboxLoginItem({ platform: "win32", home: w.home, argv: ["plannotator"], dataDir: w.dataDir, run: w.run });
  expect(item.path).toBeNull();
  expect(await item.add()).toBe("unavailable");
  expect(w.ran).toEqual([]);
});
