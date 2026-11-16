import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INBOX_CLOUD_MUSE_PAGE } from "@plannotator/core/inbox-cloud";
import { SimAgent } from "../../../scripts/inbox-sim";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";
import { createInboxWorld, destroyInboxWorld, personSends, registry, removeStubbedHtml, stubBuiltHtml, worldEnv, type InboxWorld } from "../../../tests/helpers/inbox-world";
import { sleep, startRelay, until, type Json, type Relay } from "./wrangler-relay";

const PAGE = readFileSync(resolve(import.meta.dir, "../../marketing/src/lib/inbox-muse.md"), "utf8");
const BLOCKS = [...PAGE.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1]!);
const block = (has: string) => {
  const found = BLOCKS.find((text) => text.includes(has));
  if (!found) throw new Error(`the page has no shell block with ${has}`);
  return found;
};
const HOOK_EVERY_MS = 3_500;

type Thread = { messages: { id: string; body: string; author: { kind: string; host?: string; session?: string } }[] };

describe("Muse by Meta, a stand-in following its page literally, through a local relay", () => {
  let relay: Relay;
  let w: InboxWorld;
  let stubs: string[] = [];
  let base = "";
  let serverSession = "";
  let pairingString = "";
  let session = "";
  let muse = "";
  let threadId = "";
  const outputs: string[] = [];
  let hookOn = false;
  let hookLoop: Promise<void> = Promise.resolve();

  const win = async (path: string, body?: Json) => {
    const answer = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", Origin: base },
      ...(body ? { body: JSON.stringify({ serverSession, ...body }) } : {}),
    });
    return { status: answer.status, json: (await answer.json()) as Json };
  };

  const museEnv = (extra: Record<string, string> = {}) => ({
    PATH: w.path,
    HOME: muse,
    PLANNOTATOR_DATA_DIR: join(muse, ".plannotator"),
    PLANNOTATOR_BROWSER: NO_BROWSER,
    TMPDIR: tmpdir(),
    HATCH_HOOK_RUNTIME: join(muse, "hatch-runtime.sh"),
    ...extra,
  });

  const shell = (script: string, extra: Record<string, string> = {}) => {
    const run = Bun.spawnSync(["bash", "-c", script], { env: museEnv(extra), cwd: muse });
    const out = { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
    outputs.push(out.stdout, out.stderr);
    return out;
  };

  const turn = (why: string) => {
    const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "stand-in-muse.ts"), join(muse, "transcript.jsonl"), why], { env: museEnv(), cwd: muse });
    return run.exitCode;
  };

  const lines = (file: string) => (existsSync(join(muse, file)) ? readFileSync(join(muse, file), "utf8").trim().split("\n").filter(Boolean) : []);
  const wakes = () => lines("wakes.log");
  const silences = () => lines("silent.log");
  const pollOnce = (extra: Record<string, string> = {}) => shell("bash ~/hooks/scripts/plannotator-inbox.sh", extra);
  const museAnswers = async () => ((await win(`/api/inbox/threads/${threadId}`)).json.thread as Thread).messages.filter((m) => m.author.kind === "agent" && m.author.session === session);

  const startHook = () => {
    hookOn = true;
    hookLoop = (async () => {
      while (hookOn) {
        const before = wakes().length;
        pollOnce();
        if (wakes().length > before) turn("hook");
        await sleep(HOOK_EVERY_MS);
      }
    })();
  };
  const stopHook = async () => {
    hookOn = false;
    await hookLoop;
  };

  beforeAll(async () => {
    relay = await startRelay("muse", {});
    stubs = stubBuiltHtml();
    w = createInboxWorld("plannotator-muse-", "muse", "muse", { phones: false });
    const env = { ...(process.env as Record<string, string>), ...worldEnv(w), PLANNOTATOR_RELAY_URL: relay.url };
    muse = join(w.root, "muse-home");
    mkdirSync(muse, { recursive: true });
    writeFileSync(
      join(muse, "hatch-runtime.sh"),
      `wake() { printf '%s\\t%s\\n' "$1" "$2" >> "$HOME/wakes.log"; exit 0; }\nsilent() { printf '%s\\n' "$1" >> "$HOME/silent.log"; exit 0; }\nlog() { :; }\n`,
    );
    const run = Bun.spawnSync([join(w.bin, "plannotator"), "inbox", "--background"], { env, cwd: w.root });
    if (run.exitCode !== 0) throw new Error(`inbox --background failed: ${run.stderr.toString()}`);
    base = `http://127.0.0.1:${registry(w).port}`;
    serverSession = ((await (await fetch(`${base}/api/inbox/health`)).json()) as Json).serverSession;
    const local = await SimAgent.connect({ binary: join(w.bin, "plannotator"), env, name: "Pi", host: "pi", cwd: w.project });
    await local.send({ project_path: w.project, subject: "Launch plan", body: "Private plan: the zebra launch." });
    await local.close();
  }, 120_000);

  afterAll(async () => {
    await stopHook();
    if (w) await destroyInboxWorld(w);
    removeStubbedHtml(stubs);
    await relay?.stop();
  });

  test("Settings pairs Muse with no wake: one message naming the Muse page and the pairing string once; a webhook is refused", async () => {
    expect((await win("/api/inbox/cloud-agents", { name: "Muse", preset: "muse", url: "https://example.invalid/hook", key: "k" })).json.code).toBe("no_wake");
    const paired = await win("/api/inbox/cloud-agents", { name: "Muse", preset: "muse" });
    expect(paired.status).toBe(200);
    expect(paired.json.agent.wake).toBe(false);
    expect(paired.json.setup.kind).toBe("message");
    const message = paired.json.setup.message as string;
    expect(message).toContain(INBOX_CLOUD_MUSE_PAGE);
    const found = message.match(/plannotator-pairing-2\.[A-Za-z0-9_-]+/g) ?? [];
    expect(found).toHaveLength(1);
    pairingString = found[0]!;
    session = paired.json.agent.session;
    const wake = await win(`/api/inbox/cloud-agents/${session}/wake`, { url: "https://example.invalid/hook", key: "k" });
    expect([wake.status, wake.json.code]).toEqual([422, "no_wake"]);
  });

  test("setup by the page: the pairing and signal address in 0600 files, whoami connects, and a message sent before setup is answered at once", async () => {
    const sent = await win("/api/inbox/messages", { to: { session }, body: "Find me a train to Leeds on Friday.", idempotency_key: "muse-1" });
    expect(sent.status).toBe(200);
    threadId = sent.json.thread_id;

    const setup = [block("> ~/.config/plannotator/pairing").replace("plannotator-pairing-2.(the whole string)", pairingString), block("export PLANNOTATOR_PAIRING="), block("plannotator inbox call whoami\n"), block("signal_url")].join("\n");
    const ran = shell(`set -e\n${setup}`);
    expect(ran.code).toBe(0);
    for (const file of [".config/plannotator/pairing", ".config/plannotator/signal_url"]) expect(statSync(join(muse, file)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(muse, ".config/plannotator/signal_url"), "utf8").trim()).toStartWith(`${relay.url}/v1/mailboxes/`);
    const agent = ((await win("/api/inbox/cloud-agents")).json.agents as Json[]).find((a) => a.session === session)!;
    expect(agent.link.state).toBe("connected");

    expect(turn("setup")).toBe(0);
    const answers = await museAnswers();
    expect(answers).toHaveLength(1);
    expect(answers[0]!.body).toContain("Find me a train to Leeds on Friday.");
    expect(answers[0]!.author.host).toBe("cloud-muse");
    expect((answers[0] as { wakes?: boolean }).wakes).toBeUndefined();
    expect(turn("setup")).toBe(0);
    expect(await museAnswers()).toHaveLength(1);
  }, 60_000);

  test("the hook: the page's script wakes Muse once per reply, never in a storm, and a dry run writes nothing", async () => {
    mkdirSync(join(muse, "hooks", "scripts"), { recursive: true });
    writeFileSync(join(muse, "hooks", "scripts", "plannotator-inbox.sh"), block("HATCH_HOOK_RUNTIME"), { mode: 0o700 });
    expect(pollOnce().code).toBe(0);
    expect(wakes()).toHaveLength(0);

    startHook();
    const latest = (await museAnswers()).at(-1)!;
    await personSends(w, latest.id, "The 9:40 one, please.");
    await until(museAnswers, (list) => list.length === 2, "Muse's answer through the hook", 30_000);
    await sleep(HOOK_EVERY_MS * 3);
    await stopHook();
    expect(wakes()).toHaveLength(1);
    expect((await museAnswers())[1]!.body).toContain("Muse here (hook)");

    const state = join(muse, "hooks", "state", "plannotator-inbox-signal");
    const seen = readFileSync(state, "utf8");
    await personSends(w, (await museAnswers())[1]!.id, "Window seat.");
    await until(() => (pollOnce({ HATCH_HOOK_DRY_RUN: "1" }), wakes().length), (n) => n > 1, "a dry run that would wake", 15_000);
    expect(readFileSync(state, "utf8")).toBe(seen);
    expect(turn("hook")).toBe(0);
    pollOnce();
  }, 90_000);

  test("without the hook: the 5-minute scheduled turn answers an unread thread and stays quiet when nothing is new", async () => {
    const count = (await museAnswers()).length;
    await personSends(w, (await museAnswers()).at(-1)!.id, "And a hotel near the station.");
    expect(turn("scheduled")).toBe(0);
    const answers = await museAnswers();
    expect(answers).toHaveLength(count + 1);
    expect(answers.at(-1)!.body).toContain("Muse here (scheduled)");
    expect(turn("scheduled")).toBe(0);
    expect(await museAnswers()).toHaveLength(count + 1);
  }, 60_000);

  test("removed in Settings: the hook goes silent instead of waking, a turn learns pairing_removed, and the pairing string was never printed", async () => {
    const before = wakes().length;
    expect((await win(`/api/inbox/cloud-agents/${session}/remove`, {})).json.removed).toBe(true);
    await sleep(1_000);
    expect(pollOnce().code).toBe(0);
    expect(wakes()).toHaveLength(before);
    expect(silences().at(-1)).toBe("plannotator-inbox: signal not reachable");
    expect(turn("scheduled")).toBe(3);

    const said = [...outputs, readFileSync(join(muse, "transcript.jsonl"), "utf8"), ...wakes(), ...silences(), readFileSync(join(w.dataDir, "inbox", "inbox.log"), "utf8")].join("\n");
    expect(said.includes(pairingString)).toBe(false);
  }, 30_000);
});
