/**
 * Code review in the Inbox (approval "inbox-code-review-direction", phase 1),
 * proved through a running Inbox's real doors: the MCP SDK client over
 * streamable HTTP for the agent, real `fetch` for the window, config.json
 * (this test's own temp data dir) deciding the switch.
 *
 * What regresses:
 *  - the switch on by default, or a saved switch other windows never hear of;
 *  - anything of code review reaching an agent while the switch is off (the
 *    submit_guide `review` field, the skills in the catalog);
 *  - a review sent, a verdict stored or a Viewed tick saved while it is off;
 *  - a verdict on a message that is not a review, or a Viewed tick on a file
 *    the review does not have;
 *  - a built-in skill shadowing a skill of the person's own with its name.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_REVIEW_SKILL_NAMES, inboxThreadHadReview } from "@plannotator/core/inbox-review";
import type { InboxAnnotationRecord, InboxThread } from "@plannotator/core/inbox-types";
import type { SkillCatalogEntry } from "@plannotator/ui/utils/skillReferences";
import { routeSendAnnotations } from "../inbox/sendTargets";
import { inboxSkillFilter } from "../inbox/skills";
import { attachmentFeedback } from "../inbox/attachments";
import { GUIDE_BRIEF_EXAMPLE } from "./inbox-guides";
import { inboxSkillCatalog } from "./inbox-skills";
import { startInboxServer, type InboxServer } from "./inbox";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { inboxAgentTool, parseInboxToolList } from "@plannotator/shared/inbox/connection";
import { inboxAgentTool as modAgentTool } from "../../apps/hook/hooks/mod/inbox-contract";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-code-review-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  writeFileSync(join(project, "notes.md"), "# Notes\n");
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  // The Inbox reads config.json through the env: this test's own, so the switch is the person's file.
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const client = new Client({ name: "inbox-code-review-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  clients.push(client);
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const setCodeReview = (on: boolean) => post("/api/inbox/settings", { code_review: { on } });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
    return result;
  };
  const sendGuide = (extra: Record<string, unknown> = {}) =>
    call("submit_guide", { project_path: project, ...GUIDE_BRIEF_EXAMPLE, agent_session: "ses_review", agent_name: "Pi", agent_host: "pi", ...extra });
  const submitGuideSchema = async () => {
    const { tools } = await client.listTools();
    return tools.find((tool) => tool.name === "submit_guide")!.inputSchema as { properties: Record<string, unknown> };
  };
  return { root, project, dataDir, server, base, post, setCodeReview, call, sendGuide, submitGuideSchema };
}

/** A scripted `tailscale` that serves this Inbox over a tailnet `magic` name, `owner` its login (as inbox-board-routes.test.ts). */
function scriptedTailscale(magic: string, owner: string): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${magic}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: owner } } }));
    if (args[1] === "status") {
      if (serve.size === 0) return ok("{}");
      return ok(
        JSON.stringify({
          TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])),
          Web: Object.fromEntries([...serve].map(([p, proxy]) => [`${magic}:${p}`, { Handlers: { "/": { Proxy: proxy } } }])),
        }),
      );
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) serve.delete(httpsPort);
    else serve.set(httpsPort, args.at(-1)!);
    return ok(`https://${magic}:${httpsPort}/\n`);
  };
}

