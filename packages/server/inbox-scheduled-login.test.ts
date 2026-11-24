/**
 * Start at login for routines, on an injected home and command runner (never this computer's). What each
 * test guards: macOS writes a launchd item that starts the Inbox with no window for this data dir, and removing it
 * unloads it first; Linux writes and enables a systemd user unit only when `systemctl --user` answers, and says
 * unavailable otherwise with nothing left behind; Windows has none.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execLoginCommand, inboxLoginItem, type LoginRunner } from "./inbox-scheduled-login";

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

test("macOS: refreshing the launchd item preserves PATH and NO_PROXY from the existing file", async () => {
  const w = world();
  const run: LoginRunner = process.platform === "darwin" ? execLoginCommand : async (argv) => {
    expect(argv).toEqual([
      "/usr/bin/plutil", "-extract", "EnvironmentVariables", "json", "-o", "-",
      join(w.home, "Library", "LaunchAgents", "ai.plannotator.inbox.plist"),
    ]);
    return { code: 0, stdout: JSON.stringify({
      PATH: "/opt/homebrew/bin:/Users/test/bin/a&b:/usr/bin:/bin",
      NO_PROXY: "localhost,example.invalid",
      PLANNOTATOR_DATA_DIR: "/old/data",
      EXAMPLE_TOKEN: "test-placeholder",
    }) };
  };
  const item = inboxLoginItem({ platform: "darwin", home: w.home, argv: ["/opt/plannotator"], dataDir: w.dataDir, run });
  mkdirSync(dirname(item.path!), { recursive: true });
  writeFileSync(item.path!, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>Label</key><string>ai.plannotator.inbox</string>
    <key>ProgramArguments</key><array><string>/old/plannotator</string></array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/Users/test/bin/a&amp;b:/usr/bin:/bin</string>
      <key>NO_PROXY</key><string>localhost,example.invalid</string>
      <key>PLANNOTATOR_DATA_DIR</key><string>/old/data</string>
      <key>EXAMPLE_TOKEN</key><string>test-placeholder</string>
    </dict>
  </dict>
</plist>
`);

  expect(await item.add()).toBe("added");
  const plist = readFileSync(item.path!, "utf8");
  expect(plist).toMatch(/<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/Users\/test\/bin\/a&amp;b:\/usr\/bin:\/bin<\/string>/);
  expect(plist).toMatch(/<key>NO_PROXY<\/key>\s*<string>localhost,example\.invalid<\/string>/);
  expect(plist).toContain("<string>/opt/plannotator</string>");
  expect(plist).toContain(`<key>PLANNOTATOR_DATA_DIR</key><string>${w.dataDir}</string>`);
  expect(plist).not.toContain("/old/data");
  expect(plist).not.toContain("EXAMPLE_TOKEN");
});

test("macOS: disabling the login item while it is being refreshed removes it", async () => {
  const w = world();
  const reading = Promise.withResolvers<void>();
  const environment = Promise.withResolvers<{ code: number; stdout: string }>();
  const item = inboxLoginItem({
    platform: "darwin", home: w.home, argv: ["/opt/plannotator"], dataDir: w.dataDir,
    run: () => {
      reading.resolve();
      return environment.promise;
    },
  });
  await item.add();
  const adding = item.add();
  await reading.promise;
  const removing = item.remove();
  environment.resolve({ code: 0, stdout: '{"PATH":"/opt/homebrew/bin:/usr/bin"}' });
  await Promise.all([adding, removing]);
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
