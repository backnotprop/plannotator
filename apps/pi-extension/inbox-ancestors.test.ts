/**
 * Pi Inbox replies to a handed-off session (#3539): the successor's poll says which sessions it continues.
 * The line is read from the session .jsonl headers (`parentSession`), proved here without Pi; the poll's
 * `continues` field is proved with a fake Pi and a fake connection. What the Inbox does with it (the heir
 * is handed what waits for an old id while that id does not poll) is packages/server/inbox-continuations.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAgentConnection } from "./generated/inbox/agent-link.ts";
import { ompContinuesLine, piHandoffLine, readPiSessionHeader, registerPiInbox } from "./inbox.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const undo of cleanup.splice(0)) undo();
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function sessionFile(dir: string, name: string, header: Record<string, unknown>): string {
	const file = join(dir, name);
	writeFileSync(file, `${JSON.stringify(header)}\n{"type":"message"}\n`);
	return file;
}

async function waitFor(label: string, check: () => boolean, timeoutMs = 15_000): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(50);
	}
}

describe("readPiSessionHeader", () => {
	test("reads the id and parentSession from line 1; anything else is null", () => {
		const dir = tempDir("plannotator-pi-header-");
		const file = sessionFile(dir, "s.jsonl", { id: "s", parentSession: "/x/p.jsonl", title: "hi" });
		expect(readPiSessionHeader(file)).toEqual({ id: "s", parentSession: "/x/p.jsonl", title: "hi" });
		expect(readPiSessionHeader(join(dir, "missing.jsonl"))).toBeNull();
		for (const [name, text] of [
			["garbage.jsonl", "not json\n"],
			["empty.jsonl", ""],
			["scalar.jsonl", "\"just a string\"\n"],
			["array.jsonl", "[1,2]\n"],
		] as const) {
			writeFileSync(join(dir, name), text);
			expect(readPiSessionHeader(join(dir, name))).toBeNull();
		}
	});

	test("only line 1 counts: a header longer than one read, a broken rest, a header with no newline", () => {
		const dir = tempDir("plannotator-pi-header-");
		const long = join(dir, "long.jsonl");
		const header = { id: "long", parentSession: "/x/p.jsonl", pad: "x".repeat(10_000) };
		writeFileSync(long, `${JSON.stringify(header)}\n${"{not json".repeat(50_000)}`);
		expect(readPiSessionHeader(long)).toEqual(header);
		const bare = join(dir, "bare.jsonl");
		writeFileSync(bare, JSON.stringify({ id: "bare" }));
		expect(readPiSessionHeader(bare)).toEqual({ id: "bare" });
	});

	test("a first line past the size cap is not read", () => {
		const dir = tempDir("plannotator-pi-header-");
		const huge = join(dir, "huge.jsonl");
		writeFileSync(huge, `${JSON.stringify({ id: "huge", pad: "x".repeat(200_000) })}\n`);
		expect(readPiSessionHeader(huge)).toBeNull();
	});
});

describe("piHandoffLine", () => {
	test("no parentSession, or no session file: no line", () => {
		const sessions = tempDir("plannotator-pi-sessions-");
		const file = sessionFile(sessions, "new.jsonl", { id: "new" });
		expect(piHandoffLine(file, "new")).toEqual([]);
		expect(piHandoffLine(undefined, "new")).toEqual([]);
		expect(piHandoffLine(null, "new")).toEqual([]);
	});

	test("a two-level line, nearest first", () => {
		const sessions = tempDir("plannotator-pi-sessions-");
		const grandparent = sessionFile(sessions, "grand.jsonl", { id: "grandparent" });
		const parent = sessionFile(sessions, "parent.jsonl", { id: "parent", parentSession: grandparent });
		const file = sessionFile(sessions, "new.jsonl", { id: "new", parentSession: parent });
		expect(piHandoffLine(file, "new")).toEqual(["parent", "grandparent"]);
	});

	test("an unreadable parent file, a parent without an id, and a cycle all stop the line", () => {
		const sessions = tempDir("plannotator-pi-sessions-");
		const missing = sessionFile(sessions, "new.jsonl", { id: "new", parentSession: join(sessions, "gone.jsonl") });
		expect(piHandoffLine(missing, "new")).toEqual([]);
		const noId = sessionFile(sessions, "noid.jsonl", { title: "no id here" });
		const noIdNew = sessionFile(sessions, "new2.jsonl", { id: "new2", parentSession: noId });
		expect(piHandoffLine(noIdNew, "new2")).toEqual([]);
		const a = join(sessions, "a.jsonl");
		const b = join(sessions, "b.jsonl");
		writeFileSync(a, `${JSON.stringify({ id: "a", parentSession: b })}\n`);
		writeFileSync(b, `${JSON.stringify({ id: "b", parentSession: a })}\n`);
		const cyclic = sessionFile(sessions, "new3.jsonl", { id: "new3", parentSession: a });
		expect(piHandoffLine(cyclic, "new3")).toEqual(["a", "b"]);
	});

	test("a long line stops at as many as a poll's continues takes", () => {
		const sessions = tempDir("plannotator-pi-sessions-");
		let previous: string | undefined;
		for (let i = 0; i < 12; i++) {
			previous = sessionFile(sessions, `s${i}.jsonl`, previous ? { id: `s${i}`, parentSession: previous } : { id: `s${i}` });
		}
		const file = sessionFile(sessions, "new.jsonl", { id: "new", parentSession: previous });
		expect(piHandoffLine(file, "new")).toEqual(["s11", "s10", "s9", "s8", "s7", "s6", "s5", "s4"]);
	});
});

describe("ompContinuesLine (Oh My Pi's headers name the earlier session by id)", () => {
	const ids = { a: "0190a000-0000-7000-8000-00000000000a", b: "0190a000-0000-7000-8000-00000000000b", c: "0190a000-0000-7000-8000-00000000000c" };
	const named = (dir: string, id: string, header: Record<string, unknown>) => sessionFile(dir, `2026-11-25T00-00-00-000Z_${id}.jsonl`, { type: "session", id, ...header });

	test("a copy after a copy: continuationOf, then parentSession, each found by its id beside the file, nearest first", () => {
		const dir = tempDir("plannotator-omp-sessions-");
		named(dir, ids.a, {});
		named(dir, ids.b, { continuationOf: ids.a, parentSession: ids.a });
		const c = named(dir, ids.c, { parentSession: ids.b });
		expect(ompContinuesLine({ parentSession: ids.b }, c, ids.c)).toEqual([ids.b, ids.a]);
		// Pi's reading of the same header finds nothing: it opens parentSession as a file.
		expect(piHandoffLine(c, ids.c)).toEqual([]);
	});

	test("an earlier file that is gone still names its id; a loop, no header, or a path that is not a file stop the line", () => {
		const dir = tempDir("plannotator-omp-sessions-");
		const b = named(dir, ids.b, { continuationOf: ids.a });
		expect(ompContinuesLine({ continuationOf: ids.a }, b, ids.b)).toEqual([ids.a]);
		expect(ompContinuesLine({ continuationOf: ids.b }, b, ids.b)).toEqual([]);
		expect(ompContinuesLine(null, b, ids.b)).toEqual([]);
		expect(ompContinuesLine({ parentSession: join(dir, "gone.jsonl") }, b, ids.b)).toEqual([]);
		// A branch's parentSession is a file path, as Pi's.
		const a = named(dir, ids.a, {});
		expect(ompContinuesLine({ parentSession: a }, join(dir, "new.jsonl"), ids.c)).toEqual([ids.a]);
	});
});

/** A stand-in for Pi's ExtensionAPI (or Oh My Pi's, `omp`): one interactive session whose file the test names. */
function fakePi(omp = false) {
	const handlers = new Map<string, ((event: unknown, ctx?: unknown) => unknown)[]>();
	let sessionId = "";
	let sessionFilePath: string | undefined;
	let parentSession: string | undefined;
	let header: Record<string, unknown> | undefined;
	let entries: unknown[] = [];
	const ctx = {
		hasUI: true,
		cwd: "/tmp",
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFilePath,
			getHeader: () => header ?? (parentSession ? { parentSession } : undefined),
			getEntries: () => entries,
			getSessionName: () => "test",
			getBranch: () => [],
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify: () => {} },
	};
	return {
		pi: {
			on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
			registerTool: () => {},
			sendUserMessage: () => {},
			getActiveTools: () => [],
			setActiveTools: () => {},
			// What tells Oh My Pi's ExtensionAPI from Pi's (pi-host.ts detectPiHost).
			...(omp ? { arktype: () => {}, pi: {} } : {}),
		},
		start(id: string, file?: string, parent?: string, full?: Record<string, unknown>) {
			sessionId = id;
			sessionFilePath = file;
			parentSession = parent;
			header = full;
			for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
		},
		/** The entries the next session holds (Oh My Pi's `getEntries`). */
		entries(next: unknown[]) {
			entries = next;
		},
		shutdown() {
			for (const handler of handlers.get("session_shutdown") ?? []) handler({}, ctx);
		},
	};
}

