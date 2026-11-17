/**
 * `plannotator inbox reminder --agent <id>` as the process an agent's hook
 * runs (index.ts; the text: packages/shared/inbox/reminder-hook.ts). What can
 * regress: anything but exit 0 (an agent shows a failed hook), anything on
 * stderr, a wait on a stdin the hook never closes, and an Inbox started or
 * touched. Each run gets a temp HOME and data dir; no Inbox runs.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inboxReminderText, inboxReminderWithRules } from "@plannotator/shared/inbox/connection";
import { INBOX_HOOK_REMINDER_TOOL_NAME } from "@plannotator/shared/inbox/reminder-hook";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const entry = resolve(import.meta.dir, "index.ts");
let stubs: string[] = [];
beforeAll(() => {
  // The CLI imports the built HTML; these runs never read the pages.
  stubs = stubHookDistHtml();
});
afterAll(() => removeStubbedHtml(stubs));

const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-reminder-cli-")));
const home = join(root, "home");
const dataDir = join(root, "data");
mkdirSync(home, { recursive: true });
mkdirSync(join(dataDir, "inbox"), { recursive: true });
const INBOX_JSON = JSON.stringify({ port: 9, pid: 1 });
writeFileSync(join(dataDir, "inbox", "inbox.json"), INBOX_JSON);
writeFileSync(join(dataDir, "inbox", "agents.json"), JSON.stringify({ v: 1, agents: { codex: { reach: "mcp", state: "added" }, kiro: { reach: "mcp", state: "found" }, qwen: { reach: "mcp", state: "added" } } }));
const WAKE = inboxReminderText(INBOX_HOOK_REMINDER_TOOL_NAME);
const NO_WAKE = inboxReminderText(INBOX_HOOK_REMINDER_TOOL_NAME, { wakes: false });

const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9", PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER };
const PYTHON = Bun.which("python3");
/** cli-stdout-pipe.test.ts's parent: reads at once from a socketpair whose send buffer is 4 KB (argv: out file, then the command). */
const SOCKET_PARENT = `
import socket, subprocess, sys
parent, child = socket.socketpair()
child.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
proc = subprocess.Popen(sys.argv[2:], stdout=child.fileno())
child.close()
with open(sys.argv[1], "wb") as out:
    while True:
        chunk = parent.recv(65536)
        if not chunk:
            break
        out.write(chunk)
sys.exit(proc.wait())
`;

async function run(args: string[], stdin: "event" | "open" | "ignore" = "event") {
  const proc = Bun.spawn([process.execPath, entry, "inbox", "reminder", ...args], {
    cwd: root,
    env: ENV,
    stdin: stdin === "ignore" ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== "ignore") {
    const sink = proc.stdin as import("bun").FileSink;
    // What the agents send: one JSON event on stdin.
    sink.write(JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "s1" }));
    if (stdin === "event") await sink.end();
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (stdin === "open") await (proc.stdin as import("bun").FileSink).end();
  return { stdout, stderr, code };
}

test("prints the reminder in the agent's own form, exits 0, says nothing on stderr, and leaves the Inbox alone", async () => {
  const codex = await run(["--agent", "codex"]);
  expect(codex.code, codex.stderr).toBe(0);
  expect(codex.stderr).toBe("");
  // Codex's wake is never claimed from the hook: the no-wake line.
  expect(JSON.parse(codex.stdout).hookSpecificOutput).toEqual({ hookEventName: "SessionStart", additionalContext: NO_WAKE });
  const kiro = await run(["--agent", "kiro"], "ignore");
  expect(kiro).toEqual({ stdout: `${NO_WAKE}\n`, stderr: "", code: 0 });
  expect(readFileSync(join(dataDir, "inbox", "inbox.json"), "utf8")).toBe(INBOX_JSON);
}, 30_000);

