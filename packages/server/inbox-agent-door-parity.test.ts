/**
 * A paired cloud agent can do what a local agent can, with the same tool call and the same checks (the owner,
 * 2026-11-21: "Whatever I can do locally, I should be able to do from a cloud instance"), through the agent door
 * (inbox-agent-door.ts) on a store, with no Inbox running and no server: the door's own handler, a stub device and
 * pairing. The failures these guard: a cloud agent's project_path, attachment path, body picture path, localhost
 * prototype, routine files or walkthrough refused, or handled by a rule a local agent does not get; a picture it sent
 * as bytes shown from a file of the same name on the person's disk; a place on the person's computer left out of what
 * it reads; a card call aimed at the agent's own place instead of the card's project; a repository's git address not
 * finding its project (or making a new one); a command's window route not reached, or reached beyond its routes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxGitRemoteKey } from "@plannotator/core/inbox-git-url";
import { INBOX_CARD_ACTION_ON, type InboxProject } from "@plannotator/core/inbox-types";
import { recordInboxAttachments } from "@plannotator/shared/inbox/attachments";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { encodeInboxAgentPairing } from "@plannotator/shared/inbox/agent-pairing";
import { runInboxCallCommand } from "../../apps/hook/server/inbox-call-command";
import { createInboxAgentDoor } from "./inbox-agent-door";
import { inboxMessageImageRoute } from "./inbox-message-images";
import type { InboxCloudAgent, InboxCloudAgents } from "./inbox-cloud-agents";
import type { InboxMcpContext } from "./inbox-mcp";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const PATCH = "diff --git a/src/pay.ts b/src/pay.ts\n--- a/src/pay.ts\n+++ b/src/pay.ts\n@@ -1,2 +1,2 @@\n-export const pay = 0;\n+export const pay = 1;\n export const refund = 2;\n";
const guideWith = (intent: string) => ({ title: "Pay", intent, sections: [{ title: "Pay", overview: "The constant.", diffs: [{ file: "src/pay.ts", summary: "Pay is one." }] }] });
const TOKEN = `tok_${"A".repeat(43)}`;
type Result = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, any> };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world(mcp: Partial<InboxMcpContext> = {}, route?: (req: Request) => Promise<Response>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-door-parity-")));
  roots.push(root);
  const store = InboxStore.open(join(root, "data"));
  const ledgerRoot = join(root, "ledger");
  mkdirSync(join(ledgerRoot, "src"), { recursive: true });
  writeFileSync(join(ledgerRoot, "src", "pay.ts"), "export const pay = 1;\nexport const refund = 2;\n");
  writeFileSync(join(ledgerRoot, "secret.png"), PNG);
  const ledger = store.ensureProject({ name: "ledger", root: ledgerRoot });
  const agent: InboxCloudAgent = { session: "cloud.0123456789ab", name: "Fixer", preset: "other", url: null, key: null, project_id: null, created_at: "2026-11-21T00:00:00.000Z", key_set_at: null, key_rejected_at: null, device_id: "dev_1" };
  const place = join(store.dir, "cloud-agents", agent.session, "Fixer");
  mkdirSync(place, { recursive: true });
  const agents = {
    byDevice: (id: string) => (id === "dev_1" ? agent : null),
    homeRoot: () => place,
    home: () => store.ensureProject({ name: "Fixer", root: place }),
    homeName: () => "Fixer",
    seen: () => {},
  } as unknown as InboxCloudAgents;
  const device = { id: "dev_1", revoked_at: null };
  const devices = { byToken: (token: string) => (token === TOKEN ? device : null), byId: () => device, isOtherDevice: () => false, touch: () => {} };
  const door = createInboxAgentDoor({
    store,
    agents,
    devices: () => devices as never,
    mcp: {
      store,
      baseUrl: () => "http://localhost:1/",
      resolveProject: async (path: string) => store.projectByRoot(path) ?? ledger,
      // The local agent's own rule, as the Inbox's context has it (inbox.ts).
      recordAttachments: (paths: readonly string[], _project: unknown, base: string) => recordInboxAttachments(store.dir, paths, { base, at: new Date().toISOString() }),
      branches: { on: () => false, projectOfRemote: (url: string) => (inboxGitRemoteKey(url) === "github.com/acme/ledger" ? ledger : null) } as never,
      ...mcp,
    } as InboxMcpContext,
    ...(route ? { route } : {}),
  });
  const call = async (tool: string, args: Record<string, unknown>): Promise<Result> => {
    const response = await door.handle(new Request("http://127.0.0.1/api/inbox/agent/call", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ tool, arguments: args }) }));
    return ((await response.json()) as { result: Result }).result;
  };
  const error = (result: Result) => (result.isError ? result.content[0]!.text : null);
  /**
   * `plannotator inbox call` on the cloud agent's own machine (a folder of its own), its paired call answered by this
   * door's own handler: what the command sends is what the door takes.
   */
  const cli = async (argv: string[]) => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-door-parity-cloud-")));
    roots.push(cwd);
    let stdout = "";
    let stderr = "";
    const pairing = encodeInboxAgentPairing({ device_id: "dev_01K7PAIRINGTEST00000000000", token: TOKEN, secret: "B".repeat(43), relay: { url: "https://relay.example", mailbox_id: `mbx_${"C".repeat(22)}` } });
    const run = () =>
      runInboxCallCommand(argv, {
        cwd,
        env: { PLANNOTATOR_PAIRING: pairing },
        ensureRunning: () => Promise.reject(new Error("a paired call looks for no Inbox here")),
        out: (text) => void (stdout += text),
        err: (text) => void (stderr += text),
        pairedTransport: async (tool, body) => {
          const response = await door.handle(new Request("http://127.0.0.1/api/inbox/agent/call", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ tool, arguments: body }) }));
          return { kind: "answer", status: response.status, body: await response.text() };
        },
      });
    return { cwd, run: async () => ({ code: await run(), stdout, stderr }) };
  };
  return { root, store, ledger, agent, place, call, error, cli };
}

