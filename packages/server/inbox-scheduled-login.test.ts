/**
 * Start at login for routines, on an injected home and command runner (never this computer's). What each
 * test guards: macOS writes a launchd item that starts the Inbox with no window for this data dir, and removing it
 * unloads it first; Linux writes and enables a systemd user unit only when `systemctl --user` answers, and says
 * unavailable otherwise with nothing left behind; Windows has none. On macOS a rewrite keeps the EnvironmentVariables
 * a person added, read by plutil (scripted here everywhere, the real one on macOS on temp files), and when plutil cannot
 * read them the file is the fresh-install one.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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

/** The plutil call the item reads the existing plist with. */
const plutilArgv = (item: { path: string | null }) => ["/usr/bin/plutil", "-extract", "EnvironmentVariables", "json", "-o", "-", item.path!];

/**
 * The real /usr/bin/plutil, and only for files under this test's temp home (macOS only: other runners have none, and
 * the same logic is covered there by the scripted runners below).
 */
const onMac = test.skipIf(process.platform !== "darwin");
const realPlutil = (w: { home: string; ran: string[] }): LoginRunner => async (argv) => {
  w.ran.push(argv.join(" "));
  if (argv[0] !== "/usr/bin/plutil" || !argv.at(-1)!.startsWith(w.home)) return { code: 1 };
  return execLoginCommand(argv);
};
/** What launchd would read out of the written file, by the real plutil. */
const readBack = (file: string) => JSON.parse(execFileSync("/usr/bin/plutil", ["-extract", "EnvironmentVariables", "json", "-o", "-", file], { encoding: "utf8" }));

