/**
 * The Pi connection to the Plannotator Inbox, proved on the REAL Pi: the
 * installed `@earendil-works/pi-coding-agent` CLI in RPC mode, driven by Pi's
 * own `RpcClient`, loading this extension from source with `-e`, against a
 * real Inbox (`plannotator inbox --background` under a temp data dir; the
 * compiled binary when PLANNOTATOR_INBOX_TEST_BINARY names one). The model is
 * a scripted OpenAI-compatible endpoint (tests/helpers/scripted-model.ts): Pi
 * sends it exactly what it would send a provider, so the proofs read the tool
 * list and the wake turn from those requests. The person's Send goes through
 * the window's route. No mocks of Pi, the extension or the Inbox.
 *
 * PI_TEST_OLD_CLI=<path to dist/cli.js of Pi 0.79.1> adds the floor: a Pi
 * without `agent_settled` still settles and delivers once.
 * INBOX_PROOF_DIR=<dir> keeps a transcript per proof under <dir>/pi/.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { INBOX_WAKE_INSTRUCTION, inboxWakeText } from "./generated/inbox/connection.ts";
import { INBOX_INSTALL_TEXT } from "./generated/inbox/agent-link.ts";
import {
	createInboxWorld,
	destroyInboxWorld,
	gate,
	listedThreads,
	personSends,
	QUESTION,
	registry,
	startInbox,
	stopInbox,
	stubBuiltHtml,
	SUBJECT,
	thread,
	waitFor,
	worldEnv,
	type InboxWorld,
} from "../../tests/helpers/inbox-world.ts";
import { lastMessage, messageText, startScriptedModel, type ScriptedModel, type ScriptedRequest, type ScriptedTurn } from "../../tests/helpers/scripted-model.ts";

const piPackage = join(import.meta.dir, "node_modules", "@earendil-works", "pi-coding-agent");
/** Pi runs on Node 22.19+ (its engines field); where no such node is on PATH there is no Pi to prove against. The world's `plannotator` wrapper is a /bin/sh script. */
const nodeVersion = /^v(\d+)\.(\d+)/.exec(Bun.which("node") ? Bun.spawnSync(["node", "--version"]).stdout.toString() : "");
const piRuns = process.platform !== "win32" && !!nodeVersion && (Number(nodeVersion[1]) > 22 || (Number(nodeVersion[1]) === 22 && Number(nodeVersion[2]) >= 19));
const piCli = join(piPackage, "dist", "cli.js");
const extension = join(import.meta.dir, "index.ts");

type RpcEvent = { type: string; message?: { role?: string; content?: unknown; stopReason?: string }; [key: string]: unknown };
interface RpcClientLike {
	start(): Promise<void>;
	stop(): Promise<void>;
	onEvent(listener: (event: RpcEvent) => void): () => void;
	prompt(message: string): Promise<void>;
	steer(message: string): Promise<void>;
	getState(): Promise<{ sessionId: string; sessionFile?: string; isStreaming: boolean; pendingMessageCount: number }>;
}

let RpcClient: new (options: Record<string, unknown>) => RpcClientLike;
let stubs: string[] = [];
const worlds: InboxWorld[] = [];
const models: ScriptedModel[] = [];
const pis: RpcClientLike[] = [];

beforeAll(async () => {
	stubs = stubBuiltHtml();
	({ RpcClient } = (await import(pathToFileURL(join(piPackage, "dist", "modes", "rpc", "rpc-client.js")).href)) as never);
});
afterAll(() => {
	const { rmSync } = require("node:fs") as typeof import("node:fs");
	for (const path of stubs) rmSync(path, { force: true });
});
afterEach(async () => {
	for (const pi of pis.splice(0)) await pi.stop().catch(() => undefined);
	for (const model of models.splice(0)) model.stop();
	for (const w of worlds.splice(0)) destroyInboxWorld(w);
});

