/**
 * The CLI with the Inbox off (packages/shared/inbox/inbox-on.ts), run as a process the way agents, login items and
 * `/plannotator-inbox` run it, under the real rule (PLANNOTATOR_TEST_INBOX_ON=0) in a scratch home and data dir.
 * Regressions guarded:
 *  - Plannotator's own starts (`--background`, `restart`) on a fresh computer starting the Inbox or writing a record;
 *  - the routines' start at login turning the Inbox back on after off (H1);
 *  - `plannotator inbox mcp` while off listing tools or starting anything, and saying why only in its instructions;
 *  - `plannotator inbox call` while off answering `inbox_not_running` (it invites a start);
 *  - `plannotator inbox status` not saying it is off and why;
 *  - `plannotator inbox --open` (what `/plannotator-inbox` runs) not turning it on when run from an agent's shell.
 *
 * Starts one Inbox (the last test), killed after only when still provably that Inbox: CI runs this file.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { INBOX_OFF_AGENT_LINE } from "@plannotator/shared/inbox/inbox-on-contract";
import { stubbedAgentClis } from "../../../tests/helpers/agent-cli-guard";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { type InboxEntry, inboxEntryOf, stopProvenInboxes } from "../../../tests/helpers/inbox-process";

const entry = resolve(import.meta.dir, "index.ts");
const roots: string[] = [];
const started: { entry: InboxEntry; root: string }[] = [];
let stubs: string[] = [];
beforeAll(() => {
  stubs = stubHookDistHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
});
afterEach(async () => {
  await stopProvenInboxes(started.splice(0), { signal: "SIGKILL" });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const agents = stubbedAgentClis();

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-off-cli-")));
  roots.push(root);
  const home = join(root, "home");
  const dataDir = join(home, ".plannotator");
  mkdirSync(home, { recursive: true });
  const browser = join(root, "fake-browser.sh");
  writeFileSync(browser, "#!/bin/sh\nexit 0\n");
  chmodSync(browser, 0o755);
  const env: Record<string, string> = {
    ...agents.env,
    HOME: home,
    TMPDIR: tmpdir(),
    PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9",
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: browser,
    BROWSER: browser,
    PLANNOTATOR_INBOX_CONNECT: "0",
    // The real rule: no test knob turns an undecided scratch data dir on.
    PLANNOTATOR_TEST_INBOX_ON: "0",
  };
  delete env.PLANNOTATOR_TEST_SANDBOX;
  return { root, home, dataDir, env };
}
type Box = ReturnType<typeof sandbox>;

async function cli(box: Box, args: string[], extra: Record<string, string> = {}) {
  // stdin "ignore": no terminal, as an agent's shell tool, launchd or systemd run it.
  const proc = Bun.spawn([process.execPath, "run", entry, ...args], { cwd: box.root, env: { ...box.env, ...extra }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr, out: `${stdout}${stderr}` };
}

const recordOf = (box: Box) => {
  try {
    return (JSON.parse(readFileSync(join(box.dataDir, "state.json"), "utf8")) as { inboxOn?: { on: boolean; by: string } }).inboxOn ?? null;
  } catch {
    return null;
  }
};
const writeOff = (box: Box) => {
  mkdirSync(box.dataDir, { recursive: true });
  writeFileSync(join(box.dataDir, "state.json"), JSON.stringify({ inboxOn: { on: false, at: "2026-11-18T09:00:00.000Z", by: "off" } }));
};
const registry = (box: Box) => join(box.dataDir, "inbox", "inbox.json");

describe("the Inbox off, from a process", () => {
  test("a fresh computer: Plannotator's own starts are refused with the one line; nothing starts or is written", async () => {
    const box = sandbox();
    for (const args of [["inbox", "--background"], ["inbox", "restart"]]) {
      const run = await cli(box, args, { CLAUDECODE: "1" });
      expect([args.join(" "), run.code]).toEqual([args.join(" "), 1]);
      expect(run.out).toContain(INBOX_OFF_AGENT_LINE);
    }
    expect(existsSync(registry(box))).toBe(false);
    expect(recordOf(box)).toBeNull();
  });

  test("plannotator inbox on and the earlier hidden flag are unknown options now: nothing turned on", async () => {
    const box = sandbox();
    writeOff(box);
    for (const args of [["inbox", "on"], ["inbox", "--open", "--from-slash-command"]]) {
      const run = await cli(box, args);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(`Unknown inbox option: ${args.at(-1)}`);
    }
    expect(recordOf(box)).toMatchObject({ on: false, by: "off" });
  });

  test("H1: after off, the routines' start at login (as launchd runs it) starts nothing and the record stays off", async () => {
    const box = sandbox();
    writeOff(box);
    for (const extra of [{ PLANNOTATOR_INBOX_LOGIN_ITEM: "1" }, { XPC_SERVICE_NAME: "ai.plannotator.inbox" }]) {
      const run = await cli(box, ["inbox", "--no-open"], extra);
      expect(run.code).toBe(1);
    }
    expect(recordOf(box)).toMatchObject({ on: false, by: "off" });
    expect(existsSync(registry(box))).toBe(false);
  });

  // R1: a detached start (an agent call's background start, Restart, an update's restart) is Plannotator's own, whatever its args.
  test("after off, a detached start of plannotator inbox (bare or --no-open) starts nothing and the record stays off", async () => {
    const box = sandbox();
    writeOff(box);
    for (const [args, extra] of [
      [["inbox"], { PLANNOTATOR_INBOX_DETACHED: "1" }],
      [["inbox", "--no-open"], { PLANNOTATOR_INBOX_DETACHED: "1" }],
    ] as const) {
      const run = await cli(box, [...args], extra);
      expect([args.join(" "), run.code]).toEqual([args.join(" "), 1]);
      expect(run.out).toContain(INBOX_OFF_AGENT_LINE);
    }
    expect(recordOf(box)).toMatchObject({ on: false, by: "off" });
    expect(existsSync(registry(box))).toBe(false);
  });

  test("plannotator inbox mcp: initialize says why in its instructions, no tools, a call refused, nothing started", async () => {
    const box = sandbox();
    writeOff(box);
    const transport = new StdioClientTransport({ command: process.execPath, args: ["run", entry, "inbox", "mcp"], env: { ...box.env, CODEX_THREAD_ID: "t" }, cwd: box.root });
    const client = new Client({ name: "codex-mcp-client", version: "1" });
    await client.connect(transport);
    try {
      expect(client.getInstructions()).toBe(INBOX_OFF_AGENT_LINE);
      expect((await client.listTools()).tools).toEqual([]);
      const call = await client.callTool({ name: "send_message", arguments: { body: "Ship it?" } }).then(
        () => "answered",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(call).toContain(INBOX_OFF_AGENT_LINE);
    } finally {
      await client.close();
    }
    expect(existsSync(registry(box))).toBe(false);
  });

  test("plannotator inbox call: refused as inbox_off with the one line, never inbox_not_running", async () => {
    const box = sandbox();
    writeOff(box);
    const run = await cli(box, ["inbox", "call", "send_message", JSON.stringify({ body: "Ship it?" })], { CLAUDECODE: "1" });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`inbox_off: ${INBOX_OFF_AGENT_LINE}`);
    expect(existsSync(registry(box))).toBe(false);
  });

  test("plannotator inbox status says off and why", async () => {
    const box = sandbox();
    writeOff(box);
    const run = await cli(box, ["inbox", "status"]);
    expect(run.stdout).toContain("  turned:   off (turned off, 2026-11-18T09:00:00.000Z)");
  });

  test("plannotator inbox --open (what /plannotator-inbox runs) from an agent's shell with no terminal turns it on and opens it", async () => {
    const box = sandbox();
    writeOff(box);
    const run = await cli(box, ["inbox", "--open"], { GEMINI_CLI: "1" });
    const live = inboxEntryOf(box.dataDir);
    if (live) started.push({ entry: live, root: box.root });
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^http:\/\/(?:localhost|127\.0\.0\.1):\d+\//);
    expect(recordOf(box)).toMatchObject({ on: true, by: "command" });
  });
});
