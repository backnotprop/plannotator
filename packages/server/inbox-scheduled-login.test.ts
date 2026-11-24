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

/** The EnvironmentVariables dictionary of a written plist, as text, to compare key order and escaping exactly. */
const envBlock = (plist: string) => {
  const start = plist.indexOf("<key>EnvironmentVariables</key>");
  return plist
    .slice(start, plist.indexOf("</dict>", start))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
};

/** Puts a plist at the item's path (the item writes it itself first, so the rest is exactly what it generates). */
function putExisting(item: { path: string | null }, text: string) {
  mkdirSync(dirname(item.path!), { recursive: true });
  writeFileSync(item.path!, text);
}

test("macOS: EnvironmentVariables a person added survive a rewrite, sorted, and PLANNOTATOR_DATA_DIR is the generated one", async () => {
  const w = world();
  const item = inboxLoginItem({ platform: "darwin", home: w.home, argv: ["plannotator"], dataDir: w.dataDir, run: w.run });
  await item.add();
  const stale = join(w.home, "old data");
  putExisting(
    item,
    readFileSync(item.path!, "utf8")
      .replace("<key>PLANNOTATOR_DATA_DIR</key>", "<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>\n    <key>NO_PROXY</key><string>mac-mini.tailnet</string>\n    <key>ANTHROPIC_API_KEY</key><string>sk-test</string>\n    <key>PLANNOTATOR_DATA_DIR</key>")
      .replace(`<string>${w.dataDir}</string>`, `<string>${stale}</string>`),
  );
  expect(await item.add()).toBe("added");
  expect(envBlock(readFileSync(item.path!, "utf8"))).toBe(
    [
      "<key>EnvironmentVariables</key>",
      "<dict>",
      "<key>ANTHROPIC_API_KEY</key><string>sk-test</string>",
      "<key>NO_PROXY</key><string>mac-mini.tailnet</string>",
      "<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>",
      `<key>PLANNOTATOR_DATA_DIR</key><string>${w.dataDir}</string>`,
    ].join("\n"),
  );
});

test("macOS: an escaped value is read back and written escaped once, not twice", async () => {
  const w = world();
  const item = inboxLoginItem({ platform: "darwin", home: w.home, argv: ["plannotator"], dataDir: w.dataDir, run: w.run });
  await item.add();
  putExisting(item, readFileSync(item.path!, "utf8").replace("<key>PLANNOTATOR_DATA_DIR</key>", '<key>NOTE</key><string>a &amp; b &lt;c&gt; &quot;d&quot;</string>\n    <key>PLANNOTATOR_DATA_DIR</key>'));
  await item.add();
  await item.add();
  expect(envBlock(readFileSync(item.path!, "utf8"))).toContain('<key>NOTE</key><string>a &amp; b &lt;c&gt; &quot;d&quot;</string>');
});

test("macOS: a missing or unreadable existing plist gives the fresh-install file", async () => {
  const w = world();
  const item = inboxLoginItem({ platform: "darwin", home: w.home, argv: ["plannotator"], dataDir: w.dataDir, run: w.run });
  const log = join(w.dataDir, "inbox", "inbox.log");
  const fresh = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key><string>ai.plannotator.inbox</string>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>plannotator</string>",
    "    <string>inbox</string>",
    "    <string>--no-open</string>",
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    `    <key>PLANNOTATOR_DATA_DIR</key><string>${w.dataDir}</string>`,
    "  </dict>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>ProcessType</key><string>Background</string>",
    `  <key>StandardOutPath</key><string>${log}</string>`,
    `  <key>StandardErrorPath</key><string>${log}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
  expect(await item.add()).toBe("added");
  expect(readFileSync(item.path!, "utf8")).toBe(fresh);

  for (const broken of [
    '<?xml version="1.0"?><plist><dict><key>EnvironmentVariables</key><dict><key>PATH</key>',
    '<?xml version="1.0"?><plist><dict><key>EnvironmentVariables</key><dict><key>PATH</key><string>/bin</string><key>N</key><integer>3</integer></dict></dict></plist>',
    "not a plist at all",
  ]) {
    putExisting(item, broken);
    expect(await item.add()).toBe("added");
    expect(readFileSync(item.path!, "utf8")).toBe(fresh);
  }
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
