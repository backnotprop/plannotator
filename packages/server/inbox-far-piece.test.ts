/**
 * A paired cloud agent fetches a file of a linked machine's thread (inbox-machine-agent-piece.ts): the person's
 * computer (Studio) serves the agent door's pieces from the other machine's (Mini) `agent-file` door, read there by
 * offset, the door answered in process behind a stand-in link. What regresses: a far file a cloud agent cannot fetch;
 * pieces that re-read the whole file; a file that changed between pieces saved anyway; an older machine that
 * answers the whole file read as a piece; anything written on either computer; a dotenv name saved.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPairedFile } from "../../apps/hook/server/inbox-call-fetch";
import { INBOX_AGENT_FETCH_FILE } from "@plannotator/shared/inbox/agent-pairing";
import { recordInboxAttachments } from "@plannotator/shared/inbox/attachments";
import { FETCHED_FILE_WORDS } from "@plannotator/shared/inbox/saved-file";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { INBOX_AGENT_FETCH_PIECE_BYTES } from "./inbox-agent-files";
import { createInboxAgentDoor } from "./inbox-agent-door";
import type { InboxCloudAgent, InboxCloudAgents } from "./inbox-cloud-agents";
import { AGENT_FILE_OFFSET_HEADER, agentFileDoorAnswer, agentReadDoorAnswer } from "./inbox-far-read";
import { createMachineAgentRead, FAR_READ_REFUSALS } from "./inbox-machine-agent-read";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";
import type { PeerLink } from "./inbox-peer-link";

type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, any> };
type Tool = { handler: (input: Record<string, unknown>, ctx: unknown) => Promise<Result> };

const roots: string[] = [];
let savedDataDir: string | undefined;
let dataDir = "";
beforeAll(() => {
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-far-piece-data-")));
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

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]));
}
const folderHashes = (dir: string) => Object.fromEntries(filesUnder(dir).map((file) => [file, sha(readFileSync(join(dir, file)))]));
const TOKEN = "door-token-0123456789";

function computer(name: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `plannotator-far-piece-${name}-`)));
  roots.push(root);
  const projectRoot = join(root, "ledger");
  mkdirSync(projectRoot, { recursive: true });
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "ledger", root: projectRoot });
  const mcp = {
    store,
    baseUrl: () => "http://localhost:1/",
    resolveProject: async () => project,
    recordAttachments: (paths: readonly string[], _project: unknown, base: string) => recordInboxAttachments(store.dir, paths, { base, at: new Date().toISOString() }),
  } as unknown as InboxMcpContext;
  const tools = () => (createInboxMcpServer(mcp) as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
  return { root, projectRoot, store, project, mcp, tools };
}

/** Mini: a thread whose message attaches a file of 2 pieces and a bit. Studio: a cloud agent's door, linked to Mini. */
async function world(request?: (route: string, search: string, door: (route: string, search: string) => Promise<Response>) => Promise<Response>) {
  const mini = computer("Mini");
  const big = randomBytes(INBOX_AGENT_FETCH_PIECE_BYTES * 2 + 12_345);
  writeFileSync(join(mini.projectRoot, "dump.bin"), big);
  const sent = await mini.tools().send_message!.handler({ project_path: mini.projectRoot, agent_session: "ses_mini", agent_host: "claude-code", agent_name: "Builder", subject: "Dump", body: "The dump.", attachments: ["dump.bin"] }, {});
  const threadId = String(sent.structuredContent!.thread_id);
  const message = mini.store.thread(threadId)!.messages[0]!;
  const door = async (route: string, search: string): Promise<Response> => {
    const url = new URL(`http://door.local/api/inbox/device/${route}${search}`);
    if (route === "agent-read") return agentReadDoorAnswer({ store: mini.store, stepsOn: () => false }, url);
    if (route === "agent-file") return agentFileDoorAnswer(mini.store, url);
    return Response.json({ code: "device_route_not_found", error: "Not a door route." }, { status: 404 });
  };
  const asks: string[] = [];
  const link = {
    id: "ibx_M0N0000000000000000000000",
    state: "online",
    list: { rows: [{ thread_id: threadId }], marks: ["agent-read", "agent-search"] },
    request: async (route: string, search: string) => {
      asks.push(`${route}${search}`);
      return request ? request(route, search, door) : door(route, search);
    },
  } as unknown as PeerLink;
  const studio = computer("Studio");
  const reader = createMachineAgentRead({ peers: () => [link], nameOf: () => "Mini" });
  studio.mcp.readOnMachine = reader.readThread;
  studio.mcp.filePieceOnMachine = reader.filePiece;
  const at = new Date().toISOString();
  const agent = { session: "cloud.0123456789ab", name: "Nightly fixer", preset: "other", url: null, key: null, project_id: null, created_at: at, key_set_at: null, key_rejected_at: null, device_id: "dev_1" } as InboxCloudAgent;
  const agents = { byDevice: (id: string) => (id === "dev_1" ? agent : null), homeRoot: () => join(studio.root, "home"), home: () => studio.project, homeName: () => "Nightly fixer", seen: () => {} } as unknown as InboxCloudAgents;
  const device = { id: "dev_1", revoked_at: null };
  const agentDoor = createInboxAgentDoor({ store: studio.store, agents, mcp: studio.mcp, devices: () => ({ byToken: (t: string) => (t === TOKEN ? device : null), byId: () => device, isOtherDevice: () => false, touch: () => {} }) as never });
  const call = async (tool: string, args: Record<string, unknown>): Promise<Result> => {
    const answer = await agentDoor.handle(new Request("http://127.0.0.1/api/inbox/agent/call", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ tool, arguments: args }) }));
    return ((await answer.json()) as { result: Result }).result;
  };
  // The cloud agent's own computer: neither of the two.
  const cloud = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-far-piece-cloud-")));
  roots.push(cloud);
  const saveIn = join(cloud, "saved");
  const fetchFile = (args: Record<string, unknown>) =>
    fetchPairedFile({ ...args, folder: saveIn }, cloud, async (tool, body) => {
      const result = await call(tool, body);
      if (result.isError) {
        const [, code = "inbox_error", messageText = ""] = /^([a-z_]+): ([\s\S]*)$/.exec(result.content[0]!.text) ?? [];
        return { ok: false, code, message: messageText };
      }
      return { ok: true, structured: result.structuredContent };
    });
  return { mini, studio, big, threadId, message, call, fetchFile, asks, saveIn, cloud };
}

