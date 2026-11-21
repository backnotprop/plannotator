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
import { piHandoffLine, readPiSessionHeader, registerPiInbox } from "./inbox.ts";

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

/** A stand-in for Pi's ExtensionAPI: one interactive session whose file the test names. */
function fakePi() {
	const handlers = new Map<string, ((event: unknown, ctx?: unknown) => unknown)[]>();
	let sessionId = "";
	let sessionFilePath: string | undefined;
	const ctx = {
		hasUI: true,
		cwd: "/tmp",
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFilePath,
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
		},
		start(id: string, file?: string) {
			sessionId = id;
			sessionFilePath = file;
			for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
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
	function world() {
		const sessions = tempDir("plannotator-pi-sessions-");
		const dataDir = tempDir("plannotator-pi-data-");
		mkdirSync(join(dataDir, "inbox"), { recursive: true });
		const polls: Poll[] = [];
		const pi = fakePi();
		registerPiInbox(pi.pi as never, fakeConnection(dataDir, polls), { isAskActive: () => false, reminder: null });
		cleanup.push(() => pi.shutdown());
		return { sessions, polls, pi };
	}

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