describe("a folder and a file on the person's computer, named as a local agent names them", () => {
  test("project_path picks the project for a send and a list; with project too it is one or the other", async () => {
    const w = world();
    const sent = await w.call("send_message", { project_path: w.ledger.root, subject: "Pay", body: "Pay is one now." });
    expect(w.error(sent)).toBeNull();
    expect(w.store.message(sent.structuredContent!.message_id as string)!.project_id).toBe(w.ledger.id);
    const listed = await w.call("read_thread", { project_path: w.ledger.root, asked_by: "anyone" });
    expect(listed.structuredContent!.project.id).toBe(w.ledger.id);
    expect(w.error(await w.call("send_message", { project: "ledger", project_path: w.ledger.root, body: "Both." }))).toStartWith("validation_error:");
  });

  test("an attachment path is read on the person's computer by the local agent's rule, beside files sent as bytes, in the order given", async () => {
    const w = world();
    const sent = await w.call("send_message", { project: "ledger", body: "The code and the notes.", attachments: ["src/pay.ts", { name: "notes.md", data: Buffer.from("# n\n").toString("base64") }, join(w.ledger.root, "secret.png")] });
    expect(w.error(sent)).toBeNull();
    const message = w.store.message(sent.structuredContent!.message_id as string)!;
    expect(message.attachments!.map((a) => a.name)).toEqual(["pay.ts", "notes.md", "secret.png"]);
    expect(readFileSync(message.attachments![0]!.path, "utf8")).toBe("export const pay = 1;\nexport const refund = 2;\n");
    // The refusals a local agent gets, and no other: a .env file, a folder, a file that is not there.
    writeFileSync(join(w.ledger.root, ".env"), "TOKEN=1\n");
    for (const path of [".env", "src", "gone.txt"]) expect([path, w.error(await w.call("send_message", { project: "ledger", body: "No.", attachments: [path] }))?.split(":")[0]]).toEqual([path, "validation_error"]);
    // A refusal names the path by its place in the agent's own list, bytes before it counted.
    const bytes = { name: "a.txt", data: Buffer.from("a").toString("base64") };
    expect(w.error(await w.call("send_message", { project: "ledger", body: "No.", attachments: [bytes, "src/pay.ts", "gone.txt"] }))).toStartWith("validation_error: attachments[2]: ");
  });

  test("a picture the body names by a path is read from the person's disk, a guide's intent too", async () => {
    const w = world();
    const sent = await w.call("send_message", { project: "ledger", body: `See ![scan](${join(w.ledger.root, "secret.png")}) and ![rel](secret.png)` });
    expect(w.error(sent)).toBeNull();
    expect(w.store.message(sent.structuredContent!.message_id as string)!.inline_images!.map((image) => [image.name, image.size])).toEqual([["secret.png", PNG.length], ["secret.png", PNG.length]]);
    const guide = await w.call("submit_guide", { project: "ledger", guide: guideWith("How pay works. ![scan](secret.png)"), patch: PATCH });
    expect(w.error(guide)).toBeNull();
    expect(w.store.message(guide.structuredContent!.message_id as string)!.inline_images!.map((image) => image.name)).toEqual(["secret.png"]);
  });

  test("a running app on the person's computer as a question's prototype is checked there, as for a local agent", async () => {
    const checked: string[] = [];
    const w = world({
      checkPrototypeApps: async (apps) => {
        checked.push(...apps.map((app) => app.target));
        return [];
      },
    });
    const body = [":::question", "Which checkout?", "- [ ] A · Classic", "    Prototype: http://localhost:4000/checkout", "- [ ] B · Total first", ":::"].join("\n");
    expect(w.error(await w.call("send_message", { project: "ledger", body }))).toBeNull();
    expect(checked).toEqual(["http://localhost:4000/checkout"]);
  });
});

