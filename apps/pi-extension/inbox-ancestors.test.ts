/**
 * Pi Inbox replies to a handed-off session (#3539): the successor wakes for its predecessors' replies.
 * The chain walk is pure filesystem (session .jsonl headers + pi-sessions claims), proved here without Pi;
 * the wake lifecycle and the shared send slot are proved with the claim test's fake Pi.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxLeaseFileOf, type InboxAgentConnection } from "./generated/inbox/agent-link.ts";
import { writePiSessionClaim } from "./generated/inbox/pi-session-claim.ts";
import { handedOffAncestorSessionIds, readPiSessionHeader, registerPiInbox } from "./inbox.ts";

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
		const garbage = join(dir, "garbage.jsonl");
		writeFileSync(garbage, "not json\n");
		expect(readPiSessionHeader(garbage)).toBeNull();
		const empty = join(dir, "empty.jsonl");
		writeFileSync(empty, "");
		expect(readPiSessionHeader(empty)).toBeNull();
		const scalar = join(dir, "scalar.jsonl");
		writeFileSync(scalar, "\"just a string\"\n");
		expect(readPiSessionHeader(scalar)).toBeNull();
	});
});

describe("handedOffAncestorSessionIds", () => {
	function setup(): { sessions: string; dataDir: string } {
		const sessions = tempDir("plannotator-pi-sessions-");
		const dataDir = tempDir("plannotator-pi-data-");
		mkdirSync(join(dataDir, "inbox"), { recursive: true });
		return { sessions, dataDir };
	}

	test("no parentSession: no ancestors", () => {
		const { sessions, dataDir } = setup();
		const file = sessionFile(sessions, "new.jsonl", { id: "new" });
		expect(handedOffAncestorSessionIds(file, "new", dataDir)).toEqual([]);
		expect(handedOffAncestorSessionIds(undefined, "new", dataDir)).toEqual([]);
	});

	test("one unclaimed ancestor, then a two-level chain, nearest first", () => {
		const { sessions, dataDir } = setup();
		const grandparent = sessionFile(sessions, "grand.jsonl", { id: "grandparent" });
		const parent = sessionFile(sessions, "parent.jsonl", { id: "parent", parentSession: grandparent });
		const file = sessionFile(sessions, "new.jsonl", { id: "new", parentSession: parent });
		expect(handedOffAncestorSessionIds(file, "new", dataDir)).toEqual(["parent", "grandparent"]);
	});

	test("a live-claimed ancestor stops the walk: that Pi keeps its own replies", () => {
		const { sessions, dataDir } = setup();
		const grandparent = sessionFile(sessions, "grand.jsonl", { id: "grandparent" });
		const parent = sessionFile(sessions, "parent.jsonl", { id: "parent", parentSession: grandparent });
		const file = sessionFile(sessions, "new.jsonl", { id: "new", parentSession: parent });
		writePiSessionClaim(dataDir, { session: "parent", pid: process.ppid, rpc: false, title: "pi", owner: "someone-else" });
		expect(handedOffAncestorSessionIds(file, "new", dataDir)).toEqual([]);
	});

	test("this process's own claim is ignored: it is the session being left", () => {
		const { sessions, dataDir } = setup();
		const parent = sessionFile(sessions, "parent.jsonl", { id: "parent" });
		const file = sessionFile(sessions, "new.jsonl", { id: "new", parentSession: parent });
		writePiSessionClaim(dataDir, { session: "parent", pid: process.pid, rpc: false, title: "pi", owner: "ours" });
		expect(handedOffAncestorSessionIds(file, "new", dataDir)).toEqual(["parent"]);
	});

	test("a stale claim (its pid gone) is removed and the ancestor is walked", () => {
		const { sessions, dataDir } = setup();
		const parent = sessionFile(sessions, "parent.jsonl", { id: "parent" });
		const file = sessionFile(sessions, "new.jsonl", { id: "new", parentSession: parent });
		writePiSessionClaim(dataDir, { session: "parent", pid: 999999, rpc: false, title: "pi", owner: "dead" });
		expect(handedOffAncestorSessionIds(file, "new", dataDir)).toEqual(["parent"]);
		expect(existsSync(join(dataDir, "inbox", "pi-sessions", "parent.999999.json"))).toBe(false);
	});

	test("an unreadable parent file, a parent without an id, and a cycle all stop the walk", () => {
		const { sessions, dataDir } = setup();
		const missing = sessionFile(sessions, "new.jsonl", { id: "new", parentSession: join(sessions, "gone.jsonl") });
		expect(handedOffAncestorSessionIds(missing, "new", dataDir)).toEqual([]);
		const noId = sessionFile(sessions, "noid.jsonl", { title: "no id here" });
		const noIdNew = sessionFile(sessions, "new2.jsonl", { id: "new2", parentSession: noId });
		expect(handedOffAncestorSessionIds(noIdNew, "new2", dataDir)).toEqual([]);
		const a = join(sessions, "a.jsonl");
		const b = join(sessions, "b.jsonl");
		writeFileSync(a, `${JSON.stringify({ id: "a", parentSession: b })}\n`);
		writeFileSync(b, `${JSON.stringify({ id: "b", parentSession: a })}\n`);
		const cyclic = sessionFile(sessions, "new3.jsonl", { id: "new3", parentSession: a });
		expect(handedOffAncestorSessionIds(cyclic, "new3", dataDir)).toEqual(["a", "b"]);
	});
});

/** A stand-in for Pi's ExtensionAPI, modeled on the session-claim test's fake Pi. */
function fakePi(sessionFilePath: string, includeSessionFile = true) {
	const handlers = new Map<string, ((event: unknown, ctx?: unknown) => unknown)[]>();
	let sessionId = "";
	const sent: Array<{ text: string; options?: unknown }> = [];
	const ctx = {
		hasUI: true,
		cwd: "/tmp",
		sessionManager: {
			getSessionId: () => sessionId,
			...(includeSessionFile ? { getSessionFile: () => sessionFilePath } : {}),
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
			sendUserMessage: (text: string, options?: unknown) => {
				sent.push({ text, options });
			},
			getActiveTools: () => [],
			setActiveTools: () => {},
		},
		sent,
		start(id: string) {
			sessionId = id;
			for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
		},
		shutdown() {
			for (const handler of handlers.get("session_shutdown") ?? []) handler({}, ctx);
		},
		input(source: string) {
			for (const handler of handlers.get("input") ?? []) handler({ source }, ctx);
		},
		messageStart(text: string) {
			for (const handler of handlers.get("message_start") ?? []) handler({ message: { role: "user", content: text } }, ctx);
		},
	};
}