describe("the Code review switch", () => {
  test("off by default; on and off are saved in config.json; a malformed switch is refused", async () => {
    const w = await world();
    const read = async () => ((await (await fetch(`${w.base}/api/inbox/settings`)).json()) as { code_review?: { on: boolean } }).code_review;
    // Held until the next big release (inbox.ts heldSwitch): off, the settings read leaves Code review out, so Settings draws no row.
    expect(await read()).toBeUndefined();

    const on = await w.setCodeReview(true);
    expect(on.status).toBe(200);
    expect(((await on.json()) as { code_review: unknown }).code_review).toEqual({ on: true });
    expect(JSON.parse(readFileSync(join(w.dataDir, "config.json"), "utf8")).inboxCodeReview).toBe(true);
    expect(await read()).toEqual({ on: true });

    const off = await w.setCodeReview(false);
    expect(off.status).toBe(200);
    expect(((await off.json()) as { code_review: unknown }).code_review).toEqual({ on: false });
    expect(await read()).toBeUndefined();

    const bad = await w.post("/api/inbox/settings", { code_review: true });
    expect(bad.status).toBe(422);
    expect(await read()).toBeUndefined();
  });

  test("only the owner turns it on: a tailnet guest is refused and the switch stays as it was", async () => {
    const MAGIC = "macbook-pro.tail0000.ts.net";
    const OWNER = "ramos@example.com";
    const GUEST = "guest@example.com";
    const savedTailscale = process.env.PLANNOTATOR_INBOX_TAILSCALE;
    delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
    try {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-code-review-owner-")));
      roots.push(root);
      const dataDir = join(root, "data");
      mkdirSync(dataDir, { recursive: true });
      process.env.PLANNOTATOR_DATA_DIR = dataDir;
      writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscale: true, inboxTailscaleAllow: [GUEST] }));
      const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: scriptedTailscale(MAGIC, OWNER) });
      servers.push(server);
      const listener = server.tailscale.listenerPort();
      expect(listener).not.toBeNull();
      const through = (login: string) =>
        fetch(`http://127.0.0.1:${listener}/api/inbox/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": login, Origin: `https://${MAGIC}:${server.port}` },
          body: JSON.stringify({ code_review: { on: true } }),
        });
      const config = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as { inboxCodeReview?: boolean };

      const guest = await through(GUEST);
      expect(guest.status).toBe(403);
      expect(((await guest.json()) as { code: string }).code).toBe("local_only");
      expect(config().inboxCodeReview).toBeUndefined();

      expect((await through(OWNER)).status).toBe(200);
      expect(config().inboxCodeReview).toBe(true);
    } finally {
      if (savedTailscale === undefined) delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
      else process.env.PLANNOTATOR_INBOX_TAILSCALE = savedTailscale;
    }
  });

  test("a saved switch tells every window (event: capabilities) and never an agent's stream", async () => {
    const w = await world();
    const frames = async (url: string, headers: Record<string, string>) => {
      const response = await fetch(url, { headers });
      const reader = response.body!.getReader();
      const seen: { event: string; data: string }[] = [];
      let buffer = "";
      const decoder = new TextDecoder();
      const pump = (async () => {
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1];
            if (event) seen.push({ event, data: /^data: (.*)$/m.exec(block)?.[1] ?? "" });
          }
        }
      })();
      return { seen, stop: async () => (await reader.cancel().catch(() => {}), await pump) };
    };
    const until = async (ready: () => boolean) => {
      const end = Date.now() + 5_000;
      while (!ready()) {
        if (Date.now() > end) throw new Error("timed out waiting for the event stream");
        await Bun.sleep(5);
      }
    };
    const window = await frames(`${w.base}/api/inbox/events?window=window-one`, { "Sec-Fetch-Site": "same-origin" });
    const agent = await frames(`${w.base}/api/inbox/events`, {});
    await until(() => window.seen.some((f) => f.event === "hello") && agent.seen.some((f) => f.event === "hello"));
    await w.setCodeReview(true);
    await until(() => window.seen.some((f) => f.event === "capabilities"));
    await w.setCodeReview(false);
    await until(() => window.seen.filter((f) => f.event === "capabilities").length >= 2);
    const told = window.seen.filter((f) => f.event === "capabilities").map((f) => JSON.parse(f.data).code_review);
    expect(told).toEqual([{ on: true }, { on: false }]);
    expect(agent.seen.some((f) => f.event === "capabilities")).toBe(false);
    await Promise.all([window.stop(), agent.stop()]);
  });
});

describe("submit_guide's review field", () => {
  test("absent from tools/list while off; a review: true is refused; on, it is listed and the message carries the review", async () => {
    const w = await world();
    expect("review" in (await w.submitGuideSchema()).properties).toBe(false);
    // A session that listed the field before the switch went off: refused, nothing sent (strict schema or the handler).
    const refused = await w.sendGuide({ review: true });
    expect(refused.isError).toBe(true);
    expect(w.server.store.cursor()).toBe(0);

    await w.setCodeReview(true);
    const field = (await w.submitGuideSchema()).properties.review as { type: string; description: string };
    expect(field.type).toBe("boolean");
    const sent = await w.sendGuide({ review: true });
    expect(sent.isError).toBeFalsy();
    expect(sent.content[0]!.text).toStartWith('Sent the review "Token refresh"');
    const message = w.server.store.message(sent.structuredContent.message_id)!;
    expect(message.guide).toMatchObject({ review: true, chapters: ["The guard"] });

    // Without the field, on: today's guided review.
    const plain = await w.sendGuide({ idempotency_key: "plain" });
    expect(w.server.store.message(plain.structuredContent.message_id)!.guide!.review).toBeUndefined();
  });
});