describe("pictures a cloud agent sends as bytes", () => {
  test("![alt](name) shows the file attached in the same send, in the body and not again below it", async () => {
    const w = world();
    const sent = await w.call("send_message", { project: "ledger", body: "The chart: ![chart](./chart.png)", attachments: [{ name: "chart.png", data: PNG.toString("base64") }, { name: "notes.md", data: Buffer.from("# n\n").toString("base64") }] });
    expect(w.error(sent)).toBeNull();
    const message = w.store.message(sent.structuredContent!.message_id as string)!;
    expect(message.inline_images!.map((image) => [image.ref, image.name, image.size])).toEqual([["./chart.png", "chart.png", PNG.length]]);
    expect(message.attachments!.map((attachment) => attachment.name)).toEqual(["notes.md"]);
  });

  test("a file that is not a picture, named as one, stays below the message and nothing is refused", async () => {
    const w = world();
    const sent = await w.call("send_message", { project: "ledger", body: "See ![it](notes.md)", attachments: [{ name: "notes.md", data: Buffer.from("# n\n").toString("base64") }] });
    expect(w.error(sent)).toBeNull();
    expect(w.store.message(sent.structuredContent!.message_id as string)!.attachments!.map((a) => a.name)).toEqual(["notes.md"]);
  });

  test("the window shows the bytes it sent, never the project's file of the same name", async () => {
    const w = world();
    const sent = await w.call("send_message", { project: "ledger", body: "![it](secret.png)", attachments: [{ name: "secret.png", data: GIF.toString("base64") }] });
    expect(w.error(sent)).toBeNull();
    const id = sent.structuredContent!.message_id as string;
    const url = new URL(`http://127.0.0.1/api/inbox/messages/${id}/image?path=secret.png`);
    const answer = (await inboxMessageImageRoute(new Request(url), url, w.store))!;
    expect([answer.status, answer.headers.get("content-type")]).toEqual([200, "image/gif"]);
    expect(Buffer.from(await answer.arrayBuffer())).toEqual(GIF);
  });
});

describe("pictures from the cloud agent's own disk, sent by plannotator inbox call", () => {
  test("a guide whose intent shows a picture on the agent's machine arrives with that picture in it", async () => {
    const w = world();
    const machine = await w.cli(["submit_guide", JSON.stringify({ project: "ledger", guide: guideWith("How pay works. ![flow](out/flow.png)"), patch: PATCH })]);
    mkdirSync(join(machine.cwd, "out"));
    writeFileSync(join(machine.cwd, "out", "flow.png"), GIF);
    const done = await machine.run();
    expect([done.code, done.stderr]).toEqual([0, ""]);
    const message = w.store.message(JSON.parse(done.stdout).message_id as string)!;
    expect(message.inline_images!.map((image) => [image.ref, image.name, image.size])).toEqual([["out/flow.png", "flow.png", GIF.length]]);
    expect(message.attachments ?? []).toEqual([]);
    // A path is still no attachment of a guide's.
    expect(w.error(await w.call("submit_guide", { project: "ledger", guide: guideWith("Pay."), patch: PATCH, attachments: ["src/pay.ts"] }))).toStartWith("validation_error: attachments[0]: ");
  });

  test("a refused path is named by its place in the agent's list when a picture before it was sent as bytes, and said to be looked for on the person's computer", async () => {
    const w = world();
    const machine = await w.cli(["send_message", JSON.stringify({ project: "ledger", body: "![](shot.png)", attachments: ["shot.png", { path: "missing.md" }] })]);
    writeFileSync(join(machine.cwd, "shot.png"), PNG);
    const done = await machine.run();
    expect(done.code).toBe(1);
    expect(done.stderr).toStartWith("validation_error: attachments[1]: ");
    expect(done.stderr).toContain("(Looked for on the person's computer: it is no file on this machine, or was given as { \"path\": … }.)");
  });
});