/** The generated file with no person entries, as the item writes it on a fresh install. */
const freshPlist = (dataDir: string) => {
  const log = join(dataDir, "inbox", "inbox.log");
  return [
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
    `    <key>PLANNOTATOR_DATA_DIR</key><string>${dataDir}</string>`,
    "  </dict>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>ProcessType</key><string>Background</string>",
    `  <key>StandardOutPath</key><string>${log}</string>`,
    `  <key>StandardErrorPath</key><string>${log}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
};

/** A person's plist as they might have edited it by hand, with `entries` inside EnvironmentVariables. */
const handEdited = (entries: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.plannotator.inbox</string>
  <key>EnvironmentVariables</key>
  <dict>
${entries}
  </dict>
</dict>
</plist>
`;

test("macOS: what plutil reads is kept: every string entry, sorted; other values skipped; PLANNOTATOR_DATA_DIR the generated one", async () => {
  const w = world();
  const asked: string[][] = [];
  const run: LoginRunner = async (argv) => {
    asked.push(argv);
    return {
      code: 0,
      stdout: JSON.stringify({
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        HTTPS_PROXY: "http://proxy.harbor.invalid:8080",
        PLANNOTATOR_DATA_DIR: "/old/data",
        COUNT: 3,
        DEBUG: true,
        LIST: ["x"],
        NESTED: { A: "b" },
        NOTHING: null,
      }),
    };
  };
  const item = inboxLoginItem({ platform: "darwin", home: w.home, argv: ["plannotator"], dataDir: w.dataDir, run });
  // A file is there (a binary one, say: any content the item cannot read itself).
  putExisting(item, "bplist00 not text");
  expect(await item.add()).toBe("added");
  expect(asked).toEqual([plutilArgv(item)]);
  expect(envBlock(readFileSync(item.path!, "utf8"))).toBe(
    [
      "<key>EnvironmentVariables</key>",
      "<dict>",
      "<key>HTTPS_PROXY</key><string>http://proxy.harbor.invalid:8080</string>",
      "<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>",
      `<key>PLANNOTATOR_DATA_DIR</key><string>${w.dataDir}</string>`,
    ].join("\n"),
  );
});

test("macOS: a kept value is written escaped, so the file still loads and reads back the same", async () => {
  const w = world();
  const values = {
    AMP: "a&b <c> \"d\" 'e'",
    LANG: "fr_FR.UTF-8 é ✓ 日本",
    MULTI: "line one\nline two\r\nline three\ttab",
    "KEY<&>": "EXAMPLE_VALUE",
  };
  const run: LoginRunner = async () => ({ code: 0, stdout: JSON.stringify({ ...values, CONTROL: "bell\u0007here", "BAD\u0001KEY": "x", LONE: "\ud800" }) });
  const item = inboxLoginItem({ platform: "darwin", home: w.home, argv: ["plannotator"], dataDir: w.dataDir, run });
  putExisting(item, "bplist00 not text");
  await item.add();
  const plist = readFileSync(item.path!, "utf8");
  expect(plist).toContain("<key>AMP</key><string>a&amp;b &lt;c&gt; &quot;d&quot; 'e'</string>");
  expect(plist).toContain("<key>KEY&lt;&amp;&gt;</key><string>EXAMPLE_VALUE</string>");
  expect(plist).toContain("<key>MULTI</key><string>line one\nline two&#13;\nline three\ttab</string>");
  expect(plist).toContain("<key>LANG</key><string>fr_FR.UTF-8 é ✓ 日本</string>");
  // A character XML cannot carry would make the whole file unloadable: that one entry is dropped instead.
  expect(plist).not.toContain("CONTROL");
  expect(plist).not.toContain("KEY</key><string>x");
  expect(plist).not.toContain("LONE");
  if (process.platform === "darwin") {
    execFileSync("/usr/bin/plutil", ["-lint", item.path!]);
    expect(readBack(item.path!)).toEqual({ ...values, PLANNOTATOR_DATA_DIR: w.dataDir });
  }
});

test("macOS: when plutil is missing, fails or prints something else, the file is the fresh-install one and the Inbox goes on", async () => {
  const runs: [string, LoginRunner][] = [
    ["not found", async () => ({ code: 1 })],
    ["exits non-zero with output", async () => ({ code: 3, stdout: '{"PATH":"/opt/homebrew/bin"}' })],
    ["no output", async () => ({ code: 0 })],
    ["empty output", async () => ({ code: 0, stdout: "" })],
    ["not JSON", async () => ({ code: 0, stdout: "Could not extract value" })],
    ["a JSON string", async () => ({ code: 0, stdout: '"PATH"' })],
    ["a JSON array", async () => ({ code: 0, stdout: '["/opt/homebrew/bin"]' })],
    ["JSON null", async () => ({ code: 0, stdout: "null" })],
    ["rejects", async () => Promise.reject(new Error("spawn /usr/bin/plutil ENOENT"))],
    ["throws", () => {
      throw new Error("spawn /usr/bin/plutil ENOENT");
    }],
  ];
  for (const [why, run] of runs) {
    const w = world();
    const item = inboxLoginItem({ platform: "darwin", home: w.home, argv: ["plannotator"], dataDir: w.dataDir, run });
    // Readable as text, so only plutil decides what is kept.
    putExisting(item, handEdited("    <key>PATH</key><string>/opt/homebrew/bin</string>"));
    expect(await item.add(), why).toBe("added");
    expect(readFileSync(item.path!, "utf8"), why).toBe(freshPlist(w.dataDir));
    expect(existsSync(`${item.path}.${process.pid}.tmp`), why).toBe(false);
  }
});

onMac("macOS, real plutil: binary, commented, <string/>, CDATA and character-reference plists keep the person's values exactly", async () => {
  const cases: { why: string; entries: string; binary?: boolean; kept: Record<string, string> }[] = [
    {
      why: "binary (what `defaults write` leaves)",
      entries: "    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>\n    <key>NO_PROXY</key><string>localhost,ledger.invalid</string>",
      binary: true,
      kept: { PATH: "/opt/homebrew/bin:/usr/bin", NO_PROXY: "localhost,ledger.invalid" },
    },
    {
      why: "an XML comment",
      entries: "    <!-- so gh is found -->\n    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>",
      kept: { PATH: "/opt/homebrew/bin:/usr/bin" },
    },
    {
      why: "<string/>",
      entries: "    <key>EMPTY</key><string/>\n    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>",
      kept: { EMPTY: "", PATH: "/opt/homebrew/bin:/usr/bin" },
    },
    {
      why: "CDATA",
      entries: "    <key>PATH</key><string><![CDATA[/opt/homebrew/bin:/a&b]]></string>",
      kept: { PATH: "/opt/homebrew/bin:/a&b" },
    },
    {
      why: "a numeric character reference",
      entries: "    <key>PATH</key><string>/opt/homebrew/bin&#58;/usr/bin</string>",
      kept: { PATH: "/opt/homebrew/bin:/usr/bin" },
    },
    {
      why: "an integer and a boolean beside the strings",
      entries: "    <key>COUNT</key><integer>3</integer>\n    <key>DEBUG</key><true/>\n    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>",
      kept: { PATH: "/opt/homebrew/bin:/usr/bin" },
    },
  ];
  for (const { why, entries, binary, kept } of cases) {
    const w = world();
    const item = inboxLoginItem({ platform: "darwin", home: w.home, argv: ["plannotator"], dataDir: w.dataDir, run: realPlutil(w) });
    putExisting(item, handEdited(entries));
    if (binary) {
      execFileSync("/usr/bin/plutil", ["-convert", "binary1", item.path!]);
      expect(readFileSync(item.path!).subarray(0, 6).toString(), why).toBe("bplist");
    }
    expect(await item.add(), why).toBe("added");
    expect(w.ran, why).toEqual([plutilArgv(item).join(" ")]);
    execFileSync("/usr/bin/plutil", ["-lint", item.path!]);
    expect(readBack(item.path!), why).toEqual({ ...kept, PLANNOTATOR_DATA_DIR: w.dataDir });
  }
});

onMac("macOS, real plutil: a plist with no EnvironmentVariables, or a date in it, gives the fresh-install file", async () => {
  for (const text of [
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>ai.plannotator.inbox</string></dict></plist>\n',
    // JSON has no date: plutil cannot print this dictionary, so nothing in it is read (as before this change).
    handEdited("    <key>PATH</key><string>/opt/homebrew/bin</string>\n    <key>WHEN</key><date>2026-01-01T00:00:00Z</date>"),
  ]) {
    const w = world();
    const item = inboxLoginItem({ platform: "darwin", home: w.home, argv: ["plannotator"], dataDir: w.dataDir, run: realPlutil(w) });
    putExisting(item, text);
    expect(await item.add()).toBe("added");
    expect(readFileSync(item.path!, "utf8")).toBe(freshPlist(w.dataDir));
  }
});

onMac("macOS: EnvironmentVariables a person added survive a rewrite, sorted, and PLANNOTATOR_DATA_DIR is the generated one", async () => {
  const w = world();
  const item = inboxLoginItem({ platform: "darwin", home: w.home, argv: ["plannotator"], dataDir: w.dataDir, run: realPlutil(w) });
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

onMac("macOS: an escaped value is read back and written escaped once, not twice", async () => {
  const w = world();
  const item = inboxLoginItem({ platform: "darwin", home: w.home, argv: ["plannotator"], dataDir: w.dataDir, run: realPlutil(w) });
  await item.add();
  putExisting(item, readFileSync(item.path!, "utf8").replace("<key>PLANNOTATOR_DATA_DIR</key>", '<key>NOTE</key><string>a &amp; b &lt;c&gt; &quot;d&quot;</string>\n    <key>PLANNOTATOR_DATA_DIR</key>'));
  await item.add();
  await item.add();
  expect(envBlock(readFileSync(item.path!, "utf8"))).toContain('<key>NOTE</key><string>a &amp; b &lt;c&gt; &quot;d&quot;</string>');
});

onMac("macOS: a missing or unreadable existing plist gives the fresh-install file", async () => {
  const w = world();
  const item = inboxLoginItem({ platform: "darwin", home: w.home, argv: ["plannotator"], dataDir: w.dataDir, run: realPlutil(w) });
  const fresh = freshPlist(w.dataDir);
  expect(await item.add()).toBe("added");
  expect(readFileSync(item.path!, "utf8")).toBe(fresh);

  for (const broken of [
    '<?xml version="1.0"?><plist><dict><key>EnvironmentVariables</key><dict><key>PATH</key>',
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
