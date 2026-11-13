/**
 * The agent door (inbox-agent-door.ts): a paired cloud agent through the Inbox's real routes on loopback, its webhook
 * a local stub. Every test has its own temp data dir; nothing outside this computer is called.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxCloudAgentView } from "@plannotator/core/inbox-cloud";
import type { InboxListRow } from "@plannotator/core/inbox-types";
import { decodeInboxAgentPairing } from "@plannotator/shared/inbox/agent-pairing";
import { sha256Hex } from "@plannotator/shared/inbox/devices";
import { runInboxCallCommand } from "../../apps/hook/server/inbox-call-command";
import { cloudAgentsPath } from "./inbox-cloud-agents";
import { INBOX_AGENT_ATTACHMENTS_MAX_BYTES } from "./inbox-agent-door";
import { DOOR_KEY as KEY, doorCleanups, doorWorld, filesUnder, until } from "../../tests/helpers/inbox-agent-door-world";

const cleanups = doorCleanups();
afterEach(() => cleanups.run());
const world = () => doorWorld(cleanups);

describe("the agent door", () => {
  test("pairing mints an agent device (token hash, 0600 secret); it posts as itself, the reply wakes it, and Remove refuses it at once and deletes its secret and key", async () => {
    const w = await world();
    const { agent, pairing, hook } = await w.pair();
    const devices = readFileSync(join(w.dataDir, "inbox", "devices.jsonl"), "utf8");
    expect(devices).toContain(sha256Hex(pairing.token));
    expect(devices).not.toContain(pairing.token);
    expect(JSON.parse(devices.trim().split("\n").at(-1)!).record).toMatchObject({ id: pairing.device_id, platform: "agent", carriage: false, revoked_at: null });
    const secretFile = join(w.dataDir, "inbox", "device-secrets", pairing.device_id);
    expect(readFileSync(secretFile, "utf8")).toBe(pairing.secret);
    expect(statSync(secretFile).mode & 0o777).toBe(0o600);
    // Not a phone: the window's device list leaves it out.
    expect((await w.call("/api/inbox/devices")).json.devices).toEqual([]);

    const sent = await w.door(pairing.token, "send_message", { body: "Found the flaky test. Fix it now?", idempotency_key: "s1" });
    expect(sent.error).toBeNull();
    const threadId = sent.result!.structuredContent!.thread_id as string;
    const posted = (await w.thread(threadId)).messages[0]!;
    expect(posted.author).toEqual({ kind: "agent", host: "cloud-grok", session: agent.session, name: "Nightly fixer" });

    await w.call(`/api/inbox/messages/${posted.id}/reply`, { words: "Yes, fix it.", idempotency_key: "r1" });
    await until(() => hook.seen.length === 1);
    expect(String(hook.seen[0]!.text)).toContain("Yes, fix it.");
    const read = await w.door(pairing.token, "read_thread", { thread_id: threadId });
    expect(read.result!.content[0]!.text).toContain("Yes, fix it.");

    await w.call(`/api/inbox/cloud-agents/${agent.session}/remove`, {});
    const refused = await w.door(pairing.token, "read_thread", { thread_id: threadId });
    expect([refused.status, refused.code]).toEqual([401, "device_revoked"]);
    expect(() => statSync(secretFile)).toThrow();
    expect(readFileSync(cloudAgentsPath(w.dataDir), "utf8")).not.toContain(KEY);
    // Its old messages stay.
    expect((await w.thread(threadId)).messages.map((m) => m.body)).toContain("Found the flaky test. Fix it now?");
  });

  test("Hermes or OpenClaw on a server pairs like Other: it posts under its own kind, and a webhook that answers 202 counts as woken", async () => {
    const w = await world();
    for (const preset of ["hermes", "openclaw"] as const) {
      const { agent, pairing, hook } = await w.pair(preset, `Server ${preset}`, 202);
      const sent = await w.door(pairing.token, "send_message", { body: "Nightly run finished.", idempotency_key: `s-${preset}` });
      const threadId = sent.result!.structuredContent!.thread_id as string;
      const posted = (await w.thread(threadId)).messages[0]!;
      expect(posted.author).toEqual({ kind: "agent", host: `cloud-${preset}`, session: agent.session, name: `Server ${preset}` });
      await w.call(`/api/inbox/messages/${posted.id}/reply`, { words: "Thanks.", idempotency_key: `r-${preset}` });
      await until(() => hook.seen.length === 1);
      await until(async () => (await w.thread(threadId)).messages.some((message) => message.cloud_wake?.state === "started"));
    }
  });

  test("an agent token opens no route but its own tools, and a phone's or a stranger's token does not open the agent door", async () => {
    const w = await world();
    const { pairing } = await w.pair();
    const { local } = w;
    // Every non-agent route class through the phone's door: list, a thread, picks, answers, approve, drafts, files, launch, the stream.
    for (const [method, route] of [
      ["GET", "threads"],
      ["GET", `threads/${local.thread_id}`],
      ["POST", `messages/${local.message_id}/picks`],
      ["POST", `messages/${local.message_id}/reply`],
      ["POST", `messages/${local.message_id}/ack`],
      ["GET", `threads/${local.thread_id}/draft`],
      ["GET", `messages/${local.message_id}/image?path=secret.png`],
      ["POST", "uploads"],
      ["POST", "launch/x/stop"],
      ["GET", "events"],
      ["GET", "search?q=zebra"],
      ["POST", "revoke"],
    ] as const) {
      const response = await fetch(`${w.base}/api/inbox/device/${route}`, {
        method,
        headers: { Authorization: `Bearer ${pairing.token}`, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ idempotency_key: route }) } : {}),
      });
      expect([route, response.status, ((await response.json()) as { code: string }).code]).toEqual([route, 403, "agent_not_accepted_here"]);
    }
    for (const tool of ["card", "steps", "messages/x/picks", "approve", "shell", "launch"]) {
      const answer = await w.door(pairing.token, tool, {});
      expect([tool, answer.error?.split(":")[0]]).toEqual([tool, "tool_not_allowed"]);
    }
    expect((await w.door(pairing.token, "read_thread", { thread_id: local.thread_id }, { Origin: "https://evil.example" })).code).toBe("origin_not_allowed");
    expect((await w.door(pairing.token, "read_thread", { thread_id: local.thread_id }, { "X-Forwarded-For": "100.64.0.9" })).status).toBe(403);
    expect((await w.door(pairing.token, "read_thread", { thread_id: local.thread_id }, { Host: "inbox.tailnet.example" })).status).toBe(403);
    expect((await w.door("tok_" + "x".repeat(43), "read_thread", {})).code).toBe("device_token_invalid");

    // A phone, paired the phone way, cannot use the agent door.
    const offer = await w.call("/api/inbox/pairing", {});
    const secret = /secret=([^&]+)/.exec(offer.json.link as string)![1]!;
    const phone = await fetch(`${w.base}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret, name: "iPhone", platform: "ios" }) });
    const { token: phoneToken } = (await phone.json()) as { token: string };
    expect((await w.door(phoneToken, "read_thread", {})).code).toBe("device_not_an_agent");
  });

  test("it cannot set its identity or name a folder; a path is refused and uploaded bytes are attached", async () => {
    const w = await world();
    const { agent, pairing } = await w.pair("claude-routine", "Fixer");
    for (const [field, code] of [
      ["agent_session", "identity_forced"],
      ["agent_name", "identity_forced"],
      ["agent_host", "identity_forced"],
      ["project_path", "path_refused"],
      ["_meta", "validation_error"],
    ] as const) {
      expect((await w.door(pairing.token, "send_message", { body: "Hi", [field]: field === "project_path" ? "/" : "ses-pi" })).error).toStartWith(`${code}:`);
    }
    expect((await w.door(pairing.token, "submit_guide", { guide: { title: "T", sections: [] }, walkthrough: true })).error).toStartWith("path_refused:");
    expect((await w.door(pairing.token, "read_thread", { project_path: w.project })).error).toStartWith("path_refused:");
    const before = filesUnder(join(w.dataDir, "inbox")).length;
    expect((await w.door(pairing.token, "send_message", { body: "See this.", attachments: [join(w.project, "secret.png")] })).error).toStartWith("attachment_path_refused:");
    expect((await w.door(pairing.token, "send_message", { body: "See this.", attachments: ["../../../etc/hosts"] })).error).toStartWith("attachment_path_refused:");
    expect((await w.door(pairing.token, "send_message", { body: "See ![it](secret.png)" })).error).toStartWith("image_path_refused:");
    expect((await w.door(pairing.token, "send_message", { body: "Big.", attachments: [{ name: "big.bin", data: Buffer.alloc(INBOX_AGENT_ATTACHMENTS_MAX_BYTES + 1).toString("base64") }] })).error).toStartWith("attachments_too_large:");
    expect(filesUnder(join(w.dataDir, "inbox")).length).toBe(before);

    const sent = await w.door(pairing.token, "send_message", { body: "The notes.", attachments: [{ name: "notes.md", data: Buffer.from("# From the cloud\n").toString("base64") }] });
    expect(sent.error).toBeNull();
    const message = (await w.thread(sent.result!.structuredContent!.thread_id as string)).messages[0]!;
    expect(message.author).toMatchObject({ host: "cloud-claude", session: agent.session, name: "Fixer" });
    expect(message.attachments!.map((a) => [a.name, a.size])).toEqual([["notes.md", 17]]);
    expect(readFileSync(message.attachments![0]!.path, "utf8")).toBe("# From the cloud\n");
  });

  test("the pairing's token and secret and the webhook key never appear in another API answer, an event, a log line or a file; plannotator inbox call uses the door with PLANNOTATOR_PAIRING", async () => {
    const w = await world();
    const events = await fetch(`${w.base}/api/inbox/events?cursor=0`);
    const reader = events.body!.getReader();
    const { pairing, string } = await w.pair();
    const pairAnswer = w.answers.length;

    const cwd = mkdtempSync(join(tmpdir(), "plannotator-routine-"));
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
    writeFileSync(join(cwd, "report.txt"), "all green");
    let stdout = "";
    let stderr = "";
    const run = (argv: string[], env: Record<string, string | undefined>) =>
      runInboxCallCommand(argv, { cwd, env, ensureRunning: () => Promise.reject(new Error("not used")), out: (text) => void (stdout += text), err: (text) => void (stderr += text) });
    const env = { PLANNOTATOR_PAIRING: string, PLANNOTATOR_PAIRING_DOOR: w.base };
    expect(await run(["send_message", JSON.stringify({ body: "Done: the build is green.", attachments: ["report.txt"], idempotency_key: "c1" })], env)).toBe(0);
    const sent = JSON.parse(stdout) as { thread_id: string };
    expect((await w.thread(sent.thread_id)).messages[0]!.attachments!.map((a) => a.name)).toEqual(["report.txt"]);
    stdout = "";
    expect(await run(["read_thread", JSON.stringify({ thread_id: w.local.thread_id })], env)).toBe(0);
    expect(stdout).toContain("zebra launch");
    expect(await run(["read_thread", "{}"], { PLANNOTATOR_PAIRING: string, PLANNOTATOR_PAIRING_DOOR: "https://relay.example" })).toBe(2);
    expect(stderr).toContain("pairing_door_needed");

    const frames: string[] = [];
    const read = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        frames.push(new TextDecoder().decode(chunk.value));
      }
    })();
    await Bun.sleep(150);
    await reader.cancel();
    await read.catch(() => {});
    await Bun.sleep(400);
    // Where each one belongs: the secret in its own 0600 file, the key in cloud-agents.json, the token nowhere.
    const files = filesUnder(w.dataDir).filter((file) => !file.path.endsWith(join("device-secrets", pairing.device_id)) && file.path !== cloudAgentsPath(w.dataDir));
    expect(w.answers[pairAnswer - 1]).toContain(string);
    const haystacks = [...w.answers.filter((_, i) => i !== pairAnswer - 1), ...frames, ...w.logs, stdout, stderr, ...files.map((file) => file.text)];
    for (const secret of [pairing.token, pairing.secret, string, KEY]) {
      expect(haystacks.filter((text) => text.includes(secret)).map((text) => text.slice(0, 80))).toEqual([]);
    }
    expect(readFileSync(cloudAgentsPath(w.dataDir), "utf8")).not.toContain(pairing.token);
    expect(files.some((file) => file.path.endsWith("debug.log"))).toBe(true);
  });

  test("an agent with no wake address polls: its read delivers the person's message, which is not unread for it again, and the line goes from Saved to Delivered; one with a wake address keeps the queued line", async () => {
    const w = await world();
    const paired = await w.call("/api/inbox/cloud-agents", { name: "Poller", preset: "other" });
    expect(paired.status).toBe(200);
    const poller = paired.json.agent as InboxCloudAgentView;
    expect(poller.wake).toBe(false);
    const token = decodeInboxAgentPairing(paired.json.pairing)!.token;
    const sent = await w.call("/api/inbox/messages", { to: { session: poller.session }, body: "Anything new on the export?", idempotency_key: "poll-1" });
    expect(sent.status).toBe(200);
    const threadId = sent.json.thread_id as string;
    const connection = async (session: string) => (await w.call(`/api/inbox/threads/${threadId}/sessions?asker=${encodeURIComponent(session)}`)).json.asker?.connection;
    const unread = async () => ((await w.door(token, "read_thread")).result!.structuredContent!.threads as { thread_id: string; unread?: boolean }[]).find((row) => row.thread_id === threadId)?.unread === true;

    const line = async (id: string) => {
      const list = (await w.call("/api/inbox/threads")).json as { sections: { threads: InboxListRow[] }[] };
      const delivery = list.sections.flatMap((s) => s.threads).find((r) => r.thread_id === id)?.delivery;
      return delivery ? `${delivery.state}/${delivery.reason}` : null;
    };

    expect((await connection(poller.session))?.polls).toBe(true);
    expect((await w.thread(threadId)).messages[0]!.delivery ?? null).toBeNull();
    expect(await line(threadId)).toBe("saved/reads");
    expect(await unread()).toBe(true);
    expect((await w.door(token, "read_thread", { thread_id: threadId })).error).toBeNull();
    expect(await unread()).toBe(false);
    expect((await w.thread(threadId)).messages[0]!.delivery?.at).toEqual(expect.any(String));
    expect(await line(threadId)).toBe("delivered/delivered");

    const asked = (await w.door(token, "send_message", { body: "The export is done. Ship it?" })).result!.structuredContent as { message_id: string; thread_id: string };
    expect((await w.call(`/api/inbox/messages/${asked.message_id}/reply`, { words: "Ship it.", idempotency_key: "poll-reply-1" })).status).toBe(200);
    expect(await line(asked.thread_id)).toBe("saved/reads");
    expect((await w.door(token, "read_thread", { thread_id: asked.thread_id })).error).toBeNull();
    expect(await line(asked.thread_id)).toBe("delivered/delivered");

    const woken = await w.pair("other", "Woken");
    const toWoken = await w.call("/api/inbox/messages", { to: { session: woken.agent.session }, body: "Run the nightly export.", idempotency_key: "wake-1" });
    const wokenConnection = (await w.call(`/api/inbox/threads/${toWoken.json.thread_id}/sessions?asker=${encodeURIComponent(woken.agent.session)}`)).json.asker?.connection;
    expect(wokenConnection?.polls).toBeUndefined();
    expect(["queued/next_turn", "delivered/delivered"]).toContain((await line(toWoken.json.thread_id))!);
  });
});