type Poll = { session: string; body: Record<string, unknown> };

/** A stand-in for the Inbox connection: records each poll's session and body, hands out nothing. */
function fakeConnection(dataDir: string, polls: Poll[]) {
	const tools = [{ name: "send_message", description: "Send a message", inputSchema: { type: "object", properties: {} } }];
	return {
		dataDir,
		host: "pi",
		tools,
		// The poll path reads connection.options.env (agent-link.ts pendingNow).
		options: { dataDir, host: "pi", agentName: "Pi", tools, env: {} },
		async bridge(path: string, session: string, body: unknown) {
			if (path.includes("poll")) {
				polls.push({ session, body: (body ?? {}) as Record<string, unknown> });
				await Bun.sleep(200);
				return { status: 200, text: JSON.stringify({ commands: [] }) };
			}
			return { status: 200, text: "{}" };
		},
		async callTool() {
			return { text: "", isError: false };
		},
	} as unknown as InboxAgentConnection;
}

describe("the poll's continues", () => {
	function world(omp = false) {
		const sessions = tempDir("plannotator-pi-sessions-");
		const dataDir = tempDir("plannotator-pi-data-");
		mkdirSync(join(dataDir, "inbox"), { recursive: true });
		const polls: Poll[] = [];
		const pi = fakePi(omp);
		registerPiInbox(pi.pi as never, fakeConnection(dataDir, polls), { isAskActive: () => false, reminder: null });
		cleanup.push(() => pi.shutdown());
		return { sessions, polls, pi };
	}

	test("a new session reports its in-memory parent before its file exists", async () => {
		const { sessions, polls, pi } = world();
		const grandparent = sessionFile(sessions, "grand.jsonl", { id: "grandparent" });
		const parent = sessionFile(sessions, "parent.jsonl", { id: "parent", parentSession: grandparent });
		pi.start("new", join(sessions, "not-written.jsonl"), parent);
		await waitFor("the session's poll", () => polls.some((poll) => poll.session === "new"));
		expect(polls.find((poll) => poll.session === "new")?.body.continues).toEqual(["parent", "grandparent"]);
	});

	test("an in-memory parent that points back to the current session is not reported", async () => {
		const { sessions, polls, pi } = world();
		const parent = sessionFile(sessions, "parent.jsonl", { id: "new" });
		pi.start("new", join(sessions, "not-written.jsonl"), parent);
		await waitFor("the session's poll", () => polls.some((poll) => poll.session === "new"));
		expect("continues" in polls[0]!.body).toBe(false);
	});

	test("a handed-off session's poll names the sessions it continues, and nothing polls as the old one", async () => {
		const { sessions, polls, pi } = world();
		const grandparent = sessionFile(sessions, "grand.jsonl", { id: "grandparent" });
		const parent = sessionFile(sessions, "parent.jsonl", { id: "parent", parentSession: grandparent });
		pi.start("parent", parent);
		await waitFor("the old session's poll", () => polls.some((poll) => poll.session === "parent"));
		expect(polls.find((poll) => poll.session === "parent")?.body.continues).toEqual(["grandparent"]);
		// The handoff: the same process starts the new session, whose header names the old file.
		pi.start("new", sessionFile(sessions, "new.jsonl", { id: "new", parentSession: parent }));
		const handedOff = polls.length;
		await waitFor("the new session's poll", () => polls.some((poll) => poll.session === "new"));
		expect(polls.find((poll) => poll.session === "new")?.body.continues).toEqual(["parent", "grandparent"]);
		await Bun.sleep(1500);
		expect(polls.slice(handedOff).every((poll) => poll.session === "new")).toBe(true);
	});

	test("Oh My Pi resumed a newer copy of a conversation: its poll names the old id, so the replies waiting for it come here", async () => {
		const { sessions, polls, pi } = world(true);
		const old = "0190a000-0000-7000-8000-00000000000a";
		const now = "0190a000-0000-7000-8000-00000000000b";
		sessionFile(sessions, `2026-11-25T00-00-00-000Z_${old}.jsonl`, { type: "session", id: old });
		const header = { type: "session", id: now, parentSession: old, continuationOf: old };
		pi.start(now, sessionFile(sessions, `2026-11-25T00-00-01-000Z_${now}.jsonl`, header), undefined, header);
		await waitFor("the session's poll", () => polls.some((poll) => poll.session === now));
		expect(polls.find((poll) => poll.session === now)?.body.continues).toEqual([old]);
	});

	test("Oh My Pi the Inbox started for a new session, opened by Auto Resume on an earlier one: no poll as that one; the new session polls", async () => {
		const before = process.env.PLANNOTATOR_INBOX_NEW_SESSION;
		process.env.PLANNOTATOR_INBOX_NEW_SESSION = "1";
		cleanup.push(() => {
			if (before === undefined) delete process.env.PLANNOTATOR_INBOX_NEW_SESSION;
			else process.env.PLANNOTATOR_INBOX_NEW_SESSION = before;
		});
		const { polls, pi } = world(true);
		// Read once and not passed on to what the session runs.
		expect(process.env.PLANNOTATOR_INBOX_NEW_SESSION).toBeUndefined();
		pi.entries([{ type: "model_change" }, { type: "message", message: { role: "user" } }]);
		pi.start("earlier");
		await Bun.sleep(800);
		expect(polls.some((poll) => poll.session === "earlier")).toBe(false);
		// The Inbox's `new_session`: Oh My Pi switches to a new one.
		pi.entries([{ type: "model_change" }]);
		pi.start("fresh");
		await waitFor("the new session's poll", () => polls.some((poll) => poll.session === "fresh"));
	});

	test("without the Inbox's marker, a session with turns polls at once (a resume, or Oh My Pi started by hand)", async () => {
		const { polls, pi } = world(true);
		pi.entries([{ type: "message", message: { role: "user" } }]);
		pi.start("resumed");
		await waitFor("the session's poll", () => polls.some((poll) => poll.session === "resumed"));
	});

	test("a session that was not handed off sends no continues", async () => {
		const { sessions, polls, pi } = world();
		pi.start("new", sessionFile(sessions, "new.jsonl", { id: "new" }));
		await waitFor("the session's poll", () => polls.some((poll) => poll.session === "new"));
		expect("continues" in polls[0]!.body).toBe(false);
	});

	test("without a session file the session still starts and polls, with no continues", async () => {
		const { polls, pi } = world();
		expect(() => pi.start("new")).not.toThrow();
		await waitFor("the session's poll", () => polls.some((poll) => poll.session === "new"));
		expect("continues" in polls[0]!.body).toBe(false);
	});
});
