/**
 * An agent reads a thread on a linked machine (inbox-far-read.ts, inbox-machine-agent-read.ts, inbox-mcp-far-read.ts):
 * two stores standing for two linked Inboxes, each machine's door answered in process (`agentReadDoorAnswer`,
 * `agentFileDoorAnswer`) behind a stand-in link. What regresses: a far read that reads differently from a local one;
 * a direction that does not work; an older or unreachable machine that hangs the agent or says nothing useful; a far
 * read that writes anything here; a file fetch past its caps, of a dotenv name or of the Inbox's own keys; a door
 * route a phone could reach; a reply into a far thread that pretends to go.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordInboxAttachments } from "@plannotator/shared/inbox/attachments";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { doorRouteOf, doorRouteTable } from "./inbox-devices";
import { agentFileDoorAnswer, agentReadDoorAnswer, AGENT_FILE_NAME_HEADER, AGENT_FILE_SHA_HEADER, FAR_READ_WORDS } from "./inbox-far-read";
import { createMachineAgentRead, FAR_READ_REFUSALS, saveAnswer } from "./inbox-machine-agent-read";
import { openInboxAgentFile } from "./inbox-agent-files";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";
import type { PeerLink } from "./inbox-peer-link";

type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, any> };
type Tool = { handler: (input: Record<string, unknown>, ctx: unknown) => Promise<Result> };

const roots: string[] = [];
let savedDataDir: string | undefined;
let dataDir = "";
beforeAll(() => {
  // The Inbox's own keys are guarded under the data folder: a sandbox one, never the real one.
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-far-read-data-")));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterAll(() => {
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A thread id no machine holds. */
const NOBODY = `msg_${"01JD5N0B0DY".padEnd(26, "0")}`;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** One computer: its store, a project with a file, and its MCP tools. */
function machine(name: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `plannotator-far-read-${name}-`)));
  roots.push(root);
  const projectRoot = join(root, "ledger");
  mkdirSync(projectRoot, { recursive: true });
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "ledger", root: projectRoot });
  const context = {
    store,
    baseUrl: () => `http://localhost:${name === "Studio" ? 1 : 2}/`,
    resolveProject: async () => project,
    recordAttachments: (paths: readonly string[], _project: unknown, base: string) => recordInboxAttachments(store.dir, paths, { base, at: new Date().toISOString() }),
  } as unknown as InboxMcpContext;
  const tools = () => (createInboxMcpServer(context) as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
  return { name, root, projectRoot, store, context, tools };
}
type Machine = ReturnType<typeof machine>;

/** A thread an agent there started, with the person's reply, and a file when asked. */
async function thread(m: Machine, files: string[] = []) {
  for (const file of files) writeFileSync(join(m.projectRoot, file), `bytes of ${file}`);
  const sent = await m.tools().send_message!.handler(
    { project_path: m.projectRoot, agent_session: "ses_builder", agent_host: "claude-code", agent_name: "Builder", subject: "Rate limits", body: "Which limit do we ship?", ...(files.length ? { attachments: files } : {}) },
    {},
  );
  expect(sent.isError).toBeUndefined();
  const id = String(sent.structuredContent!.thread_id);
  m.store.sendReply(id, { words: "The lower one, 100 a minute.", idempotency_key: `reply-${id}` });
  return id;
}

/** A stand-in link to `far`: its door's two agent routes answered in process, its list and state as given. */
function linkTo(far: Machine, options: { id?: string; state?: string; marks?: string[] | null; rows?: string[]; request?: PeerLink["request"] } = {}): PeerLink {
  const door = async (route: string, search: string): Promise<Response> => {
    const url = new URL(`http://door.local/api/inbox/device/${route}${search}`);
    if (route === "agent-read") return agentReadDoorAnswer({ store: far.store, stepsOn: () => false }, url);
    if (route === "agent-file") return agentFileDoorAnswer(far.store, url);
    return Response.json({ error: "Not a door route.", code: "device_route_not_found" }, { status: 404 });
  };
  return {
    id: options.id ?? `ibx_${far.name.toUpperCase().padEnd(26, "0").replace(/[ILOU]/g, "0")}`,
    state: options.state ?? "online",
    list: options.marks === null ? null : { rows: (options.rows ?? []).map((thread_id) => ({ thread_id })), marks: options.marks ?? ["star", "agent-read"] },
    request: options.request ?? ((route: string, search: string) => door(route, search)),
  } as unknown as PeerLink;
}