describe("a paired cloud agent fetches a linked machine's file", () => {
  test("in pieces read there by offset: the assembled file has the size and SHA-256 named; nothing is written on either computer", async () => {
    const w = await world();
    const read = await w.call("read_thread", { thread_id: w.threadId });
    const file = (read.structuredContent!.thread.messages as { files?: { file: string; name: string; fetch: string }[] }[]).flatMap((m) => m.files ?? []).find((f) => f.name === "dump.bin")!;
    expect(file.fetch.startsWith("plannotator inbox call fetch_file '")).toBe(true);
    const args = JSON.parse(file.fetch.slice(file.fetch.indexOf("'") + 1, -1)) as Record<string, unknown>;
    const studioBefore = folderHashes(join(w.studio.root, "data"));
    const miniBefore = folderHashes(w.mini.root);
    const saved = await w.fetchFile(args);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.saved).toMatchObject({ name: "dump.bin", size: w.big.length, sha256: sha(w.big) });
    expect(sha(readFileSync(saved.saved.path))).toBe(sha(w.big));
    // Three pieces, each one ranged read there: never the whole file.
    expect(w.asks.filter((a) => a.startsWith("agent-file")).map((a) => new URLSearchParams(a.split("?")[1]).get("offset"))).toEqual(["0", String(INBOX_AGENT_FETCH_PIECE_BYTES), String(INBOX_AGENT_FETCH_PIECE_BYTES * 2)]);
    expect(folderHashes(join(w.studio.root, "data"))).toEqual(studioBefore);
    expect(folderHashes(w.mini.root)).toEqual(miniBefore);
  });

  test("a piece past the end is refused there, in that machine's words", async () => {
    const w = await world();
    const result = await w.call(INBOX_AGENT_FETCH_FILE, { message_id: w.message.id, file: "dump.bin", offset: w.big.length + 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(`validation_error: offset: dump.bin has ${w.big.length} bytes.`);
  });

  test("a file that changed there between pieces is never saved", async () => {
    let n = 0;
    const w = await world(async (route, search, door) => {
      const answer = await door(route, search);
      if (route !== "agent-file" || n++ === 0) return answer;
      const headers = new Headers(answer.headers);
      headers.set("X-Plannotator-File-Sha256", "f".repeat(64));
      return new Response(answer.body, { status: answer.status, headers });
    });
    const saved = await w.fetchFile({ message_id: w.message.id, file: "dump.bin" });
    expect(saved).toMatchObject({ ok: false, code: "fetch_broken" });
    expect(existsSync(w.saveIn) ? readdirSync(w.saveIn) : []).toEqual([]);
  });

  test("an older machine (its door reads the whole file, no offset said) is named with what to do; nothing saved", async () => {
    const w = await world(async (route, search, door) => {
      if (route !== "agent-file") return door(route, search);
      const params = new URLSearchParams(search.slice(1));
      params.delete("offset");
      params.delete("length");
      const whole = await door(route, `?${params}`);
      expect(whole.headers.get(AGENT_FILE_OFFSET_HEADER)).toBeNull();
      return whole;
    });
    const saved = await w.fetchFile({ message_id: w.message.id, file: "dump.bin" });
    expect(saved).toEqual({ ok: false, code: "machine_needs_update", message: FAR_READ_REFUSALS.older("Mini") });
    expect(existsSync(w.saveIn) ? readdirSync(w.saveIn) : []).toEqual([]);
  });

  test("a hostile piece: the right offset header with the whole file, or another offset echoed, is never handed on", async () => {
    const whole = await world(async (route, search, door) => {
      if (route !== "agent-file") return door(route, search);
      const asked = new URLSearchParams(search.slice(1));
      const params = new URLSearchParams(asked);
      params.delete("offset");
      params.delete("length");
      const answer = await door(route, `?${params}`);
      const headers = new Headers(answer.headers);
      headers.set(AGENT_FILE_OFFSET_HEADER, asked.get("offset") ?? "0");
      return new Response(answer.body, { status: answer.status, headers });
    });
    const sent = await whole.call(INBOX_AGENT_FETCH_FILE, { message_id: whole.message.id, file: "dump.bin" });
    expect(sent.isError).toBe(true);
    expect(sent.content[0]!.text).toBe(`machine_answer_unreadable: ${FAR_READ_REFUSALS.fileUnreadable("Mini")}`);
    expect(existsSync(whole.saveIn) ? readdirSync(whole.saveIn) : []).toEqual([]);

    const elsewhere = await world(async (route, search, door) => {
      if (route !== "agent-file") return door(route, search);
      const answer = await door(route, search);
      const headers = new Headers(answer.headers);
      headers.set(AGENT_FILE_OFFSET_HEADER, String(Number(headers.get(AGENT_FILE_OFFSET_HEADER)) + 7));
      return new Response(answer.body, { status: answer.status, headers });
    });
    const moved = await elsewhere.call(INBOX_AGENT_FETCH_FILE, { message_id: elsewhere.message.id, file: "dump.bin", offset: INBOX_AGENT_FETCH_PIECE_BYTES });
    expect(moved.isError).toBe(true);
    expect(moved.content[0]!.text).toBe(`machine_needs_update: ${FAR_READ_REFUSALS.older("Mini")}`);
  });

  test("one cloud agent's far pieces are read a few at a time, the rest waiting their turn", async () => {
    let going = 0;
    let most = 0;
    const w = await world(async (route, search, door) => {
      if (route !== "agent-file") return door(route, search);
      going++;
      most = Math.max(most, going);
      await Bun.sleep(30);
      try {
        return await door(route, search);
      } finally {
        going--;
      }
    });
    const offsets = [0, 1, 2, 0, 1, 2].map((n) => n * INBOX_AGENT_FETCH_PIECE_BYTES);
    const results = await Promise.all(offsets.map((offset) => w.call(INBOX_AGENT_FETCH_FILE, { message_id: w.message.id, file: "dump.bin", offset })));
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(results.map((r) => r.structuredContent!.offset)).toEqual(offsets);
    expect(most).toBe(2);
  });

  test("a dotenv name is never saved, from a far piece or any piece the Inbox names", async () => {
    const w = await world(async (route, search, door) => {
      const answer = await door(route, search);
      if (route !== "agent-file") return answer;
      const headers = new Headers(answer.headers);
      headers.set("X-Plannotator-File-Name", encodeURIComponent(".env"));
      return new Response(answer.body, { status: answer.status, headers });
    });
    expect(await w.fetchFile({ message_id: w.message.id, file: "dump.bin" })).toEqual({ ok: false, code: "attachment_refused", message: FETCHED_FILE_WORDS.dotenv(".env") });
    // The command's own check, whatever the Inbox answers: `.env ` is saved as `.env`.
    const folder = join(w.cloud, "own-check");
    const bad = await fetchPairedFile({ message_id: w.message.id, file: "x", folder }, w.cloud, async () => ({ ok: true, structured: { name: ".env ", size: 3, sha256: sha(Buffer.from("abc")), offset: 0, next_offset: null, data: Buffer.from("abc").toString("base64") } }));
    expect(bad).toMatchObject({ ok: false, code: "attachment_refused" });
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([]);
  });
});
