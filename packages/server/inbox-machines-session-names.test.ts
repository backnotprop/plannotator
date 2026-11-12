/**
 * Two real Inboxes linked both ways through the CLI pairing. Catches: a linked machine's rows without its sessions'
 * names, or a rename there that never arrives here.
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

async function poll(m: Machine, session: string, host: string, fields: Json) {
  const health = await getJson(m, "/api/inbox/health");
  const response = await fetch(`${base(m)}${INBOX_BRIDGE_POLL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${registry(m.w).token}` },
    body: JSON.stringify({ session, host, waitMs: 0, project_path: m.w.project, started_at: Date.now(), busy: false, idle_since: Date.now(), serverSession: health.serverSession, ...fields }),
  });
  expect(response.status).toBe(200);
}

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
    const bRows = (onA.sections as Json[]).flatMap((s) => s.threads as Json[]).filter((r) => r.author?.session?.startsWith("ses-b-"));
    expect(bRows.length).toBe(2);

    const onB = await waitFor("B's merged list names A's sessions", async () => {
      const list = await merged(B);
      return list.session_labels?.["ses-a-pi"] && list.session_titles?.["ses-a-titled"] ? list : null;
    });
    expect(onB.session_labels).toMatchObject({ "ses-a-pi": "Docs sweep", "ses-b-named": "Release notes" });
    expect(onB.session_titles).toMatchObject({ "ses-a-titled": "Refund retries", "ses-b-titled": "Fix flaky e2e" });

    const abort = new AbortController();
    const frames: string[] = [];
    const watching = (async () => {
      const response = await fetch(`${base(A)}/api/inbox/events?machines=1`, { signal: abort.signal });
      const decoder = new TextDecoder();
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) frames.push(decoder.decode(chunk, { stream: true }));
    })().catch(() => {});
    try {
      await waitFor("A's stream is open", () => frames.join("").includes("event: "));
      // The first compare after a window opens may already say `labels`: only frames after the rename count.
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
