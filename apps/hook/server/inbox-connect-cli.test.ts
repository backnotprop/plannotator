/**
 * `plannotator inbox` connects the agents on this computer (packages/server/
 * inbox-agents.ts), as real processes: fake agent CLIs on a scratch PATH and
 * a scratch HOME (tests/helpers/fake-agents.ts). `--background` (what agents
 * run) never connects; a person's `plannotator inbox` does, whether it starts
 * the Inbox or finds one an agent started; a later run connects an agent
 * installed since and says so once; PLANNOTATOR_INBOX_CONNECT=0 skips it.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readInboxAgents } from "@plannotator/server/inbox-agents";
import { createFakeAgents, type FakeAgents } from "../../../tests/helpers/fake-agents";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";
import { type InboxEntry, inboxEntryOf, stopProvenInboxes } from "../../../tests/helpers/inbox-process";

const entry = resolve(import.meta.dir, "index.ts");
let stubs: string[] = [];
const started: { entry: InboxEntry; root: string }[] = [];
const worlds: FakeAgents[] = [];

beforeAll(() => {
  stubs = stubHookDistHtml();
});
afterAll(() => removeStubbedHtml(stubs));
afterEach(async () => {
  for (const world of worlds) {
    const running = inboxEntryOf(join(world.home, ".plannotator"));
    if (running) started.push({ entry: running, root: world.root });
  }
  await stopProvenInboxes(started.splice(0));
  for (const world of worlds.splice(0)) world.remove();
});

function world(): FakeAgents {
  const w = createFakeAgents("plannotator-connect-cli-");
  worlds.push(w);
  return w;
}

function envOf(w: FakeAgents, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...w.env,
    PLANNOTATOR_DATA_DIR: join(w.home, ".plannotator"),
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
    PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9",
    PLANNOTATOR_UPDATE_API_URL: "http://127.0.0.1:9/releases/latest",
    PLANNOTATOR_INSTALL_SCRIPT_URL: "http://127.0.0.1:9/install.sh",
    PLANNOTATOR_INBOX_PHONES: "0",
    PLANNOTATOR_INBOX_CONNECT: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...extra,
  };
}

async function cli(w: FakeAgents, args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, "run", entry, ...args], { cwd: w.root, env: envOf(w, extra), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

const adds = (w: FakeAgents) => w.calls().filter((call) => call.args[1] === "add").map((call) => call.name);

test("--background never connects; a person's run on that Inbox does; a later run connects what is new", async () => {
  const w = world();
  w.install("codex", "gemini");

  const bg = await cli(w, ["inbox", "--background"]);
  expect(bg.code).toBe(0);
  expect(bg.stdout).toMatch(/^http:\/\/localhost:\d+\/\n$/);
  expect(w.calls()).toEqual([]);

  const person = await cli(w, ["inbox", "--no-open"]);
  expect(person.code).toBe(0);
  expect(person.stdout).toBe("");
  expect(person.stderr).toContain("Connected Codex and Gemini CLI to the Inbox.");
  expect(person.stderr).toContain("Agents use it from their next session.");
  expect(adds(w).sort()).toEqual(["codex", "gemini"]);

  const quiet = await cli(w, ["inbox", "--no-open"]);
  expect(quiet.stderr).not.toContain("Connected");
  expect(adds(w)).toHaveLength(2);

  w.install("amp");
  const later = await cli(w, ["inbox", "--no-open"]);
  expect(later.stderr).toContain("Connected Amp to the Inbox (new on this computer).");
  expect(readInboxAgents(join(w.home, ".plannotator")).agents.amp?.state).toBe("added");
}, 60_000);

test("a person's run that starts the Inbox connects once it listens; PLANNOTATOR_INBOX_CONNECT=0 skips it", async () => {
  const off = world();
  off.install("codex");
  await cli(off, ["inbox", "--background"]);
  const skipped = await cli(off, ["inbox", "--no-open"], { PLANNOTATOR_INBOX_CONNECT: "0" });
  expect(skipped.code).toBe(0);
  expect(off.calls()).toEqual([]);

  const w = world();
  w.install("codex");
  const proc = Bun.spawn([process.execPath, "run", entry, "inbox", "--no-open"], { cwd: w.root, env: envOf(w), stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  let err = "";
  const reader = proc.stderr.getReader();
  const deadline = Date.now() + 30_000;
  // One read at a time: a read that loses the race to the timer is kept, never dropped with its chunk.
  let pending = reader.read();
  while (!err.includes("Connected Codex") && Date.now() < deadline) {
    const chunk = await Promise.race([pending, Bun.sleep(500).then(() => null)]);
    if (!chunk) continue;
    if (chunk.done) break;
    err += new TextDecoder().decode(chunk.value);
    pending = reader.read();
  }
  // The read still waiting is cancelled by releaseLock: expected, not a failure.
  pending.catch(() => {});
  reader.releaseLock();
  expect(err).toContain("Plannotator Inbox: http://localhost:");
  expect(err).toContain("Connected Codex to the Inbox.");
  expect(adds(w)).toEqual(["codex"]);
}, 60_000);

test("an older Inbox's detached start (its Restart into this binary: only the lock marker, no terminal) never connects", async () => {
  // What 0.28.17's Restart, --background and connections spawn: `inbox
  // --no-open` with PLANNOTATOR_INBOX_LOCK_HELD=1 and no PLANNOTATOR_INBOX_DETACHED,
  // stdin closed, output to a file.
  const w = world();
  w.install("codex", "gemini");
  mkdirSync(join(w.home, ".cursor"), { recursive: true });
  const log = join(w.root, "inbox.log");
  const fd = openSync(log, "a", 0o600);
  Bun.spawn([process.execPath, "run", entry, "inbox", "--no-open"], {
    cwd: w.root,
    env: envOf(w, { PLANNOTATOR_INBOX_LOCK_HELD: "1" }),
    stdout: fd,
    stderr: fd,
    stdin: "ignore",
  });
  closeSync(fd);
  const output = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  const deadline = Date.now() + 45_000;
  while (!output().includes("Plannotator Inbox: http://localhost:") && Date.now() < deadline) await Bun.sleep(250);
  expect(output()).toContain("Plannotator Inbox: http://localhost:");
  // A person's start connects right after this line; give it ample time to.
  await Bun.sleep(5_000);
  const err = output();
  expect(err).not.toContain("Connected");
  expect(w.calls()).toEqual([]);
  expect(existsSync(join(w.home, ".cursor", "mcp.json"))).toBe(false);
  expect(Object.values(readInboxAgents(join(w.home, ".plannotator")).agents).filter((a) => a?.state === "added")).toEqual([]);

  // The same computer and Inbox: a person's run does connect them.
  const person = await cli(w, ["inbox", "--no-open"]);
  expect(person.stderr).toContain("Connected");
  expect(adds(w).sort()).toEqual(["codex", "gemini"]);
  expect(existsSync(join(w.home, ".cursor", "mcp.json"))).toBe(true);
}, 90_000);

test("plannotator inbox --notes adds only the notes named, starts nothing, and answers the window's question", async () => {
  const w = world();
  mkdirSync(join(w.home, ".codex"), { recursive: true });
  writeFileSync(join(w.home, ".codex", "AGENTS.md"), "Mine.\n");
  mkdirSync(join(w.home, ".gemini"), { recursive: true });
  const result = await cli(w, ["inbox", "--notes", "codex,gemini"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Codex: Added a marked section to ~/.codex/AGENTS.md.");
  expect(result.stderr).toContain("Gemini CLI: Created ~/.gemini/GEMINI.md.");
  expect(readFileSync(join(w.home, ".codex", "AGENTS.md"), "utf8")).toContain("<!-- plannotator-inbox:start v1");
  expect(existsSync(join(w.home, ".pi"))).toBe(false);
  expect(existsSync(join(w.home, ".plannotator", "inbox", "inbox.json"))).toBe(false);
  expect(JSON.parse(readFileSync(join(w.home, ".plannotator", "config.json"), "utf8")).inboxAgentNotes).toEqual({ offered: true, asked: ["codex", "gemini"] });

  const bad = await cli(w, ["inbox", "--notes", "vscode"]);
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("Unknown agent for --notes: vscode");
}, 60_000);
