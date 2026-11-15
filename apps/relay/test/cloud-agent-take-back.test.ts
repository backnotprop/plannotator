import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveRelaySignalToken } from "@plannotator/core/crypto";
import { decodeInboxAgentPairing } from "../../../packages/shared/inbox/agent-pairing";
import { SimAgent } from "../../../scripts/inbox-sim";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";
import { createInboxWorld, destroyInboxWorld, personSends, registry, removeStubbedHtml, stubBuiltHtml, worldEnv, type InboxWorld } from "../../../tests/helpers/inbox-world";
import { startRelay, until, type Json, type Relay } from "./wrangler-relay";

const EARLY = "Use the ARM runner, and skip the flaky suite.";
const LATE = "Use the x86 runner after all.";

describe("take back against a cloud agent that reads through the relay, under wrangler dev", () => {
  let relay: Relay;
  let w: InboxWorld;
  let stubs: string[] = [];
  let base = "";
  let serverSession = "";
  let pairing = "";
  let agentRoot = "";

  const win = async (path: string, body?: Json) => {
    const answer = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", Origin: base },
      ...(body ? { body: JSON.stringify({ serverSession, ...body }) } : {}),
    });
    return { status: answer.status, json: (await answer.json()) as Json };
  };

  const cli = (action: string, args: Json) => {
    const run = Bun.spawnSync([join(w.bin, "plannotator"), "inbox", "call", action, JSON.stringify(args)], {
      env: { PATH: w.path, HOME: join(agentRoot, "home"), PLANNOTATOR_DATA_DIR: join(agentRoot, "home", ".plannotator"), PLANNOTATOR_BROWSER: NO_BROWSER, TMPDIR: tmpdir(), PLANNOTATOR_PAIRING: pairing },
      cwd: agentRoot,
    });
    return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
  };

  const appliedThroughRelay = () => (readFileSync(join(w.dataDir, "inbox", "inbox.log"), "utf8").match(/agent command \S+ 200/g) ?? []).length;

  beforeAll(async () => {
    relay = await startRelay("cloud-agent-take-back", {});
    stubs = stubBuiltHtml();
    w = createInboxWorld("plannotator-relay-take-back-", "cloud-agent-take-back", "cloud-agent", { phones: false });
    agentRoot = join(w.root, "agent");
    mkdirSync(join(agentRoot, "home"), { recursive: true });
    expect(realpathSync(w.root).startsWith(realpathSync(tmpdir()))).toBe(true);
    const run = Bun.spawnSync([join(w.bin, "plannotator"), "inbox", "--background"], { env: { ...(process.env as Record<string, string>), ...worldEnv(w), PLANNOTATOR_RELAY_URL: relay.url }, cwd: w.root });
    if (run.exitCode !== 0) throw new Error(`inbox --background failed: ${run.stderr.toString()}`);
    base = `http://127.0.0.1:${registry(w).port}`;
    serverSession = ((await (await fetch(`${base}/api/inbox/health`)).json()) as Json).serverSession;
    const local = await SimAgent.connect({ binary: join(w.bin, "plannotator"), env: { ...(process.env as Record<string, string>), ...worldEnv(w), PLANNOTATOR_RELAY_URL: relay.url }, name: "Pi", host: "pi", cwd: w.project });
    await local.send({ project_path: w.project, subject: "Launch plan", body: "A local thread, so the Inbox has a project." });
    await local.close();
    const paired = await win("/api/inbox/cloud-agents", { name: "Poller", preset: "other" });
    expect(paired.status).toBe(200);
    pairing = (paired.json.setup.message as string).match(/plannotator-pairing-\d\.[A-Za-z0-9_-]+/)![0];
  }, 120_000);

  afterAll(async () => {
    if (w) await destroyInboxWorld(w);
    removeStubbedHtml(stubs);
    await relay?.stop();
  });

  test("a reply taken back before the agent's read is not in what it reads; one it read is refused as read", async () => {
    const decoded = decodeInboxAgentPairing(pairing)!;
    const token = await deriveRelaySignalToken(decoded.secret, decoded.device_id);
    const signal = async () => ((await (await fetch(`${decoded.relay!.url}/v1/mailboxes/${decoded.relay!.mailbox_id}/signals/${token}`)).json()) as Json).signal as string;

    const opened = cli("send_message", { subject: "Retry worker", body: "Which runner should the nightly use?" });
    expect(opened).toMatchObject({ code: 0 });
    const { thread_id: thread, message_id: asked } = JSON.parse(opened.stdout) as Json;

    const quiet = await signal();
    const early = await personSends(w, asked ?? thread, EARLY);
    const moved = await until(signal, (value) => value !== quiet, "the signal for the first reply");
    expect((await win(`/api/inbox/messages/${early}/take-back`, {})).status).toBe(200);

    const late = await personSends(w, asked ?? thread, LATE);
    await until(signal, (value) => value !== moved, "the signal for the second reply");
    const before = appliedThroughRelay();
    const read = cli("read_thread", { thread_id: thread });
    expect(read).toMatchObject({ code: 0 });
    expect(appliedThroughRelay()).toBe(before + 1);
    expect(read.stdout).toContain(LATE);
    expect(read.stdout).not.toContain(EARLY);

    expect(await win(`/api/inbox/messages/${late}/take-back`, {})).toMatchObject({ status: 409, json: { code: "agent_has_it", by: "read" } });
  }, 90_000);
});