describe("the verdict and the Viewed ticks", () => {
  test("a verdict with the review's comments is stored on the reply, counted; refused while off and on a plain guide", async () => {
    const w = await world();
    await w.setCodeReview(true);
    const sent = (await w.sendGuide({ review: true })).structuredContent;
    const plain = (await w.sendGuide({ idempotency_key: "plain" })).structuredContent;
    const comment = await w.post(`/api/inbox/messages/${sent.message_id}/guide/annotations`, {
      annotation: { id: "ann-1", type: "comment", scope: "line", filePath: "src/auth.ts", lineStart: 1, lineEnd: 1, side: "new", text: "Refresh earlier.", selectedText: "new", createdAt: 1 },
    });
    expect(comment.status).toBe(200);

    // Not a review: refused.
    const wrong = await w.post(`/api/inbox/messages/${plain.message_id}/reply`, { idempotency_key: "v0", words: "ok", review_verdict: "approved" });
    expect(wrong.status).toBe(422);

    // Off: refused, nothing sent, the comment still pending.
    await w.setCodeReview(false);
    const off = await w.post(`/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "v1", words: "ok", review_verdict: "approved" });
    expect(off.status).toBe(409);
    expect(((await off.json()) as { code: string }).code).toBe("code_review_off");

    await w.setCodeReview(true);
    const model = (await (await fetch(`${w.base}/api/inbox/threads/${sent.thread_id}/attachments`)).json()) as { annotations: never[] };
    expect(model.annotations).toHaveLength(1);
    const reply = await w.post(`/api/inbox/messages/${sent.message_id}/reply`, {
      idempotency_key: "v2",
      words: 'I reviewed "Token refresh" and I am asking for changes: my comment is below.',
      feedback: attachmentFeedback(model.annotations, [], new Map(), w.project),
      annotation_ids: ["ann-1"],
      review_verdict: "changes_requested",
    });
    expect(reply.status).toBe(200);
    const stored = ((await reply.json()) as { reply: { id: string; body: string; review_verdict: unknown } }).reply;
    expect(stored.review_verdict).toEqual({ of: sent.message_id, verdict: "changes_requested", comments: 1 });
    expect(stored.body).toContain("# Feedback on the guided review");
    expect(stored.body).toContain("Refresh earlier.");

    const bad = await w.post(`/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "v3", words: "x", review_verdict: "maybe" });
    expect(bad.status).toBe(422);
  });

  test("review comments sent from the reply box mark the reply as a review's, so /review-recheck is offered", async () => {
    const w = await world();
    await w.setCodeReview(true);
    const review = (await w.sendGuide({ review: true })).structuredContent;
    // The agent writes again after the review: the reply box's Send answers this newer message.
    const later = (await w.call("send_message", { body: "Also bumped the timeout.", reply_to: review.message_id, agent_session: "ses_review", agent_host: "pi" })).structuredContent;
    expect(later.thread_id).toBe(review.thread_id);
    const comment = await w.post(`/api/inbox/messages/${review.message_id}/guide/annotations`, {
      annotation: { id: "ann-r", type: "comment", scope: "line", filePath: "src/auth.ts", lineStart: 1, lineEnd: 1, side: "new", text: "Refresh earlier.", selectedText: "new", createdAt: 1 },
    });
    expect(comment.status).toBe(200);
    const readThread = async () => ((await (await fetch(`${w.base}/api/inbox/threads/${review.thread_id}`)).json()) as { thread: InboxThread }).thread;
    const model = (await (await fetch(`${w.base}/api/inbox/threads/${review.thread_id}/attachments`)).json()) as { annotations: InboxAnnotationRecord[] };
    let thread = await readThread();
    expect(inboxThreadHadReview(thread.messages)).toBe(false);

    // The window's Send: the guide comment rides the reply to the newest agent message, with the words.
    const newest = thread.messages.find((m) => m.id === later.message_id)!;
    const routed = routeSendAnnotations(thread, [{ message: newest, questions: [], skip: [], actions: [] }], model.annotations);
    expect(routed.targets.map((t) => t.message.id)).toEqual([later.message_id]);
    const carried = routed.carried.get(later.message_id) ?? [];
    expect(carried.map((r) => r.id)).toEqual(["ann-r"]);
    const reply = await w.post(`/api/inbox/messages/${later.message_id}/reply`, {
      idempotency_key: "box-1",
      words: "See my comment.",
      feedback: attachmentFeedback(carried as never[], [], new Map(), w.project),
      annotation_ids: carried.map((r) => r.id),
    });
    expect(reply.status).toBe(200);

    thread = await readThread();
    expect(inboxThreadHadReview(thread.messages)).toBe(true);
    const offered = ((await (await fetch(`${w.base}/api/inbox/skills`)).json()) as { skills: SkillCatalogEntry[] }).skills;
    expect(offered.filter(inboxSkillFilter(inboxThreadHadReview(thread.messages))).map((s) => s.name)).toContain("review-recheck");
  });

  test("Viewed ticks: saved on the message, only the review's files, refused while off", async () => {
    const w = await world();
    await w.setCodeReview(true);
    const sent = (await w.sendGuide({ review: true })).structuredContent;
    const route = `/api/inbox/messages/${sent.message_id}/guide/viewed`;
    const saved = await w.post(route, { viewed: ["src/auth.ts", "src/auth.ts"] });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { viewed: string[] }).viewed).toEqual(["src/auth.ts"]);
    expect(w.server.store.message(sent.message_id)!.guide_viewed).toEqual(["src/auth.ts"]);

    expect((await w.post(route, { viewed: ["src/elsewhere.ts"] })).status).toBe(422);
    await w.setCodeReview(false);
    expect((await w.post(route, { viewed: [] })).status).toBe(409);
    expect(w.server.store.message(sent.message_id)!.guide_viewed).toEqual(["src/auth.ts"]);
  });
});