describe("what a cloud agent reads", () => {
  test("its results and reads carry the paths on the person's computer, as a local agent's do", async () => {
    const w = world();
    const sent = await w.call("send_message", { project: "ledger", body: "Notes.", attachments: ["src/pay.ts"] });
    expect(w.error(sent)).toBeNull();
    const path = w.store.message(sent.structuredContent!.message_id as string)!.attachments![0]!.path;
    const full = await w.call("read_thread", { thread_id: sent.structuredContent!.thread_id, format: "full" });
    const windowed = await w.call("read_thread", { thread_id: sent.structuredContent!.thread_id });
    expect(full.structuredContent!.thread.messages[0].attachments[0].path).toBe(path);
    expect(full.structuredContent!.thread.project.root).toBe(w.ledger.root);
    expect(windowed.content[0]!.text).toContain(`(${w.ledger.root})`);
    expect(windowed.content[0]!.text).toContain(path);
  });
});

describe("a repository named by its git address", () => {
  test("finds its project for a new thread and a list, in any form of the address; an address no project has is not found and makes nothing", async () => {
    const w = world();
    for (const address of ["https://github.com/acme/ledger", "git@github.com:acme/ledger.git"]) {
      const sent = await w.call("send_message", { project: address, subject: `Via ${address}`, body: "Hello." });
      expect(w.error(sent)).toBeNull();
      expect(w.store.message(sent.structuredContent!.message_id as string)!.project_id).toBe(w.ledger.id);
    }
    const listed = await w.call("read_thread", { project: "https://github.com/acme/ledger", asked_by: "anyone" });
    expect(listed.structuredContent!.project.id).toBe(w.ledger.id);
    const projects = w.store.listProjects().length;
    expect(w.error(await w.call("send_message", { project: "https://github.com/acme/elsewhere", body: "Hello." }))).toStartWith("project_not_found:");
    expect(w.store.listProjects().length).toBe(projects);
  });
});

describe.if(INBOX_CARD_ACTION_ON)("a cloud agent's cards", () => {
  test("a card_id call uses the card's own project, a create with thread_id the thread's, and list with no project covers every project", async () => {
    const w = world({ boardOn: () => true });
    const local = w.store.sendMessage({ project_id: w.ledger.id, author: { kind: "agent", host: "pi", session: "ses-pi", name: "Pi" }, body: "Ledger work.", subject: "Ledger" }).message;
    const made = await w.call("card", { op: "create", thread_id: local.thread_id, title: "Ledger fix" });
    expect(w.error(made)).toBeNull();
    const cardId = made.structuredContent!.card.id as string;
    expect(w.store.card(cardId)!.project_id).toBe(w.ledger.id);
    // Its own place has a Board once it has a thread there.
    await w.call("send_message", { body: "My own note." });
    const own = await w.call("card", { op: "create", title: "Own work" });
    expect(w.error(own)).toBeNull();
    expect(w.error(await w.call("card", { op: "move", card_id: cardId, column: "in_progress" }))).toBeNull();
    expect(w.store.card(cardId)!.column).toBe("in_progress");
    const listed = await w.call("card", { op: "list" });
    expect((listed.structuredContent!.cards as { id: string }[]).map((card) => card.id).sort()).toEqual([cardId, own.structuredContent!.card.id].sort());
  });
});

