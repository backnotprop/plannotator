/**
 * Plannotator Snapshots on the REAL Pi: the installed
 * `@earendil-works/pi-coding-agent` CLI in RPC mode, driven by Pi's own
 * `RpcClient`, loading this extension from source with `-e`, against a real
 * Snapshots hub that the CLI started (`plannotator snapshot hub --background`
 * under a temp HOME and data dir; the compiled binary when
 * PLANNOTATOR_INBOX_TEST_BINARY names one). The model is a scripted
 * OpenAI-compatible endpoint (tests/helpers/scripted-model.ts), so the proofs
 * read what Pi sent it. The native app never runs: the temp HOME has no
 * ~/Applications app and no build used here embeds one, so the test plays the
 * HUD through the hub API (capture a PNG, Send, Ask), as the app's page would.
 *
 * INBOX_PROOF_DIR=<dir> keeps a transcript per proof under <dir>/pi-snapshots/.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInboxWorld, destroyInboxWorld, stubBuiltHtml, waitFor, worldEnv, type InboxWorld } from "../../tests/helpers/inbox-world.ts";
import { lastMessage, messageText, startScriptedModel, type ScriptedModel, type ScriptedRequest, type ScriptedTurn } from "../../tests/helpers/scripted-model.ts";
import { startCliSnapshotsHub, stopCliSnapshotsHub, type CliSnapshotsHub } from "../../tests/helpers/snapshots-world.ts";

const piPackage = join(import.meta.dir, "node_modules", "@earendil-works", "pi-coding-agent");
/** Pi runs on Node 22.19+; where no such node is on PATH there is no Pi to prove against. The world's `plannotator` wrapper is a /bin/sh script. */
const nodeVersion = /^v(\d+)\.(\d+)/.exec(Bun.which("node") ? Bun.spawnSync(["node", "--version"]).stdout.toString() : "");
const piRuns = process.platform !== "win32" && !!nodeVersion && (Number(nodeVersion[1]) > 22 || (Number(nodeVersion[1]) === 22 && Number(nodeVersion[2]) >= 19));
const piCli = join(piPackage, "dist", "cli.js");
const extension = join(import.meta.dir, "index.ts");

type RpcEvent = { type: string; message?: { role?: string; content?: unknown; customType?: string }; [key: string]: unknown };
interface RpcClientLike {
	start(): Promise<void>;
	stop(): Promise<void>;
	onEvent(listener: (event: RpcEvent) => void): () => void;
	prompt(message: string): Promise<void>;
	getState(): Promise<{ sessionId: string; isStreaming: boolean; pendingMessageCount: number }>;
}

let RpcClient: new (options: Record<string, unknown>) => RpcClientLike;
let stubs: string[] = [];
const worlds: InboxWorld[] = [];
const models: ScriptedModel[] = [];
const pis: RpcClientLike[] = [];

beforeAll(async () => {
	if (!piRuns) return;
	stubs = stubBuiltHtml();
	({ RpcClient } = (await import(pathToFileURL(join(piPackage, "dist", "modes", "rpc", "rpc-client.js")).href)) as never);
});
afterAll(() => {
	for (const path of stubs) rmSync(path, { force: true });
});
afterEach(async () => {
	for (const pi of pis.splice(0)) await pi.stop().catch(() => undefined);
	for (const model of models.splice(0)) model.stop();
	for (const w of worlds.splice(0)) {
		stopCliSnapshotsHub(w);
		destroyInboxWorld(w);
	}
});

function world(name: string): InboxWorld {
	const w = createInboxWorld("plannotator-snapshots-pi-", name, "pi-snapshots");
	worlds.push(w);
	return w;
}

/** The world's environment never points at a native app, and its HOME is the temp one (no ~/Applications app). */
function assertNoNativeApp(w: InboxWorld): void {
	const env = { ...process.env, ...worldEnv(w) };
	expect(env.PLANNOTATOR_SNAPSHOTS_APP ?? "").toBe("");
	expect(env.HOME).toBe(w.home);
	expect(w.home.startsWith(w.root)).toBe(true);
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
}

async function openPi(w: InboxWorld, m: ScriptedModel): Promise<PiSession> {
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
		cliPath: piCli,
		cwd: w.project,
		provider: "scripted",
		model: "scripted",
		// The env var unset in the world: Snapshots is on by default.
		env: { ...worldEnv(w), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PLANNOTATOR_SNAPSHOTS: "", PLANNOTATOR_SNAPSHOTS_APP: "" },
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
		],
	});
	const events: RpcEvent[] = [];
	client.onEvent((event) => events.push(event));
	await client.start();
	pis.push(client);
	const state = await client.getState();
	return { client, events, sessionId: state.sessionId };
}

/** The notifications the extension raised (`ctx.ui.notify` reaches an RPC client as extension_ui_request). */
function notices(pi: PiSession): string[] {
	return pi.events.filter((event) => event.type === "extension_ui_request" && event.method === "notify").map((event) => String(event.message ?? ""));
}

/** The person runs `/plannotator-snapshot`; resolves once the extension answered with its notice. */
async function runSnapshotCommand(w: InboxWorld, pi: PiSession): Promise<string> {
	const before = notices(pi).length;
	await pi.client.prompt("/plannotator-snapshot");
	const notice = await waitFor("the command's notice", () => notices(pi)[before], 60_000);
	w.proof(`> /plannotator-snapshot\n${notice}\n`);
	return notice;
}

async function waitForPiConnection(hub: CliSnapshotsHub, sessionId: string): Promise<void> {
	await hub.waitForState(
		(state) => state.connections.some((c: { host: string; sessionId: string; canAsk?: boolean }) => c.host === "pi" && c.sessionId === sessionId && c.canAsk),
		30_000,
	);
}