function world(name: string): InboxWorld {
	const w = createInboxWorld("plannotator-inbox-pi-", name, "pi");
	worlds.push(w);
	return w;
}

/** The person's `inboxTool` switch for Pi, in the data dir's config.json (what the Inbox's Settings writes). */
function knob(w: InboxWorld, on: boolean): void {
	mkdirSync(w.dataDir, { recursive: true });
	writeFileSync(join(w.dataDir, "config.json"), JSON.stringify({ inboxTool: { pi: on } }));
}

function model(script: (request: ScriptedRequest) => ScriptedTurn): ScriptedModel {
	const m = startScriptedModel(script);
	models.push(m);
	return m;
}

interface PiSession {
	client: RpcClientLike;
	events: RpcEvent[];
	sessionId: string;
	sessionFile?: string;
}

async function openPi(w: InboxWorld, m: ScriptedModel, options: { cli?: string; session?: string; env?: Record<string, string> } = {}): Promise<PiSession> {
	const agentDir = join(w.root, "pi-agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				scripted: {
					baseUrl: m.baseUrl,
					api: "openai-completions",
					apiKey: "scripted",
					compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
					models: [{ id: "scripted", name: "Scripted", reasoning: false, contextWindow: 200_000, maxTokens: 8_192 }],
				},
			},
		}),
	);
	const client = new RpcClient({
		cliPath: options.cli ?? piCli,
		cwd: w.project,
		provider: "scripted",
		model: "scripted",
		env: { ...worldEnv(w), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", ...options.env },
		args: [
			"--no-extensions",
			"-e",
			extension,
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--session-dir",
			join(w.root, "pi-sessions"),
			...(options.session ? ["--session", options.session] : []),
		],
	});
	const events: RpcEvent[] = [];
	client.onEvent((event) => events.push(event));
	await client.start();
	pis.push(client);
	const state = await client.getState();
	return { client, events, sessionId: state.sessionId, sessionFile: state.sessionFile };
}

/** Pi finished what it was doing: the run ended, nothing is streaming or queued. Works on Pi without `agent_settled`. */
async function settled(pi: PiSession, from: number): Promise<void> {
	await waitFor("the run to end", () => pi.events.slice(from).some((event) => event.type === "agent_end"), 60_000);
	await waitFor("Pi to be idle", async () => {
		const state = await pi.client.getState();
		return !state.isStreaming && state.pendingMessageCount === 0;
	}, 60_000);
}

/** The person types a prompt at idle and Pi finishes the run it starts. */
async function ask(pi: PiSession, text: string): Promise<void> {
	const from = pi.events.length;
	await pi.client.prompt(text);
	await settled(pi, from);
}

/** User messages Pi started in the session whose first line is an Inbox wake. */
function wakes(pi: PiSession): string[] {
	return pi.events
		.filter((event) => event.type === "message_start" && event.message?.role === "user")
		.map((event) => messageText(event.message?.content))
		.filter((text) => text.startsWith("Plannotator Inbox: "));
}

/** The script every proof shares: a prompt that says "ask" sends the question; a wake is answered in its thread. */
function askingScript(extra: (request: ScriptedRequest) => ScriptedTurn | null = () => null) {
	return (request: ScriptedRequest): ScriptedTurn => {
		const own = extra(request);
		if (own) return own;
		const last = lastMessage(request);
		if (last.role === "tool") return { text: "Done." };
		if (last.text.includes("Ask the person")) {
			return { toolCall: { name: "plannotator_inbox", arguments: { action: "send_message", body: QUESTION } } };
		}
		const wake = /^Plannotator Inbox: .* \((msg_[^)]+)\)$/m.exec(last.text.split("\n", 1)[0] ?? "");
		if (wake) {
			return { toolCall: { name: "plannotator_inbox", arguments: { action: "send_message", body: "Done: retries reuse the key.", reply_to: wake[1] } } };
		}
		return { text: "OK." };
	};
}