/** This computer's MCP tools, reading through `peers`. */
function readerTools(here: Machine, peers: PeerLink[], names: Record<string, string>, waitMs?: number) {
  const reader = createMachineAgentRead({ peers: () => peers, nameOf: (id) => names[id] ?? "A linked machine", ...(waitMs ? { waitMs } : {}) });
  here.context.readOnMachine = reader.readThread;
  here.context.farThreadMachine = (id) => {
    const peer = peers.find((p) => p.list?.rows.some((row) => row.thread_id === id));
    return peer ? (names[peer.id] ?? null) : null;
  };
  return { tools: here.tools(), reader };
}

/** Every file under a folder (relative paths), to see that a read wrote nothing. */
function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]));
}

describe("read_thread of a thread on a linked machine", () => {
  test("reads exactly as a local read there, after one line naming the computer, both ways", async () => {
    const studio = machine("Studio");
    const mini = machine("Mini");
    const onMini = await thread(mini);
    const onStudio = await thread(studio);
    const toMini = linkTo(mini, { rows: [onMini] });
    const toStudio = linkTo(studio, { rows: [onStudio] });
    const studioReads = readerTools(studio, [toMini], { [toMini.id]: "Mini" });
    const miniReads = readerTools(mini, [toStudio], { [toStudio.id]: "Studio" });
    for (const [reader, owner, id, name, base] of [
      [studioReads.tools, mini, onMini, "Mini", "http://localhost:1/"],
      [miniReads.tools, studio, onStudio, "Studio", "http://localhost:2/"],
    ] as const) {
      for (const options of [{}, { limit: 1 }, { after: 1 }]) {
        const far = await reader.read_thread!.handler({ thread_id: id, ...options }, {});
        const local = await owner.tools().read_thread!.handler({ thread_id: id, ...options }, {});
        expect(far.isError).toBeUndefined();
        const [head, ...rest] = far.content[0]!.text.split("\n");
        expect(head).toBe(FAR_READ_WORDS.on(name));
        // The same text, with this computer's own link to the thread in place of the owner's.
        expect(rest.join("\n")).toBe(local.content[0]!.text.replace(`${owner.context.baseUrl()}#thread=`, `${base}#thread=`));
        expect(far.structuredContent!.machine.name).toBe(name);
        expect(far.structuredContent!.thread.open_questions).toEqual(local.structuredContent!.thread.open_questions);
      }
    }
  });

  test("a message id alone, an archived thread no list names, expand and format full reach the far machine too", async () => {
    const studio = machine("Studio");
    const mini = machine("Mini");
    const id = await thread(mini);
    const reply = mini.store.thread(id)!.messages.at(-1)!.id;
    // Not in Mini's list (an archived thread): every machine is asked, and the one that holds it answers.
    const { tools } = readerTools(studio, [linkTo(mini)], {});
    const byMessage = await tools.read_thread!.handler({ message_id: reply }, {});
    expect(byMessage.isError).toBeUndefined();
    expect(byMessage.structuredContent!.thread.thread_id).toBe(id);
    const expanded = await tools.read_thread!.handler({ thread_id: id, limit: 1, expand: [mini.store.thread(id)!.messages[0]!.id] }, {});
    expect(expanded.structuredContent!.window.expanded).toBe(1);
    const full = await tools.read_thread!.handler({ thread_id: id, format: "full" }, {});
    expect(full.isError).toBeUndefined();
    expect(full.content[0]!.text.startsWith(FAR_READ_WORDS.on("A linked machine"))).toBe(true);
    expect(full.structuredContent!.thread.messages.length).toBe(2);
    // A refusal there comes back as it is.
    const bad = await tools.read_thread!.handler({ thread_id: id, expand: [NOBODY] }, {});
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("validation_error: expand:");
  });

  test("writes nothing on the reading computer, and marks nothing read on the owner", async () => {
    const studio = machine("Studio");
    const mini = machine("Mini");
    const id = await thread(mini);
    const before = filesUnder(studio.root);
    const ownerBefore = JSON.stringify(mini.store.thread(id));
    const { tools } = readerTools(studio, [linkTo(mini, { rows: [id] })], {});
    expect((await tools.read_thread!.handler({ thread_id: id, agent_session: "ses_reader", agent_host: "claude-code" }, {})).isError).toBeUndefined();
    expect(filesUnder(studio.root)).toEqual(before);
    expect(JSON.stringify(mini.store.thread(id))).toBe(ownerBefore);
  });

  test("an older linked machine is named with what to do; an id nobody holds reads as before", async () => {
    const studio = machine("Studio");
    const mini = machine("Mini");
    const id = await thread(mini);
    const older = linkTo(mini, { rows: [id], marks: ["star"] });
    const { tools } = readerTools(studio, [older], { [older.id]: "Mini" });
    const refused = await tools.read_thread!.handler({ thread_id: id }, {});
    expect(refused.content[0]!.text).toBe(`machine_needs_update: ${FAR_READ_REFUSALS.older("Mini")}`);
    // A door from before the route (its list not read yet): the same words.
    const unknownRoute = linkTo(mini, { rows: [id], request: async () => Response.json({ code: "device_route_not_found", error: "Not a phone route." }, { status: 404 }) });
    const second = readerTools(studio, [unknownRoute], { [unknownRoute.id]: "Mini" });
    expect((await second.tools.read_thread!.handler({ thread_id: id }, {})).content[0]!.text).toBe(`machine_needs_update: ${FAR_READ_REFUSALS.older("Mini")}`);
    // Nobody holds it, and every machine answered: the local refusal, unchanged.
    const none = readerTools(studio, [linkTo(mini)], {});
    expect((await none.tools.read_thread!.handler({ thread_id: NOBODY }, {})).content[0]!.text).toBe(`thread_not_found: No thread ${NOBODY}.`);
  });

  test("an unreachable machine answers at once, or within the bounded wait, and says so", async () => {
    const studio = machine("Studio");
    const mini = machine("Mini");
    const id = await thread(mini);
    const asleep = linkTo(mini, { rows: [id], state: "offline" });
    const { tools } = readerTools(studio, [asleep], { [asleep.id]: "Mini" });
    expect((await tools.read_thread!.handler({ thread_id: id }, {})).content[0]!.text).toBe(`machine_offline: ${FAR_READ_REFUSALS.away("Mini")}`);
    // Online but silent: the wait is bounded, never the agent's whole turn.
    const silent = linkTo(mini, { rows: [id], request: (_route, _search, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))) });
    const slow = readerTools(studio, [silent], { [silent.id]: "Mini" }, 50);
    const started = Date.now();
    expect((await slow.tools.read_thread!.handler({ thread_id: id }, {})).content[0]!.text).toBe(`machine_offline: ${FAR_READ_REFUSALS.away("Mini")}`);
    expect(Date.now() - started).toBeLessThan(2_000);
    // An id no list names, with one machine asleep: not found here, and where it may be.
    const maybe = readerTools(studio, [asleep], { [asleep.id]: "Mini" });
    const text = (await maybe.tools.read_thread!.handler({ thread_id: NOBODY }, {})).content[0]!.text;
    expect(text).toBe(`thread_not_found: ${FAR_READ_REFUSALS.notHere(NOBODY)} ${FAR_READ_REFUSALS.maybeAway("Mini")}`);
  });

  test("a reply into a far thread says plainly it is not available from this computer yet", async () => {
    const studio = machine("Studio");
    const mini = machine("Mini");
    const id = await thread(mini);
    const link = linkTo(mini, { rows: [id] });
    const { tools } = readerTools(studio, [link], { [link.id]: "Mini" });
    const sent = await tools.send_message!.handler({ reply_to: id, body: "On it.", agent_session: "ses_reader", agent_host: "claude-code" }, {});
    expect(sent.isError).toBe(true);
    expect(sent.content[0]!.text).toStartWith("thread_on_other_machine: ");
    expect(sent.content[0]!.text).toContain("replying there is not available from this computer yet");
    expect(studio.store.thread(id)).toBeNull();
  });
});

