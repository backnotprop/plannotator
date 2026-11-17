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
import { inboxReminderText } from "@plannotator/shared/inbox/connection";
import { INBOX_HOOK_REMINDER_TOOL_NAME } from "@plannotator/shared/inbox/reminder-hook";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";

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
writeFileSync(join(dataDir, "inbox", "agents.json"), JSON.stringify({ v: 1, agents: { codex: { reach: "mcp", state: "added" }, kiro: { reach: "mcp", state: "found" } } }));

async function run(args: string[], stdin: "event" | "open" | "ignore" = "event") {
  const proc = Bun.spawn([process.execPath, entry, "inbox", "reminder", ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9", PLANNOTATOR_DATA_DIR: dataDir },
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
  expect(JSON.parse(codex.stdout).hookSpecificOutput).toEqual({ hookEventName: "SessionStart", additionalContext: inboxReminderText(INBOX_HOOK_REMINDER_TOOL_NAME) });
  const kiro = await run(["--agent", "kiro"], "ignore");
  expect(kiro).toEqual({ stdout: `${inboxReminderText(INBOX_HOOK_REMINDER_TOOL_NAME, { wakes: false })}\n`, stderr: "", code: 0 });
  expect(readFileSync(join(dataDir, "inbox", "inbox.json"), "utf8")).toBe(INBOX_JSON);
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
