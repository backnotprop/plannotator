/**
 * Session names across linked machines (the owner's rule of 2026-11-11: whoever sees a row sees its name). Two real
 * Inboxes, each `plannotator inbox --background` under its own temp HOME and PLANNOTATOR_DATA_DIR, linked both ways
 * through the real CLI pairing (as inbox-machines.test.ts does; a `tailscale` and a `claude` stand-in on each PATH
 * fail if ever run). The failures this catches: a linked machine's rows that show its sessions with no name, or with
 * a name that never follows a rename there (each side's merged list must carry the other's `session_labels` and
 * `session_titles`, and hear when they change).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_BRIDGE_POLL_PATH, INBOX_WAKES_META_KEY } from "@plannotator/shared/inbox/connection";
import { createInboxWorld, destroyInboxWorld, registry, removeStubbedHtml, stubBuiltHtml, waitFor, worldEnv, type InboxWorld } from "../../tests/helpers/inbox-world";

type Json = Record<string, any>;

interface Machine {
  w: InboxWorld;
  calls: string;
}

const base = (m: Machine) => `http://127.0.0.1:${registry(m.w).port}`;

function cli(m: Machine, ...args: string[]): { code: number; out: string; err: string } {
  const run = Bun.spawnSync([join(m.w.bin, "plannotator"), "inbox", ...args], { env: { ...(process.env as Record<string, string>), ...worldEnv(m.w), PLANNOTATOR_UPDATE_CHECK: "0" }, cwd: m.w.root });
  return { code: run.exitCode ?? -1, out: run.stdout.toString(), err: run.stderr.toString() };
}

async function getJson(m: Machine, path: string): Promise<Json> {
  return (await (await fetch(`${base(m)}${path}`)).json()) as Json;
}

/** One poll from a session's connection on `m`, with its name fields. */
async function poll(m: Machine, session: string, host: string, fields: Json) {
  const health = await getJson(m, "/api/inbox/health");
  const response = await fetch(`${base(m)}${INBOX_BRIDGE_POLL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${registry(m.w).token}` },
    body: JSON.stringify({ session, host, waitMs: 0, project_path: m.w.project, started_at: Date.now(), busy: false, idle_since: Date.now(), serverSession: health.serverSession, ...fields }),
  });
  expect(response.status).toBe(200);
}

/** A session's send through its waking connection, so the row is that session's. */
async function sends(m: Machine, session: string, host: string, name: string, body: string) {
  const client = new Client({ name: "inbox-machines-names", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base(m)}/mcp`)));
  try {
    await client.callTool({ name: "send_message", arguments: { body, project_path: m.w.project, agent_session: session, agent_host: host, agent_name: name }, _meta: { [INBOX_WAKES_META_KEY]: true } });
  } finally {
    await client.close().catch(() => {});
  }
}

const merged = (m: Machine) => getJson(m, "/api/inbox/threads?machines=1");

describe("session names on linked machines, two real Inboxes", () => {
  let stubs: string[] = [];
  let A: Machine;
  let B: Machine;

  beforeAll(async () => {
    stubs = stubBuiltHtml();
    const machines: Machine[] = [];
    for (const name of ["a", "b"]) {
      const w = createInboxWorld(`plannotator-machine-names-${name}-`, `machine-names-${name}`, "machines");
      const calls = join(w.root, "stand-in-calls.txt");
      // Never the real tailscale or claude: stand-ins that record a call and fail.
      for (const tool of ["tailscale", "claude"]) {
        writeFileSync(join(w.bin, tool), `#!/bin/sh\necho "${tool} $*" >> '${calls}'\nexit 1\n`);
        chmodSync(join(w.bin, tool), 0o755);
      }
      const m = { w, calls };
      const started = cli(m, "--background");
      if (started.code !== 0) throw new Error(`inbox --background failed: ${started.err}`);
      machines.push(m);
    }
    [A, B] = machines as [Machine, Machine];
    // The person links A to B with B's code: both ways.
    const offered = cli(B, "link", "--offer");
    expect(offered.code).toBe(0);
    const linked = cli(A, "link", offered.out.trim(), "--address", base(B), "--back", base(A));
    if (linked.code !== 0) throw new Error(`link failed: ${linked.err}`);
    expect(linked.out).toContain("both ways");
  }, 60_000);

  afterAll(async () => {
    for (const m of [A, B]) {
      if (!m) continue;
      expect(existsSync(m.calls)).toBe(false);
      await destroyInboxWorld(m.w);
    }
    removeStubbedHtml(stubs);
  });

  test("each machine's merged list names the other's sessions, the person's rename and the generated title, and follows a rename there", async () => {
    // On B: a session the person named, and one with only its generated title. On A: the same, Pi named.
    await poll(B, "ses-b-named", "claude-code", { label: "Release notes" });
    await poll(B, "ses-b-titled", "claude-code", { label: "", title: "Fix flaky e2e" });
    await sends(B, "ses-b-named", "claude-code", "Claude Code", "Notes drafted for 0.29.");
    await sends(B, "ses-b-titled", "claude-code", "Claude Code", "The e2e retry is in.");
    await poll(A, "ses-a-pi", "pi", { label: "Docs sweep" });
    await poll(A, "ses-a-titled", "claude-code", { label: "", title: "Refund retries" });
    await sends(A, "ses-a-pi", "pi", "Pi", "Docs swept.");

    const onA = await waitFor("A's merged list names B's sessions", async () => {
      const list = await merged(A);
      return list.session_labels?.["ses-b-named"] && list.session_titles?.["ses-b-titled"] ? list : null;
    });
    expect(onA.session_labels).toMatchObject({ "ses-b-named": "Release notes", "ses-a-pi": "Docs sweep" });
    expect(onA.session_titles).toMatchObject({ "ses-b-titled": "Fix flaky e2e", "ses-a-titled": "Refund retries" });
    // B's rows are on A's list, named by B's sessions.
    const bRows = (onA.sections as Json[]).flatMap((s) => s.threads as Json[]).filter((r) => r.author?.session?.startsWith("ses-b-"));
    expect(bRows.length).toBe(2);

    const onB = await waitFor("B's merged list names A's sessions", async () => {
      const list = await merged(B);
      return list.session_labels?.["ses-a-pi"] && list.session_titles?.["ses-a-titled"] ? list : null;
    });
    expect(onB.session_labels).toMatchObject({ "ses-a-pi": "Docs sweep", "ses-b-named": "Release notes" });
    expect(onB.session_titles).toMatchObject({ "ses-a-titled": "Refund retries", "ses-b-titled": "Fix flaky e2e" });

    // The person renames B's session there: A hears it from B's stream, with no list read asked by anyone.
    const abort = new AbortController();
    const frames: string[] = [];
    const watching = (async () => {
      const response = await fetch(`${base(A)}/api/inbox/events?machines=1`, { signal: abort.signal });
      const decoder = new TextDecoder();
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) frames.push(decoder.decode(chunk, { stream: true }));
    })().catch(() => {});
    try {
      await waitFor("A's stream is open", () => frames.join("").includes("event: "));
      // Whatever the first compare after a window opens says passes first: only what follows the rename counts.
      await Bun.sleep(2_500);
      frames.length = 0;
      await poll(B, "ses-b-named", "claude-code", { label: "Release 0.29 notes" });
      await waitFor("A's window is told a name changed", () => /event: deliveries\ndata: \{[^}]*"labels":true/.test(frames.join("")));
      await waitFor("A's merged list has the new name", async () => (await merged(A)).session_labels?.["ses-b-named"] === "Release 0.29 notes");
    } finally {
      abort.abort();
      await watching;
    }
  }, 60_000);
});