type BridgeCall = { path: string; session: string };

/** A stand-in for the Inbox connection: records bridge calls, answers polls from the test's script. */
function fakeConnection(dataDir: string, calls: BridgeCall[], replies: (session: string) => Array<{ type: string; id: string; thread_id: string; body: string }>) {
	return {
		dataDir,
		host: "pi",
		tools: [{ name: "send_message", description: "Send a message", inputSchema: { type: "object", properties: {} } }],
		async bridge(path: string, session: string) {
			calls.push({ path, session });
			if (path.includes("poll")) return { status: 200, text: JSON.stringify({ commands: replies(session) }) };
			return { status: 200, text: "{}" };
		},
		async callTool() {
			return { text: "", isError: false };
		},
	} as unknown as InboxAgentConnection;
}

describe("the ancestor wakes", () => {
	test("a handed-off session wakes for its predecessor: it polls for the ancestor and stops at shutdown", async () => {
		const sessions = tempDir("plannotator-pi-sessions-");
		const dataDir = tempDir("plannotator-pi-data-");
		mkdirSync(join(dataDir, "inbox"), { recursive: true });
		const parent = sessionFile(sessions, "parent.jsonl", { id: "parent" });
		const file = sessionFile(sessions, "new.jsonl", { id: "new", parentSession: parent });
		const calls: BridgeCall[] = [];
		const pi = fakePi(file);
		registerPiInbox(pi.pi as never, fakeConnection(dataDir, calls, () => []), { isAskActive: () => false, reminder: null });
		pi.start("new");
		// The wakes hold their leases from the start.
		expect(existsSync(inboxLeaseFileOf(dataDir, "pi", "new"))).toBe(true);
		expect(existsSync(inboxLeaseFileOf(dataDir, "pi", "parent"))).toBe(true);
		// The ancestor wake polls for the predecessor's replies.
		await waitFor("the ancestor wake to poll", () => calls.some((call) => call.session === "parent"));
		// A prompt touches every wake: the ancestor's lease stays held by this process.
		const before = JSON.parse(readFileSync(inboxLeaseFileOf(dataDir, "pi", "parent"), "utf8")) as { touchedAt: number };
		await Bun.sleep(10);
		pi.input("user");
		const after = JSON.parse(readFileSync(inboxLeaseFileOf(dataDir, "pi", "parent"), "utf8")) as { touchedAt: number };
		expect(after.touchedAt).toBeGreaterThanOrEqual(before.touchedAt);
		expect(after.touchedAt).toBeGreaterThan(0);
		// Shutdown disposes the ancestor wake: its lease is released and it polls no more.
		const polledBefore = calls.filter((call) => call.session === "parent").length;
		pi.shutdown();
		expect((JSON.parse(readFileSync(inboxLeaseFileOf(dataDir, "pi", "parent"), "utf8")) as { owner: unknown }).owner).toBeNull();
		await Bun.sleep(2500);
		expect(calls.filter((call) => call.session === "parent").length).toBe(polledBefore);
	});

	test("with no parentSession there is no ancestor wake", async () => {
		const sessions = tempDir("plannotator-pi-sessions-");
		const dataDir = tempDir("plannotator-pi-data-");
		mkdirSync(join(dataDir, "inbox"), { recursive: true });
		const file = sessionFile(sessions, "new.jsonl", { id: "new" });
		const calls: BridgeCall[] = [];
		const pi = fakePi(file);
		registerPiInbox(pi.pi as never, fakeConnection(dataDir, calls, () => []), { isAskActive: () => false, reminder: null });
		pi.start("new");
		expect(existsSync(inboxLeaseFileOf(dataDir, "pi", "new"))).toBe(true);
		await Bun.sleep(2500);
		expect(calls.some((call) => call.session !== "new")).toBe(false);
		pi.shutdown();
	});

	test("without getSessionFile the session still starts: no ancestor wake, no crash", async () => {
		const dataDir = tempDir("plannotator-pi-data-");
		mkdirSync(join(dataDir, "inbox"), { recursive: true });
		const calls: BridgeCall[] = [];
		const pi = fakePi("", false);
		registerPiInbox(pi.pi as never, fakeConnection(dataDir, calls, () => []), { isAskActive: () => false, reminder: null });
		expect(() => pi.start("new")).not.toThrow();
		expect(existsSync(inboxLeaseFileOf(dataDir, "pi", "new"))).toBe(true);
		await Bun.sleep(2500);
		expect(calls.some((call) => call.session !== "new")).toBe(false);
		pi.shutdown();
	});

	test("two replies at once serialize: the second send starts only after the first settles", async () => {
		const sessions = tempDir("plannotator-pi-sessions-");
		const dataDir = tempDir("plannotator-pi-data-");
		mkdirSync(join(dataDir, "inbox"), { recursive: true });
		const parent = sessionFile(sessions, "parent.jsonl", { id: "parent" });
		const file = sessionFile(sessions, "new.jsonl", { id: "new", parentSession: parent });
		const calls: BridgeCall[] = [];
		const pi = fakePi(file);
		registerPiInbox(
			pi.pi as never,
			fakeConnection(dataDir, calls, (session) => [
				{ type: "reply", id: `msg-${session}`, thread_id: `t-${session}`, body: `answer for ${session}` },
			]),
			{ isAskActive: () => false, reminder: null },
		);
		pi.start("new");
		// Both wakes deliver, but the shared slot lets only one send start: the second waits.
		await waitFor("the first send to start", () => pi.sent.length >= 1);
		expect(pi.sent.length).toBe(1);
		const first = pi.sent[0]!.text;
		// The first message has not started yet, so the second send cannot have started.
		await Bun.sleep(1500);
		expect(pi.sent.length).toBe(1);
		// Once Pi starts the first message, the queued send starts.
		pi.messageStart(first);
		await waitFor("the second send to start", () => pi.sent.length >= 2);
		const second = pi.sent[1]!.text;
		expect(second).not.toBe(first);
		pi.messageStart(second);
		// Both deliveries settle: the Inbox hears both delivered.
		await waitFor(
			"both replies to be acknowledged",
			() => calls.filter((call) => call.path.includes("event")).length >= 2,
			20_000,
		);
		pi.shutdown();
	});
});