/** The structured answer of the tool's send_message, as the model got it back. */
function sentFrom(m: ScriptedModel): { message_id: string; thread_id: string } {
	const result = m.requests.map((request) => lastMessage(request)).find((last) => last.role === "tool" && last.text.includes('"message_id"'));
	if (!result) throw new Error("no send_message result reached the model");
	return JSON.parse(result.text.slice(result.text.indexOf("{")));
}

describe.skipIf(!piRuns)("Pi ↔ Plannotator Inbox (the real Pi in RPC mode, a real Inbox)", () => {
	test("silent without a registry; no tool with the switch off; with both, the tool carries what the Inbox's /mcp offers", async () => {
		const w = world("01-registry-switch-and-tool-list");
		const m = model(askingScript());

		knob(w, true);
		const silent = await openPi(w, m);
		await ask(silent, "hello");
		expect(m.requests.at(-1)?.tools).not.toContain("plannotator_inbox");
		expect(existsSync(join(w.dataDir, "inbox"))).toBe(false);
		expect(silent.events.filter((event) => event.type === "extension_ui_request" && event.method === "notify")).toEqual([]);
		w.proof(`switch on, no inbox/inbox.json: tools sent to the model = ${JSON.stringify(m.requests.at(-1)?.tools)}; no inbox folder, no notice`);
		await silent.client.stop();

		startInbox(w);
		knob(w, false);
		const off = await openPi(w, m);
		await ask(off, "hello");
		expect(m.requests.at(-1)?.tools).not.toContain("plannotator_inbox");
		w.proof(`Inbox running, switch off for pi: tools sent = ${JSON.stringify(m.requests.at(-1)?.tools)}`);
		await off.client.stop();

		knob(w, true);
		const on = await openPi(w, m);
		await ask(on, "hello");
		const sent = m.requests.at(-1)!;
		expect(sent.tools).toContain("plannotator_inbox");
		const tool = sent.toolDefinitions.find((definition) => definition.name === "plannotator_inbox")!;
		const listed = await fetch(`http://127.0.0.1:${registry(w).port}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		});
		const text = await listed.text();
		const offered = (JSON.parse(text.includes("data:") ? text.split("data:")[1]!.split("\n")[0]! : text) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
		const actions = (tool.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum;
		expect(actions.length).toBeGreaterThan(0);
		for (const action of actions) expect(offered).toContain(action);
		const properties = Object.keys((tool.parameters as { properties: object }).properties);
		for (const filled of ["project_path", "agent_session", "agent_host", "agent_name"]) expect(properties).not.toContain(filled);
		w.proof(`Inbox running, switch on for pi: plannotator_inbox sent to the model with actions ${JSON.stringify(actions)}\n\n${tool.description}`);
	}, 120_000);

	test("the person's Send wakes the asking Pi session once, as a follow-up: the stable header, the fixed line, the reply verbatim; Delivered to Pi; the answer lands in the same thread", async () => {
		const w = world("02-send-wakes-the-session");
		knob(w, true);
		startInbox(w);
		// The wake's turn is held until the thread's "Delivered" is read, then answers in the thread.
		const wakeTurn = gate();
		const m = model(
			askingScript((request) => {
				const last = lastMessage(request);
				const wake = /^Plannotator Inbox: .* \((msg_[^)]+)\)$/.exec(last.text.split("\n", 1)[0] ?? "");
				if (last.role !== "user" || !wake) return null;
				return {
					toolCall: { name: "plannotator_inbox", arguments: { action: "send_message", body: "Done: retries reuse the key.", reply_to: wake[1] } },
					hold: wakeTurn.promise,
				};
			}),
		);
		const pi = await openPi(w, m);
		await ask(pi, "Ask the person what to do on a 409.");
		const asked = sentFrom(m);
		const t = await thread(w, asked.thread_id);
		expect(t.project.root).toBe(w.project);
		expect(t.messages[0]?.author).toMatchObject({ kind: "agent", host: "pi", name: "Pi", session: pi.sessionId });
		w.proof(`> plannotator_inbox send_message from Pi session ${pi.sessionId}\nthread ${asked.thread_id}: project ${t.project.root}, author ${JSON.stringify(t.messages[0]?.author)}\n`);

		const words = "Retry with the same key.\n\nAnd log the 409 body so we can see why.";
		const replyId = await personSends(w, asked.message_id, words);
		const wake = await waitFor("the wake turn", () => wakes(pi)[0]);
		const lines = wake.split("\n");
		expect(lines[0]).toBe(`Plannotator Inbox: ${SUBJECT} (${replyId})`);
		expect(lines[1]).toBe(INBOX_WAKE_INSTRUCTION);
		const reply = (await thread(w, asked.thread_id)).messages.find((message) => message.id === replyId)!;
		expect(wake).toBe(inboxWakeText({ id: replyId, subject: SUBJECT, body: reply.body }));
		expect(wake).toContain(words);
		const wakeRequest = m.requests.find((request) => lastMessage(request).text === wake);
		expect(wakeRequest && lastMessage(wakeRequest).role).toBe("user");
		w.proof(`Pi started the user message (followUp), and the model received it as the last user message:\n${wake}\n`);

		const delivered = await waitFor("the delivery record", async () => (await thread(w, asked.thread_id)).messages.find((message) => message.id === replyId)?.delivery);
		expect(delivered).toMatchObject({ state: "delivered", host: "pi", session: pi.sessionId });
		const row = (await listedThreads(w)).find((r) => r.thread_id === asked.thread_id);
		expect(row?.sent?.checked_at).toBe(delivered.at);
		w.proof(`thread shows: Delivered to Pi, ${delivered.at} (reply.delivery ${JSON.stringify(delivered)})`);
		wakeTurn.release();

		const answered = await waitFor("the answer in the thread", async () => {
			const after = await thread(w, asked.thread_id);
			const last = after.messages.at(-1);
			return last?.author.kind === "agent" && last.id !== asked.message_id ? last : null;
		});
		expect(answered.author.session).toBe(pi.sessionId);
		w.proof(`the wake's answer (send_message with reply_to ${replyId}) landed in thread ${asked.thread_id}: Replied`);
		await Bun.sleep(3_000);
		expect(wakes(pi)).toHaveLength(1);
	}, 120_000);

	test("a typed prompt goes first, and a prompt typed into the wake's turn takes it over: one delivery, no abort", async () => {
		const w = world("03-take-over");
		knob(w, true);
		startInbox(w);
		const personTurn = gate();
		const wakeTurn = gate();
		const m = model(
			askingScript((request) => {
				const last = lastMessage(request);
				if (last.role === "user" && last.text === "Refactor the webhook handler.") return { text: "Refactoring.", hold: personTurn.promise };
				if (last.role === "user" && last.text.startsWith("Plannotator Inbox: ")) return { text: "Reading your reply.", hold: wakeTurn.promise };
				return null;
			}),
		);
		const pi = await openPi(w, m);
		await ask(pi, "Ask the person what to do on a 409.");
		const asked = sentFrom(m);

		await pi.client.prompt("Refactor the webhook handler.");
		const replyId = await personSends(w, asked.message_id, "Fail the job and alert.");
		await Bun.sleep(4_000);
		expect(wakes(pi)).toEqual([]);
		w.proof("the person's turn runs (model held): the reply waits in the extension, 0 wakes after 4 s");
		personTurn.release();

		await waitFor("the wake turn", () => wakes(pi)[0]);
		await waitFor("the wake turn's model request", () => m.requests.some((request) => lastMessage(request).text.startsWith("Plannotator Inbox: ")));
		await pi.client.steer("Actually, hold off on that.");
		await Bun.sleep(1_000);
		const beforeRelease = pi.events.length;
		wakeTurn.release();
		await settled(pi, beforeRelease);
		await Bun.sleep(3_000);
		expect(wakes(pi)).toHaveLength(1);
		const aborted = pi.events.filter((event) => event.type === "message_end" && event.message?.stopReason === "aborted");
		expect(aborted).toEqual([]);
		const steered = m.requests.some((request) => request.messages.some((message) => message.role === "user" && messageText(message.content) === "Actually, hold off on that."));
		expect(steered).toBe(true);
		const delivered = (await thread(w, asked.thread_id)).messages.find((message) => message.id === replyId)?.delivery;
		expect(delivered?.state).toBe("delivered");
		w.proof(`the wake turn was taken over by a typed prompt (steer reached the model): 1 wake, 0 aborts, delivered once at ${delivered?.at}`);
	}, 120_000);

	test("two Pi processes on one session deliver a reply exactly once", async () => {
		const w = world("04-two-processes-once");
		knob(w, true);
		startInbox(w);
		const m = model(askingScript());
		const first = await openPi(w, m);
		await ask(first, "Ask the person what to do on a 409.");
		const asked = sentFrom(m);
		const second = await openPi(w, m, { session: first.sessionFile });
		expect(second.sessionId).toBe(first.sessionId);

		const replyId = await personSends(w, asked.message_id, "Retry with the same key.");
		await waitFor("a wake in either process", () => wakes(first).length + wakes(second).length > 0);
		await Bun.sleep(5_000);
		expect(wakes(first).length + wakes(second).length).toBe(1);
		expect(readdirSync(join(w.dataDir, "inbox", "claims"))).toEqual([replyId]);
		const delivered = (await thread(w, asked.thread_id)).messages.find((message) => message.id === replyId)?.delivery;
		expect(delivered?.session).toBe(first.sessionId);
		w.proof(`two Pi processes on session ${first.sessionId}: wakes ${wakes(first).length} + ${wakes(second).length} = 1, one claim (${replyId}), delivered at ${delivered?.at}`);
	}, 120_000);

	test("two Pi processes on one session: the reply goes to the one the person works in, once, and follows them back to the other", async () => {
		const w = world("04b-two-processes-follow-the-person");
		knob(w, true);
		startInbox(w);
		const personTurn = gate();
		const m = model(
			askingScript((request) => {
				const last = lastMessage(request);
				if (last.role === "user" && last.text === "Refactor the webhook handler.") return { text: "Refactoring.", hold: personTurn.promise };
				return null;
			}),
		);
		const a = await openPi(w, m);
		await ask(a, "Ask the person what to do on a 409.");
		const asked = sentFrom(m);
		const b = await openPi(w, m, { session: a.sessionFile });
		expect(b.sessionId).toBe(a.sessionId);

		// The person works in B (its turn held at the model); A sits idle.
		const bFrom = b.events.length;
		await b.client.prompt("Refactor the webhook handler.");
		await waitFor("B's turn at the model", () => m.requests.some((request) => lastMessage(request).text === "Refactor the webhook handler."));
		const replyId = await personSends(w, asked.message_id, "Retry with the same key.");
		await Bun.sleep(8_000);
		expect(wakes(a)).toEqual([]);
		expect(wakes(b)).toEqual([]);
		w.proof(`session ${a.sessionId} open in A and B; the person works in B (turn held), A idle: 8 s after Send, wakes in A 0, in B 0`);
		personTurn.release();
		await settled(b, bFrom);
		await waitFor("the wake in B", () => wakes(b)[0]);
		await Bun.sleep(5_000);
		expect(wakes(a)).toEqual([]);
		expect(wakes(b)).toHaveLength(1);
		expect(readdirSync(join(w.dataDir, "inbox", "claims"))).toEqual([replyId]);
		const delivered = (await thread(w, asked.thread_id)).messages.find((message) => message.id === replyId)?.delivery;
		expect(delivered).toMatchObject({ state: "delivered", host: "pi", session: a.sessionId });
		w.proof(`B's turn ended: the reply was delivered in B, once (wakes A 0, B 1; one claim ${replyId}; delivered at ${delivered?.at})`);

		// The person goes back to A and asks there: the next reply lands in A.
		await ask(a, "Ask the person what to do on a 409.");
		const again = m.requests
			.map((request) => lastMessage(request))
			.filter((last) => last.role === "tool" && last.text.includes('"message_id"'))
			.map((last) => JSON.parse(last.text.slice(last.text.indexOf("{"))) as { message_id: string })
			.at(-1)!;
		const secondReply = await personSends(w, again.message_id, "Fail the job and alert.");
		await waitFor("the second wake in A", () => wakes(a)[0]);
		await Bun.sleep(5_000);
		expect(wakes(a)).toHaveLength(1);
		expect(wakes(a)[0]!.split("\n", 1)[0]).toEndWith(`(${secondReply})`);
		expect(wakes(b)).toHaveLength(1);
		w.proof(`the person asked again in A: the second reply (${secondReply}) was delivered in A, once (wakes A 1, B still 1)`);
	}, 150_000);

	test("a stopped Inbox is started by the call; with no plannotator to start it, the result says to install Plannotator, once", async () => {
		const w = world("05-start-and-missing-binary");
		knob(w, true);
		startInbox(w);
		const m = model(askingScript());
		const pi = await openPi(w, m);
		stopInbox(w);
		const before = registry(w).pid;
		await ask(pi, "Ask the person what to do on a 409.");
		const asked = sentFrom(m);
		expect(registry(w).pid).not.toBe(before);
		expect((await thread(w, asked.thread_id)).messages).toHaveLength(1);
		w.proof(`the Inbox was stopped (pid ${before}); the tool call started it with plannotator inbox --background (pid ${registry(w).pid}) and the message landed`);
		await pi.client.stop();
		stopInbox(w);

		const nodeDir = dirname(Bun.which("node")!);
		const bare = await openPi(w, m, { env: { PATH: `${nodeDir}:/usr/bin:/bin` } });
		await ask(bare, "Ask the person what to do on a 409.");
		await ask(bare, "Ask the person what to do on a 409.");
		const results = m.requests
			.map((request) => lastMessage(request))
			.filter((last) => last.role === "tool")
			.slice(-2)
			.map((last) => last.text);
		expect(results).toHaveLength(2);
		expect(results[0]).toContain(INBOX_INSTALL_TEXT);
		expect(results[1]).not.toContain("install Plannotator");
		expect(results[1]).toContain("not running");
		w.proof(`no plannotator on PATH or in ~/.local/bin:\n  first result: ${results[0]}\n  second result: ${results[1]}`);
	}, 150_000);

	test.skipIf(!process.env.PI_TEST_OLD_CLI)("Pi at the floor (no agent_settled) settles on idle and delivers once", async () => {
		const w = world("06-pi-floor-no-agent-settled");
		knob(w, true);
		startInbox(w);
		const m = model(askingScript());
		const pi = await openPi(w, m, { cli: process.env.PI_TEST_OLD_CLI });
		await ask(pi, "Ask the person what to do on a 409.");
		const asked = sentFrom(m);
		const replyId = await personSends(w, asked.message_id, "Retry with the same key.");
		const wake = await waitFor("the wake turn", () => wakes(pi)[0]);
		expect(wake.split("\n", 1)[0]).toBe(`Plannotator Inbox: ${SUBJECT} (${replyId})`);
		await Bun.sleep(3_000);
		expect(wakes(pi)).toHaveLength(1);
		expect(pi.events.some((event) => event.type === "agent_settled")).toBe(false);
		const delivered = (await thread(w, asked.thread_id)).messages.find((message) => message.id === replyId)?.delivery;
		expect(delivered?.host).toBe("pi");
		w.proof(`Pi ${process.env.PI_TEST_OLD_CLI}: no agent_settled event; 1 wake; delivered at ${delivered?.at}`);
	}, 120_000);
});