/** The note on the whole send, as the HUD's note field sets it (POST the collection with the HUD token). */
async function setSendNote(hub: CliSnapshotsHub, collectionId: string, note: string): Promise<void> {
	const attach = (await (
		await fetch(`${hub.url}/api/snapshots/attach`, { method: "POST", headers: { authorization: `Bearer ${hub.token}`, "content-type": "application/json" }, body: "{}" })
	).json()) as { hudToken: string };
	const response = await fetch(`${hub.url}/api/snapshots/collection/${collectionId}`, {
		method: "POST",
		headers: { authorization: `Bearer ${attach.hudToken}`, "content-type": "application/json" },
		body: JSON.stringify({ note }),
	});
	if (!response.ok) throw new Error(`note: ${response.status}`);
}

const NOTE = "The Save button overlaps the footer on narrow windows.";
const ANSWER = "That is the Save button in the footer.";

/** Text replies only: a Send's turn is acknowledged, an Ask is answered with ANSWER. */
function script(request: ScriptedRequest): ScriptedTurn {
	const last = lastMessage(request);
	if (last.text.includes("What is this button?")) return { text: ANSWER };
	return { text: "Got it." };
}

/** Model requests whose last message is the hub's composed Send. */
function sendRequests(m: ScriptedModel, sendText: string): ScriptedRequest[] {
	return m.requests.filter((request) => {
		const last = lastMessage(request);
		return last.role === "user" && last.text.includes(sendText.trim().split("\n", 1)[0]!) && last.text.includes(NOTE);
	});
}

describe.skipIf(!piRuns)("Pi ↔ Plannotator Snapshots (the real Pi in RPC mode, a hub the CLI started)", () => {
	test("/plannotator-snapshot latches this session; the person's Send arrives exactly once as a turn carrying the image path and the note", async () => {
		const w = world("01-send-arrives-once");
		assertNoNativeApp(w);
		const hub = await startCliSnapshotsHub(w);
		const m = model(script);
		const pi = await openPi(w, m);

		const notice = await runSnapshotCommand(w, pi);
		if (process.platform === "darwin") {
			// The real CLI summoned this session, then found no app in the temp HOME: nothing native ran.
			expect(notice).toContain("not installed");
		} else {
			expect(notice).toContain("plannotator snapshot add");
		}
		// What `plannotator snapshot --session pi:<id>` does on the hub (a no-op repeat on macOS).
		await hub.summon("pi", pi.sessionId);
		await waitForPiConnection(hub, pi.sessionId);

		const { collectionId, snapshotId } = await hub.capture();
		await setSendNote(hub, collectionId, NOTE);
		const sent = await hub.send(collectionId);
		w.proof(`> the person presses Send in the HUD\n${sent.text}\n`);
		expect(sent.text).toContain(NOTE);
		expect(sent.text).toMatch(/Image: \/\S+\.png/);
		const imagePath = /Image: (\/\S+\.png)/.exec(sent.text)![1]!;
		expect(imagePath).toContain(snapshotId);
		expect(imagePath.startsWith(w.dataDir)).toBe(true);

		await hub.waitForState((state) => state.lastSent?.send?.state === "delivered", 60_000);
		await waitFor("the Send's turn to reach the model", () => sendRequests(m, sent.text).length > 0, 60_000);
		await waitFor("Pi to be idle", async () => {
			const state = await pi.client.getState();
			return !state.isStreaming && state.pendingMessageCount === 0;
		}, 60_000);
		// Past the hub's 5 s re-send: still exactly one message in the session and one turn.
		await Bun.sleep(6_000);

		const turns = sendRequests(m, sent.text);
		expect(turns).toHaveLength(1);
		const delivered = lastMessage(turns[0]!).text;
		expect(delivered).toContain(imagePath);
		expect(delivered).toContain(NOTE);
		const started = pi.events.filter((event) => event.type === "message_start" && event.message?.customType === "plannotator-snapshots");
		expect(started).toHaveLength(1);
		expect(messageText(started[0]!.message?.content).trim()).toBe(sent.text.trim());
		expect((await hub.state()).lastSent.send.state).toBe("delivered");
		w.proof(`model requests carrying the Send: ${turns.length}; hub send state: delivered`);
	}, 180_000);

	test("Ask from the HUD runs as a real turn of the Pi session and streams the model's answer back", async () => {
		const w = world("02-ask-is-a-turn");
		assertNoNativeApp(w);
		const hub = await startCliSnapshotsHub(w);
		const m = model(script);
		const pi = await openPi(w, m);
		await runSnapshotCommand(w, pi);
		await hub.summon("pi", pi.sessionId);
		await waitForPiConnection(hub, pi.sessionId);
		await hub.capture();

		const before = m.requests.length;
		const answer = await hub.ask("What is this button?", { host: "pi", sessionId: pi.sessionId });
		w.proof(`> Ask from the HUD: What is this button?\n${answer.text}\n`);
		expect(answer.text).toBe(ANSWER);
		const asked = m.requests.slice(before).filter((request) => lastMessage(request).text.includes("What is this button?"));
		expect(asked).toHaveLength(1);
		expect(lastMessage(asked[0]!).role).toBe("user");
		expect(lastMessage(asked[0]!).text).toContain("Plannotator Snapshots");
		// A turn of this session: Pi started the question as a message and ran the agent on it.
		expect(pi.events.some((event) => event.type === "message_start" && event.message?.customType === "plannotator-ask")).toBe(true);
		expect(pi.events.some((event) => event.type === "agent_end")).toBe(true);
	}, 180_000);
});