describe("routines and walkthroughs", () => {
  test("a routine reaches the routine tool while the person has Routines on, a create with no folder in a new scratch folder; its files go to it as paths, as a local agent's", async () => {
    const created: Record<string, unknown>[] = [];
    const scheduled = {
      list: () => [],
      create: async (input: Record<string, unknown>) => {
        created.push(input);
        throw Object.assign(new Error("stop here"), { code: "validation_error" });
      },
    };
    const off = world();
    expect(off.error(await off.call("routine", { op: "list" }))).toStartWith("tool_not_allowed:");
    const w = world({ scheduledOn: () => true, scheduled: () => scheduled as never });
    expect((await w.call("routine", { op: "list" })).content[0]!.text).toBe("No routines.");
    await w.call("routine", { op: "create", name: "Triage", prompt: "Triage.", agent: "claude-code" });
    expect(created.map((input) => input.folder)).toEqual([{ scratch: true }]);
    await w.call("routine", { op: "create", name: "Triage", prompt: "Triage.", agent: "claude-code", project: "ledger" });
    expect(created.at(-1)!.folder).toEqual({ path: w.ledger.root });
    await w.call("routine", { op: "create", name: "T", prompt: "T.", agent: "claude-code", project_path: w.ledger.root, attachments: [join(w.ledger.root, "src", "pay.ts")] });
    expect([created.at(-1)!.folder, created.at(-1)!.attachments]).toEqual([{ path: w.ledger.root }, [join(w.ledger.root, "src", "pay.ts")]]);
  });

  test("a walkthrough reads the named project's checkout on this computer, by project or project_path; elsewhere it fails as a local agent's does", async () => {
    let walkthroughThread = "";
    const w = world({ codeReviewOn: () => true, walkthroughThread: (id) => id === walkthroughThread });
    const guide = { title: "Pay", intent: "How pay works.", sections: [{ title: "Pay", overview: "The constants.", diffs: [{ file: "src/pay.ts", lines: "1-2", summary: "Both constants." }] }] };
    // In its own place, which holds no checkout: the walkthrough's own refusal, the one a local agent gets for a folder without the file.
    const elsewhere = w.error(await w.call("submit_guide", { guide, walkthrough: true }));
    expect(elsewhere).toStartWith("invalid_guide:");
    expect(elsewhere).toContain("src/pay.ts isn't a file in the project.");
    for (const where of [{ project: "ledger" }, { project_path: w.ledger.root }]) {
      const sent = await w.call("submit_guide", { guide, walkthrough: true, ...where });
      expect(w.error(sent)).toBeNull();
      expect(w.store.message(sent.structuredContent!.message_id as string)!.guide!.walkthrough).toBe(true);
    }
    // A guide sent into a thread the New review box started as a walkthrough is one, as a local agent's is.
    const started = w.store.sendMessage({ project_id: w.ledger.id, author: { kind: "person" }, body: "Walk me through pay.", subject: "Walkthrough" }).message;
    walkthroughThread = started.thread_id;
    const reply = await w.call("submit_guide", { guide, reply_to: started.id });
    expect(w.error(reply)).toBeNull();
    expect(w.store.message(reply.structuredContent!.message_id as string)!.guide!.walkthrough).toBe(true);
  });
});

describe("the window routes a paired agent's commands use", () => {
  test("a command's request reaches the Inbox's own handler; a rows change is the pairing's agent's; no other route is carried", async () => {
    const seen: { method: string; path: string; body: unknown }[] = [];
    const w = world({}, async (req) => {
      const url = new URL(req.url);
      seen.push({ method: req.method, path: `${url.pathname}${url.search}`, body: req.method === "POST" ? await req.json() : null });
      return Response.json({ ok: true });
    });
    const got = await w.call("route", { method: "GET", path: "/api/inbox/projects" });
    expect(w.error(got)).toBeNull();
    expect(got.structuredContent).toMatchObject({ status: 200, body: JSON.stringify({ ok: true }) });
    expect(w.error(await w.call("route", { method: "POST", path: "/api/inbox/settings", body: { rows: ["subject"] } }))).toBeNull();
    expect(seen.at(-1)).toEqual({ method: "POST", path: "/api/inbox/settings", body: { rows: ["subject"], rows_by: { host: "cloud", session: w.agent.session } } });
    const before = seen.length;
    for (const [method, path, body] of [
      ["GET", "/api/inbox/threads", undefined],
      ["POST", "/api/inbox/settings", { board: true }],
      ["POST", "/api/inbox/settings", { rows: [], rows_by: { host: "pi", session: "ses-pi" } }],
      ["DELETE", "/api/inbox/projects", undefined],
    ] as const) {
      expect([path, w.error(await w.call("route", { method, path, ...(body ? { body } : {}) }))?.split(":")[0]]).toEqual([path, "validation_error"]);
    }
    expect(seen.length).toBe(before);
  });
});