describe("the skills catalog", () => {
  const catalog = async (codeReview: boolean, discovered: { name: string; root: string; description: string }[]) =>
    ((await inboxSkillCatalog(codeReview, () => discovered as never).json()) as { skills: { name: string; root: string; humanOnly?: boolean }[] }).skills;

  test("off: no Plannotator skill; on: the offered review skills first, review-guide left out", async () => {
    const own = [{ name: "deploy", root: "agents-project", description: "Ship it" }];
    // Off, the catalog route answers the discovered skills as before (handleReferenceSkills): none of Plannotator's.
    const w = await world();
    const offList = ((await (await fetch(`${w.base}/api/inbox/skills`)).json()) as { skills: { root: string }[] }).skills;
    expect(offList.some((s) => s.root === "plannotator")).toBe(false);
    await w.setCodeReview(true);
    const onList = ((await (await fetch(`${w.base}/api/inbox/skills`)).json()) as { skills: { name: string; root: string }[] }).skills;
    expect(onList.filter((s) => s.root === "plannotator").map((s) => s.name)).toEqual([...INBOX_REVIEW_SKILL_NAMES]);
    expect(onList.some((s) => s.name === "review-guide")).toBe(false);

    const on = await catalog(true, own);
    expect(on.map((s) => `${s.root}:${s.name}`)).toEqual(["plannotator:review-curate", "plannotator:review-recheck", "agents-project:deploy"]);
    expect(on[0]!.humanOnly).toBe(true);
  });

  test("a skill of the person's own with the same name wins", async () => {
    const on = await catalog(true, [{ name: "review-curate", root: "claude-user", description: "Mine" }]);
    expect(on.filter((s) => s.name === "review-curate").map((s) => s.root)).toEqual(["claude-user"]);
    expect(on.some((s) => s.name === "review-recheck" && s.root === "plannotator")).toBe(true);
  });
});

describe("what an agent's tool carries", () => {
  const rawList = async (base: string) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    return (JSON.parse(data ? data.slice(5) : text) as { result: unknown }).result;
  };

  // Off is byte-equal to an Inbox that has no Code review at all: config.json without the key, and with it false.
  test("off: tools/list is byte-equal whether the switch was never set or turned off; on adds only submit_guide's field", async () => {
    const w = await world();
    const never = JSON.stringify(await rawList(w.base));
    expect(never).not.toContain("Approve or Send feedback");
    await w.setCodeReview(true);
    const on = JSON.stringify(await rawList(w.base));
    await w.setCodeReview(false);
    expect(JSON.stringify(await rawList(w.base))).toBe(never);
    // On: the only change is submit_guide's `review` property.
    const strip = (list: string) => {
      const parsed = JSON.parse(list) as { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] };
      for (const tool of parsed.tools) if (tool.name === "submit_guide") delete tool.inputSchema.properties.review;
      return JSON.stringify(parsed);
    };
    expect(on).not.toBe(never);
    expect(strip(on)).toBe(never);
  });

  // Claude Code cuts a tool description at 2,048 characters: the Board, steps and Code review all on, both builders.
  test("the description stays under 2,048 characters with every capability on, and Code review leaves it unchanged", async () => {
    const w = await world();
    await w.post("/api/inbox/settings", { board: { on: true }, steps: { on: true } });
    const before = parseInboxToolList(await rawList(w.base));
    await w.setCodeReview(true);
    const served = parseInboxToolList(await rawList(w.base));
    expect(served.some((tool) => tool.name === "card")).toBe(true);
    for (const build of [inboxAgentTool, modAgentTool]) {
      const tool = build(served)!;
      expect(tool.description.length).toBeLessThan(2_048);
      expect(tool.description).toBe(build(before)!.description);
    }
  });
});