test("Qwen Code: the wake line only while Plannotator holds its trusted-sender token for this Qwen home", async () => {
  expect(await run(["--agent", "qwen"])).toEqual({ stdout: `${NO_WAKE}\n`, stderr: "", code: 0 });
  const trust = join(dataDir, "inbox", "qwen-trust.json");
  writeFileSync(trust, JSON.stringify({ v: 1, home: join(home, ".qwen"), id: "grant1", token: `qpc_${"a".repeat(64)}` }));
  expect(await run(["--agent", "qwen"])).toEqual({ stdout: `${WAKE}\n`, stderr: "", code: 0 });
  // A token minted for another Qwen home wakes nothing here.
  writeFileSync(trust, JSON.stringify({ v: 1, home: join(root, "elsewhere", ".qwen"), id: "grant1", token: `qpc_${"a".repeat(64)}` }));
  expect(await run(["--agent", "qwen"])).toEqual({ stdout: `${NO_WAKE}\n`, stderr: "", code: 0 });
}, 30_000);

test("a reminder far past a pipe's buffer arrives whole: valid JSON for Codex, every byte for Kiro", async () => {
  // Three-byte characters: 9,000 characters of the person's own text and rules are about 25 KB.
  const own = `Mine "quoted" ${"€".repeat(4000)}`;
  const rules = `${"規".repeat(2000)}\n${"€".repeat(2000)}`;
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ prompts: { inbox: { reminder: own, rules } } }));
  const text = inboxReminderWithRules(own, rules, INBOX_HOOK_REMINDER_TOOL_NAME);
  expect(text).toContain(rules);
  const codex = await run(["--agent", "codex"]);
  expect(Buffer.byteLength(codex.stdout)).toBeGreaterThan(20_000);
  expect(codex.code).toBe(0);
  expect(JSON.parse(codex.stdout).hookSpecificOutput.additionalContext).toBe(text);
  const kiro = await run(["--agent", "kiro"]);
  expect(kiro).toEqual({ stdout: `${text}\n`, stderr: "", code: 0 });
  // A parent on a small socket (the kind of stdout a parent on libuv hands its child, as cli-stdout-pipe.test.ts
  // reads it): a CLI that exits without waiting for the reader loses what the socket has not taken yet.
  if (PYTHON) {
    const parent = join(root, "socket-parent.py");
    writeFileSync(parent, SOCKET_PARENT);
    for (const agent of ["codex", "kiro"]) {
      const out = join(root, `socket-out-${agent}`);
      const proc = Bun.spawn([PYTHON, parent, out, process.execPath, entry, "inbox", "reminder", "--agent", agent], { cwd: root, env: ENV, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(code, stderr).toBe(0);
      const got = readFileSync(out, "utf8");
      if (agent === "codex") expect(JSON.parse(got).hookSpecificOutput.additionalContext).toBe(text);
      else expect(got).toBe(`${text}\n`);
    }
  }
  writeFileSync(join(dataDir, "config.json"), "{}");
}, 30_000);

test("a stdin the hook never closes does not hold it up", async () => {
  const started = Date.now();
  const held = await run(["--agent", "codex"], "open");
  expect(held.code).toBe(0);
  expect(JSON.parse(held.stdout).hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(Date.now() - started).toBeLessThan(10_000);
}, 30_000);

test("nothing to say, or anything wrong: no output, exit 0", async () => {
  // Not reaching the Inbox, an unknown agent, no agent.
  for (const args of [["--agent", "gemini"], ["--agent", "cursor"], []]) expect(await run(args)).toEqual({ stdout: "", stderr: "", code: 0 });
  // Off in config.json.
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxReminder: { codex: false } }));
  expect(await run(["--agent", "codex"])).toEqual({ stdout: "", stderr: "", code: 0 });
  // A damaged config.json and records.
  writeFileSync(join(dataDir, "config.json"), "{ nope");
  writeFileSync(join(dataDir, "inbox", "agents.json"), "{ nope");
  expect(await run(["--agent", "codex"])).toEqual({ stdout: "", stderr: "", code: 0 });
}, 60_000);