describe("a far thread's files", () => {
  test("read_thread lists each with the command that saves it here; fetch_file saves the same bytes", async () => {
    const studio = machine("Studio");
    const mini = machine("Mini");
    const id = await thread(mini, ["plan.md"]);
    const link = linkTo(mini, { rows: [id] });
    const { tools, reader } = readerTools(studio, [link], { [link.id]: "Mini" });
    const read = await tools.read_thread!.handler({ thread_id: id }, {});
    const text = read.content[0]!.text;
    expect(text.split("\n")[0]).toBe(`${FAR_READ_WORDS.on("Mini")}${FAR_READ_WORDS.files("Mini")}`);
    const root = mini.store.thread(id)!.messages[0]!;
    const att = root.attachments![0]!;
    expect(text).toContain(`plan.md (markdown, 16 B): ${att.path} (to your machine: `);
    expect(text).toContain(`(to your machine: plannotator inbox call fetch_file '{"message_id":"${root.id}","file":"${att.id}"}')`);
    const folder = join(studio.root, "fetched");
    const saved = await reader.fetchFile({ message_id: root.id, file: att.id }, folder);
    expect(readFileSync(saved.path, "utf8")).toBe("bytes of plan.md");
    expect(saved).toMatchObject({ name: "plan.md", size: 16, sha256: sha(Buffer.from("bytes of plan.md")), machine: link.id });
    // By its name too, as read_thread lists it; a second fetch never overwrites the first.
    expect((await reader.fetchFile({ message_id: root.id, file: "plan.md" }, folder)).path).toBe(join(folder, "plan-2.md"));
  });

  test("refused: a file the message does not have, a message nobody holds, a machine that cannot be asked", async () => {
    const studio = machine("Studio");
    const mini = machine("Mini");
    const id = await thread(mini, ["plan.md"]);
    const root = mini.store.thread(id)!.messages[0]!;
    const link = linkTo(mini, { rows: [id] });
    const { reader } = readerTools(studio, [link], { [link.id]: "Mini" });
    await expect(reader.fetchFile({ message_id: root.id, file: "other.md" }, join(studio.root, "x"))).rejects.toMatchObject({ code: "file_not_found" });
    await expect(reader.fetchFile({ message_id: NOBODY, file: "plan.md" }, null)).rejects.toMatchObject({ code: "message_not_found" });
    const asleep = readerTools(studio, [linkTo(mini, { state: "offline" })], {}).reader;
    await expect(asleep.fetchFile({ message_id: root.id, file: "plan.md" }, null)).rejects.toThrow(FAR_READ_REFUSALS.maybeAway("A linked machine"));
  });

  test("whatever the other machine sends: a dotenv name, past 100 MB, or bytes that do not match leave no file", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-far-file-")));
    roots.push(folder);
    const answer = (body: BodyInit | null, headers: Record<string, string>) => new Response(body, { headers: { "Content-Type": "text/plain", ...headers } });
    await expect(saveAnswer(answer("SECRET=1", { [AGENT_FILE_NAME_HEADER]: ".env.local" }), "m", folder)).rejects.toMatchObject({ code: "attachment_refused" });
    await expect(saveAnswer(answer("x", { [AGENT_FILE_NAME_HEADER]: "big.bin", "Content-Length": String(101 * 1024 * 1024) }), "m", folder)).rejects.toMatchObject({ code: "file_too_large" });
    await expect(saveAnswer(answer("not these bytes", { [AGENT_FILE_NAME_HEADER]: "a.txt", [AGENT_FILE_SHA_HEADER]: sha(Buffer.from("other")) }), "m", folder)).rejects.toMatchObject({ code: "fetch_mismatch" });
    // A name that tries to leave the folder is a plain name in it.
    const saved = await saveAnswer(answer("ok", { [AGENT_FILE_NAME_HEADER]: encodeURIComponent("../../escape.txt"), [AGENT_FILE_SHA_HEADER]: sha(Buffer.from("ok")) }), "m", folder);
    expect(saved.path).toBe(join(folder, ".._.._escape.txt"));
    expect(readdirSync(folder)).toEqual([".._.._escape.txt"]);
  });

  test("the owner never hands out its own keys or a dotenv file, whatever a message's record says", async () => {
    const keys = join(dataDir, "inbox", "relay.json");
    mkdirSync(join(dataDir, "inbox"), { recursive: true });
    writeFileSync(keys, "{}");
    const record = (name: string, path: string) => ({ id: "att_1", name, kind: "text", size: 2, path, sent_sha256: "0".repeat(64) });
    const fake = (attachment: ReturnType<typeof record>) =>
      ({
        dir: join(dataDir, "inbox"),
        message: () => ({ id: "msg_1", thread_id: "msg_1" }),
        agentThread: () => ({ messages: [{ id: "msg_1", author: { kind: "agent" }, body: "", attachments: [attachment] }] }),
      }) as unknown as InboxStore;
    await expect(openInboxAgentFile(fake(record("relay.json", keys)), null, { message_id: "msg_1", file: "att_1" })).rejects.toMatchObject({ code: "attachment_refused" });
    await expect(openInboxAgentFile(fake(record(".env", "/tmp/.env")), null, { message_id: "msg_1", file: "att_1" })).rejects.toMatchObject({ code: "attachment_refused" });
  });
});

describe("the door routes", () => {
  test("only a linked machine's token reaches them: never a phone, and never through the window routes", () => {
    for (const name of ["GET agent-read", "GET agent-file"]) {
      expect(doorRouteTable().find((row) => row.name === name)).toMatchObject({ grant: "machine" });
    }
    expect(doorRouteOf("GET", "agent-read", false)).toBeNull();
    expect(doorRouteOf("GET", "agent-file", false)).toBeNull();
  });
});
