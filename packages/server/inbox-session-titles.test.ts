/**
 * A name for a session the person never named, for list rows only (option A, 2026-11-10): the host's generated title
 * (a poll's `title`) and Claude Code's own name for the session (`claude agents --json`, inbox-claude-names.ts) reach
 * the list as `session_titles`. The failures this catches: a generated title that leaks into `session_labels` (it
 * would show as the session's name in the @ picker, the To menu and every author line, which the owner has not
 * decided); a title that sticks after the session cleared it; a guest reading one;
 * Claude Code asked with no session live or no window watching, or asked again while a call is running. No real `claude` runs: the
 * listing is a fake environment.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_BRIDGE_POLL_PATH } from "@plannotator/shared/inbox/connection";
import { createAgentEnvironmentFor, type AgentEnvironment, type AgentRunResult } from "./inbox-agents";
import { CLAUDE_NAMES_EVERY_MS, createInboxClaudeNames, pluginTooOldForNames } from "./inbox-claude-names";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const restoreEnv: (() => void)[] = [];
const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const server of servers.splice(0)) server.stop();
  for (const restore of restoreEnv.splice(0).reverse()) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setEnv(name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restoreEnv.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

/** A fake environment whose `claude agents --json` answers `listing()`; every run is recorded. */
function fakeClaude(listing: () => unknown, found = true) {
  const runs: string[][] = [];
  let release: (() => void) | null = null;
  const environment: AgentEnvironment = {
    platform: process.platform,
    homeDir: "/nowhere",
    env: {},
    which: (command) => (found && command === "claude" ? "/fake/bin/claude" : null),
    run: async (argv) => {
      runs.push([...argv]);
      if (release === null && hold) await new Promise<void>((resolve) => (release = resolve));
      return { exitCode: 0, timedOut: false, stdout: JSON.stringify(listing()), stderr: "" } satisfies AgentRunResult;
    },
  };
  let hold = false;
  return {
    environment,
    runs,
    holdNext: () => void (hold = true),
    release: () => {
      hold = false;
      release?.();
    },
  };
}

describe("Claude Code's own names (claude agents --json)", () => {
  test("asked only for a plugin too old to send names: a current plugin, a dev build or no plugin never costs a run", () => {
    for (const version of ["0.28.44", "0.28.49", "0.27.9"]) expect(pluginTooOldForNames(version)).toBe(true);
    for (const version of ["0.28.50", "0.29.0", "1.0.0", "0.0.0-dev", "0.0.0", "0.28.49-beta.1", null]) expect(pluginTooOldForNames(version)).toBe(false);
  });

  test("asked only while wanted, at most once per period and never twice at once; a rename is heard; a gone session keeps its name", async () => {
    let clock = 1_000;
    let wanted = false;
    let changes = 0;
    let listing: unknown = [{ sessionId: "s1", name: "plannotator-3f" }];
    const fake = fakeClaude(() => listing);
    const names = createInboxClaudeNames({ environment: () => fake.environment, wanted: () => wanted, onChange: () => void (changes += 1), now: () => clock });
    stops.push(names.stop);

    await names.refresh();
    expect(fake.runs).toEqual([]);

    wanted = true;
    fake.holdNext();
    const first = names.refresh();
    const second = names.refresh();
    fake.release();
    await Promise.all([first, second]);
    expect(fake.runs).toEqual([["/fake/bin/claude", "agents", "--json"]]);
    expect(names.all()).toEqual({ s1: "plannotator-3f" });
    expect(changes).toBe(1);

    // Within the period: not asked again.
    listing = [{ sessionId: "s1", name: "release 0.28.61" }];
    await names.refresh();
    expect(fake.runs).toHaveLength(1);

    clock += CLAUDE_NAMES_EVERY_MS;
    await names.refresh();
    expect(names.all()).toEqual({ s1: "release 0.28.61" });
    expect(changes).toBe(2);

    // The same listing again: nothing changed, no window told.
    clock += CLAUDE_NAMES_EVERY_MS;
    await names.refresh();
    expect(changes).toBe(2);

    // The session left the listing (it ended): its rows keep the name.
    listing = [];
    clock += CLAUDE_NAMES_EVERY_MS;
    await names.refresh();
    expect(names.all()).toEqual({ s1: "release 0.28.61" });
  });
});

describe("a claude that never answers (#3082's lesson: an outside CLI must never hold the Inbox)", () => {
  // A fake `claude` (a shell script on a scratch PATH, never the real one) that ignores SIGTERM, starts a child that
  // would run for 1000 s, and never exits. The failures: a run with no deadline; a deadline that ends the CLI but not
  // what it started; a second run piling onto the first; a failing claude spawned again every period.
  test("is ended at its deadline with everything it started, never doubled, and asked again only after a longer wait", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-claude-names-hang-")));
    roots.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const pids = join(root, "pids");
    const runs = join(root, "runs");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho run >> "${runs}"\necho $$ >> "${pids}"\ntrap '' TERM\nsleep 1000 &\necho $! >> "${pids}"\nwait\nwait\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const environment = createAgentEnvironmentFor({ platform: process.platform, homeDir: root, env: { HOME: root, PATH: `${bin}:/usr/bin:/bin` } });
    let clock = 1_000;
    const names = createInboxClaudeNames({ environment: () => environment, wanted: () => true, onChange: () => {}, now: () => clock, runTimeoutMs: 400 });
    stops.push(names.stop);

    const started = Date.now();
    const first = names.refresh();
    expect(names.refresh()).toBe(first);
    await first;
    expect(Date.now() - started).toBeLessThan(3_000);
    const runCount = () => readFileSync(runs, "utf8").trim().split("\n").length;
    expect(runCount()).toBe(1);
    const alive = (pid: string) => spawnSync("ps", ["-p", pid, "-o", "stat="], { encoding: "utf8" }).stdout.trim().replace(/^Z.*/, "");
    const ids = readFileSync(pids, "utf8").trim().split("\n");
    expect(ids).toHaveLength(2);
    for (let i = 0; i < 20 && ids.some(alive); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(ids.filter(alive)).toEqual([]);

    // Failed once: the next run waits twice the period.
    clock += CLAUDE_NAMES_EVERY_MS;
    await names.refresh();
    expect(runCount()).toBe(1);
    clock += CLAUDE_NAMES_EVERY_MS;
    await names.refresh();
    expect(runCount()).toBe(2);
    expect(existsSync(pids)).toBe(true);
  });
});

describe("a poll's generated title", () => {
  async function setup() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-session-titles-")));
    roots.push(root);
    const project = join(root, "plannotator");
    mkdirSync(project, { recursive: true });
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    setEnv("PLANNOTATOR_DATA_DIR", dataDir);
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ updateCheck: false }));
    const server = await startInboxServer({ dataDir, binaryPath: null });
    servers.push(server);
    return { server, project };
  }

  async function poll(server: InboxServer, session: string, project: string, fields: Record<string, unknown>) {
    const response = await fetch(`http://127.0.0.1:${server.port}${INBOX_BRIDGE_POLL_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ session, host: "claude-code", waitMs: 0, project_path: project, started_at: Date.now(), busy: false, ...fields }),
    });
    expect(response.status).toBe(200);
  }

  async function list(server: InboxServer) {
    const origin = `http://127.0.0.1:${server.port}`;
    return (await (await fetch(`${origin}/api/inbox/threads`, { headers: { Origin: origin } })).json()) as { session_labels: Record<string, string>; session_titles: Record<string, string> };
  }

  test("reaches session_titles, never session_labels; it follows each poll and clears; a title reading 'You' is refused", async () => {
    const { server, project } = await setup();
    await poll(server, "ses-a", project, { label: "", title: "Plannotator usage reference" });
    await poll(server, "ses-b", project, { label: "release 0.28.61", title: "Release notes draft" });
    await poll(server, "ses-c", project, { title: "You" });
    let model = await list(server);
    expect(model.session_titles).toEqual({ "ses-a": "Plannotator usage reference", "ses-b": "Release notes draft" });
    expect(model.session_labels).toEqual({ "ses-b": "release 0.28.61" });

    await poll(server, "ses-a", project, { label: "", title: "Usage reference, take two" });
    await poll(server, "ses-b", project, { label: "release 0.28.61" });
    model = await list(server);
    expect(model.session_titles).toEqual({ "ses-a": "Usage reference, take two" });
  });
});
