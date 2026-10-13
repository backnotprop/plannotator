/**
 * The `plannotator` agent tool on Pi (contract: packages/shared/plannotator-tool.ts),
 * and the decision delivery it shares with the /plannotator-* commands.
 *
 * Driven through the real extension with a fake Pi host. Annotate, last and
 * code review sessions run REAL in-process servers (only the browser launch is
 * skipped), so close, unsent counts and decisions go through the servers' own
 * host control and decision endpoints.
 *
 * What regresses if this fails:
 *  - Pi's tool validator refuses the shared plain JSON Schema, so every call fails;
 *  - the tool forks the contract (name, schema, description) instead of using it;
 *  - opening blocks the turn, or opens without the Ask-this-session bridge;
 *  - the reviewer's decision (tool or slash command) never reaches the agent, or
 *    arrives without the `Plannotator: <subject> (pn-…) — <outcome>.` heading;
 *  - a gated session the agent opened swallows a bare approval it was told to wait for;
 *  - the tool's `last` opens the agent's own tool-calling message instead of its answer;
 *  - list/close reach another Pi session's reviews, lose the session's own reviews
 *    after a reload (new extension instance), close deletes the reviewer's draft
 *    or delivers a message, or a plan review can be closed;
 *  - on one fixed port a second open silently stops the open review;
 *  - a list of files, `reply`, or a session without UI opens anything.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import plannotator, { type PlannotatorExtensionDeps } from "./index.ts";
import {
	PLANNOTATOR_OUTCOME_REVIEW_POSTED,
	PLANNOTATOR_TOOL_DESCRIPTION,
	PLANNOTATOR_TOOL_INPUT_SCHEMA,
	PLANNOTATOR_TOOL_NAME,
} from "./generated/plannotator-tool.ts";
import type { PlanReviewDecision } from "./plannotator-browser.ts";
import { getProcessPiReviewRegistry } from "./plannotator-tool-host.ts";
import { startAnnotateServer } from "./server/serverAnnotate.ts";
import { startReviewServer } from "./server/serverReview.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY", "PLANNOTATOR_ANNOTATE_HISTORY", "PLANNOTATOR_AGENT_TOOL"] as const;

const tempDirs: string[] = [];
const servers: Array<{ stop: () => void }> = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	const dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-tool-data-"));
	tempDirs.push(dataDir);
	process.env.PLANNOTATOR_DATA_DIR = dataDir;
	process.env.PLANNOTATOR_AI = "disabled";
	process.env.PLANNOTATOR_REMOTE = "0";
	process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
	process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
	// The tool is off by default on Pi; these tests are about the tool itself.
	process.env.PLANNOTATOR_AGENT_TOOL = "1";
	delete process.env.PLANNOTATOR_PORT;
});

afterEach(() => {
	for (const server of servers.splice(0)) server.stop();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key]!;
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type ToolResult = { content: Array<{ type: string; text: string }>; details?: Record<string, unknown>; terminate?: boolean };
type Tool = { name: string; description: string; parameters: unknown; executionMode?: string; execute: (...args: unknown[]) => Promise<ToolResult> };
type BranchEntry = { id: string; type: string; message?: unknown };

interface Launch {
	kind: "annotate" | "last" | "review";
	text?: string;
	mode?: string;
	bundle?: string[];
	recent?: Array<{ messageId: string; text: string }>;
	gate: boolean | undefined;
	sessionBridge: unknown;
	url: string;
}

/** The registry is process-wide, so every harness gets its own Pi session id unless a test shares one. */
let sessionCounter = 0;
const freshSessionId = () => `pi-session-${process.pid}-${(sessionCounter += 1)}`;

function createHarness(options: { sessionId?: string; hasUI?: boolean; branch?: BranchEntry[]; deps?: PlannotatorExtensionDeps } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "plannotator-pi-tool-"));
	tempDirs.push(cwd);
	const sessionId = options.sessionId ?? freshSessionId();
	const tools = new Map<string, Tool>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const sent: Array<{ text: string; options: unknown }> = [];
	const notices: Array<{ message: string; type: string }> = [];
	const launches: Launch[] = [];
	const planReviews: Array<{ decide: (result: PlanReviewDecision) => void }> = [];

	const pi = {
		events: { on: () => undefined, emit: () => undefined },
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		getFlag: () => false,
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => undefined,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		setModel: async () => true,
		getCommands: () => [],
		appendEntry: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: (text: string, sendOptions: unknown) => sent.push({ text, options: sendOptions }),
	};

	const makeCtx = (id: string) => ({
		cwd,
		hasUI: options.hasUI ?? true,
		mode: "tui",
		isProjectTrusted: () => true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => undefined,
		model: undefined,
		modelRegistry: { find: () => undefined },
		sessionManager: {
			getBranch: () => options.branch ?? [],
			getEntries: () => options.branch ?? [],
			getSessionId: () => id,
			getSessionFile: () => undefined,
			getSessionName: () => undefined,
		},
		ui: {
			notify: (message: string, type = "info") => notices.push({ message, type }),
			setStatus: () => undefined,
			setWidget: () => undefined,
			theme: { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text },
		},
	});
	const ctx = makeCtx(sessionId);

	// Real servers; only the browser launch is skipped.
	const startAnnotation: NonNullable<PlannotatorExtensionDeps["startAnnotation"]> = async (
		_ctx, filePath, markdown, mode, folderPath, _sourceInfo, _converted, gate, _rawHtml, _renderHtml, _convertHtml, _recent, _live, sessionBridge, bundleFiles,
	) => {
		const server = await startAnnotateServer({ markdown, filePath, mode, folderPath, gate, bundleFiles, htmlContent: MINIMAL_HTML });
		servers.push(server);
		launches.push({ kind: "annotate", text: filePath, mode, bundle: bundleFiles?.map((file) => file.path), gate, sessionBridge, url: server.url });
		return { url: server.url, waitForDecision: server.waitForDecision, stop: server.stop, hostControl: server.hostControl };
	};
	const startLastMessageAnnotation: NonNullable<PlannotatorExtensionDeps["startLastMessageAnnotation"]> = async (
		_ctx, lastText, gate, recentMessages, sessionBridge,
	) => {
		const server = await startAnnotateServer({ markdown: lastText, filePath: "last-message", mode: "annotate-last", gate, recentMessages, htmlContent: MINIMAL_HTML });
		servers.push(server);
		launches.push({ kind: "last", text: lastText, recent: recentMessages, gate, sessionBridge, url: server.url });
		return { url: server.url, waitForDecision: server.waitForDecision, stop: server.stop, hostControl: server.hostControl };
	};
	const startCodeReview: NonNullable<PlannotatorExtensionDeps["startCodeReview"]> = async (_ctx, reviewOptions = {}) => {
		const server = await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML });
		servers.push(server);
		launches.push({ kind: "review", gate: undefined, sessionBridge: reviewOptions.sessionBridge, url: server.url });
		return { url: server.url, waitForDecision: server.waitForDecision, stop: server.stop, hostControl: server.hostControl };
	};

	const startPlanReview: NonNullable<PlannotatorExtensionDeps["startPlanReview"]> = async (_ctx, planContent) => {
		let resolve!: (result: PlanReviewDecision) => void;
		const decision = new Promise<PlanReviewDecision>((res) => {
			resolve = res;
		});
		planReviews.push({ decide: resolve });
		return {
			url: `http://localhost:${5000 + planReviews.length}`,
			reviewId: `plan-${planReviews.length}`,
			waitForDecision: () => decision,
			onDecision: () => () => undefined,
			stop: () => undefined,
			updatePlan: (plan: string) => (plan === planContent ? { revision: 0, version: 1, unchanged: true } : null),
			hostControl: { status: () => ({ kind: "plan", documents: [], unsentAnnotations: 0, decided: false }) },
		} as never;
	};

	plannotator(pi as never, {
		hasPlanBrowserHtml: () => true,
		hasReviewBrowserHtml: () => true,
		startAnnotation,
		startLastMessageAnnotation,
		startCodeReview,
		startPlanReview,
		...options.deps,
	});

	const tool = () => tools.get(PLANNOTATOR_TOOL_NAME)!;
	return {
		cwd,
		ctx,
		sessionId,
		makeCtx,
		tools,
		sent,
		notices,
		launches,
		tool,
		call(params: unknown, callCtx: unknown = ctx, toolCallId = "call-1") {
			return tool().execute(toolCallId, params, undefined, undefined, callCtx);
		},
		async command(name: string, args: string) {
			await commands.get(name)!.handler(args, ctx);
		},
		async startSession() {
			for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
		},
		writeFile(name: string, content: string) {
			const path = join(cwd, name);
			writeFileSync(path, content);
			return path;
		},
	};
}

async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

const postJson = (url: string, body: unknown) =>
	fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const sessionIdIn = (text: string) => /^Session: (pn-[0-9a-f]{6})$/m.exec(text)?.[1];
const firstLine = (text: string) => text.split("\n")[0];

const assistant = (id: string, content: unknown[]): BranchEntry => ({ id, type: "message", message: { role: "assistant", content } });
const user = (id: string, text: string): BranchEntry => ({ id, type: "message", message: { role: "user", content: [{ type: "text", text }] } });

describe("plannotator tool on Pi", () => {
	test("registers the shared contract, and the installed Pi validates calls against its schema", () => {
		const harness = createHarness();
		const tool = harness.tool();
		expect(tool.name).toBe(PLANNOTATOR_TOOL_NAME);
		expect(tool.description).toBe(PLANNOTATOR_TOOL_DESCRIPTION);
		expect(tool.parameters).toEqual(PLANNOTATOR_TOOL_INPUT_SCHEMA);
		expect(tool.executionMode).toBe("sequential");

		const validate = (args: unknown) => validateToolArguments(tool as never, { type: "toolCall", id: "t", name: tool.name, arguments: args } as never);
		expect(validate({ action: "annotate", target: "notes.md", gate: true })).toEqual({ action: "annotate", target: "notes.md", gate: true });
		expect(validate({ action: "annotate", target: ["a.md", "b.md"] })).toEqual({ action: "annotate", target: ["a.md", "b.md"] });
		expect(validate({ action: "close", session: "all" })).toEqual({ action: "close", session: "all" });
		expect(() => validate({ action: "annotate", target: "x.md", bogus: 1 })).toThrow();
		expect(() => validate({ action: "explode" })).toThrow();
	});

	test("annotate opens at once with Ask this session attached; feedback arrives later as a followUp naming the session", async () => {
		const harness = createHarness();
		const file = harness.writeFile("notes.md", "# Notes\n\nSome text.\n");
		const result = await harness.call({ action: "annotate", target: "notes.md" });

		expect(result.terminate).toBe(true);
		const text = result.content[0]!.text;
		const id = sessionIdIn(text);
		expect(id).toBeDefined();
		const launch = harness.launches[0]!;
		expect(launch.text).toBe(file);
		expect(launch.sessionBridge).toBeDefined();
		expect(text).toContain(launch.url);
		expect(harness.sent).toHaveLength(0);

		const posted = await postJson(`${launch.url}/api/feedback`, {
			feedback: "Tighten the intro.",
			annotations: [{ id: "a1", type: "COMMENT", text: "Tighten the intro." }],
		});
		expect(posted.status).toBe(200);
		await until(() => harness.sent.length > 0);

		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]!.options).toEqual({ deliverAs: "followUp" });
		expect(firstLine(harness.sent[0]!.text)).toBe(`Plannotator: notes.md (${id}) — Feedback · 1 comment.`);
		expect(harness.sent[0]!.text).toContain("Tighten the intro.");
		expect((await harness.call({ action: "list" })).content[0]!.text).toContain("No open Plannotator reviews");
	});

	test("a list target opens one bundle review of those files, in order; list, feedback and close cover it", async () => {
		const harness = createHarness();
		const spec = harness.writeFile("spec.md", "# Spec\n");
		const notes = harness.writeFile("notes.md", "# Notes\n");
		const result = await harness.call({ action: "annotate", target: ["spec.md", "notes.md"] });

		expect(result.terminate).toBe(true);
		const text = result.content[0]!.text;
		const id = sessionIdIn(text)!;
		expect(text).toContain("Opened 2 files: spec.md, notes.md in Plannotator");
		const launch = harness.launches[0]!;
		expect(launch.mode).toBe("annotate-bundle");
		expect(launch.bundle).toEqual([spec, notes]);
		expect(launch.sessionBridge).toBeDefined();
		const plan = await (await fetch(`${launch.url}/api/plan`)).json();
		expect(plan.bundle.map((file: { path: string }) => file.path)).toEqual([spec, notes]);
		expect((await harness.call({ action: "list" })).content[0]!.text).toContain(`${id} · annotate · 2 files: spec.md, notes.md`);

		await postJson(`${launch.url}/api/feedback`, { feedback: "Merge the two intros.", annotations: [{ id: "b1" }] });
		await until(() => harness.sent.length > 0);
		expect(firstLine(harness.sent[0]!.text)).toBe(`Plannotator: 2 files: spec.md, notes.md (${id}) — Feedback · 1 comment.`);
		expect(harness.sent[0]!.text).toContain("Merge the two intros.");
		expect(harness.sent[0]!.text).toContain(spec);
		expect(harness.sent[0]!.text).toContain(notes);

		// Closing a bundle the agent opened works like any other review.
		const again = await harness.call({ action: "annotate", target: ["spec.md", "notes.md"] });
		const againId = sessionIdIn(again.content[0]!.text)!;
		expect((await harness.call({ action: "close", session: againId })).content[0]!.text).toContain(`Closed 2 files: spec.md, notes.md (${againId})`);
	});

	test("a list target never opens fewer files than named", async () => {
		const harness = createHarness();
		harness.writeFile("notes.md", "# Notes\n");
		await expect(harness.call({ action: "annotate", target: ["notes.md", "missing.md"] })).rejects.toThrow("missing.md");
		await expect(harness.call({ action: "annotate", target: ["notes.md", "."] })).rejects.toThrow("every entry must be an existing file");
		expect(harness.launches).toHaveLength(0);
	});

	test("a gated session the tool opened delivers a bare approval", async () => {
		const harness = createHarness();
		harness.writeFile("spec.md", "# Spec\n");
		const result = await harness.call({ action: "annotate", target: "spec.md", gate: true });
		const id = sessionIdIn(result.content[0]!.text);
		const launch = harness.launches[0]!;
		expect(launch.gate).toBe(true);

		expect((await postJson(`${launch.url}/api/approve`, {})).status).toBe(200);
		await until(() => harness.sent.length > 0);
		expect(firstLine(harness.sent[0]!.text)).toBe(`Plannotator: spec.md (${id}) — Approved.`);
	});

	// A real report: two QUESTIONS.md in different folders, and a bare approval
	// headed only "QUESTIONS.md", so the agent acted on the other file.
	test("two same-named files: subjects are told apart and each decision names its own full path", async () => {
		const harness = createHarness();
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(harness.cwd, "releases-2026-09-20"));
		mkdirSync(join(harness.cwd, "releases-2026-10-04"));
		const oldFile = harness.writeFile("releases-2026-09-20/QUESTIONS.md", "# Q\n");
		const newFile = harness.writeFile("releases-2026-10-04/QUESTIONS.md", "# Q\n");
		const first = (await harness.call({ action: "annotate", target: "releases-2026-09-20/QUESTIONS.md", gate: true })).content[0]!.text;
		const second = (await harness.call({ action: "annotate", target: "releases-2026-10-04/QUESTIONS.md", gate: true })).content[0]!.text;
		expect(first).toContain(`Target: ${oldFile}`);
		expect(second).toContain(`Target: ${newFile}`);
		expect(second).toContain("Opened releases-2026-10-04/QUESTIONS.md in Plannotator");

		expect((await postJson(`${harness.launches[1]!.url}/api/approve`, {})).status).toBe(200);
		await until(() => harness.sent.length > 0);
		expect(harness.sent[0]!.text.split("\n").slice(0, 2)).toEqual([
			`Plannotator: releases-2026-10-04/QUESTIONS.md (${sessionIdIn(second)}) — Approved.`,
			`Target: ${newFile}`,
		]);
		expect(harness.sent[0]!.text).not.toContain(oldFile);
	});

	test("list and close cover this Pi session's reviews only; close keeps the draft and sends nothing", async () => {
		const harness = createHarness();
		harness.writeFile("notes.md", "# Notes\n");
		const opened = await harness.call({ action: "annotate", target: "notes.md" });
		const id = sessionIdIn(opened.content[0]!.text)!;
		const launch = harness.launches[0]!;
		await postJson(`${launch.url}/api/draft`, { annotations: [{ id: "a1" }, { id: "a2" }], codeAnnotations: [], globalAttachments: [] });

		const listed = (await harness.call({ action: "list" })).content[0]!.text;
		expect(listed).toContain(`${id} · annotate · notes.md · ${launch.url}`);
		expect(listed).toContain("unsent: 2");

		// Another Pi session in this process sees none of it and cannot close it.
		const other = harness.makeCtx(freshSessionId());
		expect((await harness.call({ action: "list" }, other)).content[0]!.text).toContain("No open Plannotator reviews");
		await expect(harness.call({ action: "close", session: id }, other)).rejects.toThrow(`No open Plannotator review ${id}`);

		const closed = (await harness.call({ action: "close", session: id.toUpperCase() })).content[0]!.text;
		expect(closed).toContain(`Closed notes.md (${id}): 2 unsent comments saved as a draft.`);
		// The draft is still on the server, and nothing reaches the agent.
		const draft = await (await fetch(`${launch.url}/api/draft`)).json();
		expect(draft.annotations).toHaveLength(2);
		await until(() => harness.notices.some((notice) => notice.message.includes("the agent closed")));
		expect(harness.notices.some((notice) => notice.message.includes(`the agent closed notes.md (${id}). 2 unsent comments kept in the draft.`))).toBe(true);
		expect(harness.sent).toHaveLength(0);
		expect((await harness.call({ action: "list" })).content[0]!.text).toContain("No open Plannotator reviews");
	});

	test("a replacement extension instance for the same Pi session (reload, resume) still lists and closes its reviews", async () => {
		const first = createHarness();
		first.writeFile("notes.md", "# Notes\n");
		const id = sessionIdIn((await first.call({ action: "annotate", target: "notes.md" })).content[0]!.text)!;

		const reloaded = createHarness({ sessionId: first.sessionId });
		expect((await reloaded.call({ action: "list" })).content[0]!.text).toContain(`${id} · annotate · notes.md`);
		const elsewhere = createHarness();
		expect((await elsewhere.call({ action: "list" })).content[0]!.text).toContain("No open Plannotator reviews");
		await expect(elsewhere.call({ action: "close", session: id })).rejects.toThrow(`No open Plannotator review ${id}`);

		expect((await reloaded.call({ action: "close", session: id })).content[0]!.text).toContain(`Closed notes.md (${id})`);
	});

	test("a process registry left by another Plannotator version under the key is replaced, not used", () => {
		const store = globalThis as unknown as Record<string, unknown>;
		const key = "__plannotatorPiReviewRegistry_v1";
		const saved = store[key];
		try {
			store[key] = { add: () => undefined };
			const registry = getProcessPiReviewRegistry();
			expect(typeof registry.openAll).toBe("function");
			expect(getProcessPiReviewRegistry()).toBe(registry);
		} finally {
			store[key] = saved;
		}
	});

	test("slash-command reviews are listed too, and close all skips a plan review", async () => {
		const harness = createHarness();
		harness.writeFile("PLAN.md", "# Plan\n\n- [ ] Step\n");
		harness.writeFile("notes.md", "# Notes\n");
		await harness.startSession();
		await harness.command("plannotator-plan-mode", "");
		await harness.tools.get("plannotator_submit_plan")!.execute("p", { filePath: "PLAN.md" }, undefined, undefined, harness.ctx);
		await harness.command("plannotator-annotate", "notes.md");

		const listed = (await harness.call({ action: "list" })).content[0]!.text;
		expect(listed).toContain("2 open Plannotator reviews");
		expect(listed).toContain("· plan · Plan v1 ·");
		expect(listed).toContain("· annotate · notes.md ·");
		const planId = /(pn-[0-9a-f]{6}) · plan/.exec(listed)![1]!;

		await expect(harness.call({ action: "close", session: planId })).rejects.toThrow("is a plan review");
		const closedAll = (await harness.call({ action: "close", session: "all" })).content[0]!.text;
		expect(closedAll).toContain("Not closed: Plan v1");
		expect(closedAll).toMatch(/Closed notes\.md \(pn-[0-9a-f]{6}\): no unsent comments\./);
	});

	test("/plannotator-review delivers the reviewer's feedback with the decision heading", async () => {
		const harness = createHarness();
		await harness.command("plannotator-review", "");
		const launch = harness.launches[0]!;
		expect(launch.kind).toBe("review");
		expect(launch.sessionBridge).toBeDefined();
		const listed = (await harness.call({ action: "list" })).content[0]!.text;
		const id = /(pn-[0-9a-f]{6}) · review · local changes/.exec(listed)?.[1];
		expect(id).toBeDefined();

		await postJson(`${launch.url}/api/feedback`, { approved: false, feedback: "Rename b.", annotations: [{ id: "c1" }] });
		await until(() => harness.sent.length > 0);
		expect(firstLine(harness.sent[0]!.text)).toBe(`Plannotator: local changes (${id}) — Changes requested · 1 comment.`);
		expect(harness.sent[0]!.text).toContain("Rename b.");
		expect(harness.sent[0]!.options).toEqual({ deliverAs: "followUp" });
	});

	test("review feedback carried only in the text (PR description or editor notes, no annotations) reaches the agent through the tool path", async () => {
		const harness = createHarness();
		const id = sessionIdIn((await harness.call({ action: "review" })).content[0]!.text)!;
		const launch = harness.launches[0]!;
		await postJson(`${launch.url}/api/feedback`, { approved: false, feedback: "## PR description\n\nSay why, not what.", annotations: [] });
		await until(() => harness.sent.length > 0);
		const message = harness.sent[0]!.text;
		expect(firstLine(message)).toBe(`Plannotator: local changes (${id}) — Changes requested.`);
		expect(message).toContain("Say why, not what.");
		// Real feedback gets the verification suffix even with no annotations.
		expect(message).toContain("Treat the findings above as unverified review input.");
	});

	test("the PR-platform status post (platform: true) is delivered verbatim, labeled as posted", async () => {
		const harness = createHarness();
		await harness.command("plannotator-review", "");
		const launch = harness.launches[0]!;
		await postJson(`${launch.url}/api/feedback`, {
			approved: false,
			feedback: "Pull request reviewed on GitHub: https://github.com/o/r/pull/1",
			annotations: [],
			platform: true,
		});
		await until(() => harness.sent.length > 0);
		// The shared outcome, so every host names the platform post the same way.
		expect(firstLine(harness.sent[0]!.text).endsWith(`— ${PLANNOTATOR_OUTCOME_REVIEW_POSTED}.`)).toBe(true);
		expect(harness.sent[0]!.text).not.toContain("Treat the findings above as unverified review input.");
	});

	test("the agent closes a code review: the draft is kept and nothing is delivered", async () => {
		const harness = createHarness();
		const opened = await harness.call({ action: "review" });
		const id = sessionIdIn(opened.content[0]!.text)!;
		const launch = harness.launches[0]!;
		await postJson(`${launch.url}/api/draft`, { annotations: [], codeAnnotations: [{ id: "c1" }], globalAttachments: [] });

		const closed = (await harness.call({ action: "close", session: id })).content[0]!.text;
		expect(closed).toContain(`Closed local changes (${id}): 1 unsent comment saved as a draft.`);
		expect((await (await fetch(`${launch.url}/api/draft`)).json()).codeAnnotations).toHaveLength(1);
		await until(() => harness.notices.some((notice) => notice.message.includes("the agent closed")));
		expect(harness.sent).toHaveLength(0);
	});

	test("/plannotator-last delivers feedback; an agent close names the agent's message, not 'your'", async () => {
		const branch = [user("u1", "Explain it."), assistant("a1", [{ type: "text", text: "Here is the answer." }])];
		const delivering = createHarness({ branch });
		await delivering.command("plannotator-last", "");
		const launch = delivering.launches[0]!;
		expect(launch.text).toBe("Here is the answer.");
		const id = /(pn-[0-9a-f]{6}) · last · your last message/.exec((await delivering.call({ action: "list" })).content[0]!.text)?.[1];
		expect(id).toBeDefined();
		await postJson(`${launch.url}/api/feedback`, { feedback: "Shorter please.", annotations: [{ id: "m1" }] });
		await until(() => delivering.sent.length > 0);
		expect(firstLine(delivering.sent[0]!.text)).toBe(`Plannotator: your last message (${id}) — Feedback · 1 comment.`);
		expect(delivering.sent[0]!.text).toContain("Shorter please.");

		const closing = createHarness({ branch });
		await closing.command("plannotator-last", "");
		await closing.call({ action: "close", session: "all" });
		await until(() => closing.notices.some((notice) => notice.message.includes("the agent closed")));
		const notice = closing.notices.find((entry) => entry.message.includes("the agent closed"))!.message;
		expect(notice).toContain("the agent closed the agent's last message (pn-");
		expect(closing.sent).toHaveLength(0);
	});

	test("the tool's last skips the assistant message that is calling it", async () => {
		const branch = [
			user("u1", "First question."),
			assistant("a1", [{ type: "text", text: "First answer." }]),
			user("u2", "Second question."),
			assistant("a2", [{ type: "text", text: "Real answer to annotate." }]),
			user("u3", "Open that in Plannotator."),
			assistant("a3", [
				{ type: "text", text: "Opening it in Plannotator now." },
				{ type: "toolCall", id: "call-last", name: "plannotator", arguments: { action: "last" } },
			]),
		];
		const harness = createHarness({ branch });
		const result = await harness.call({ action: "last" }, harness.ctx, "call-last");
		expect(result.terminate).toBe(true);
		const launch = harness.launches[0]!;
		expect(launch.text).toBe("Real answer to annotate.");
		expect(launch.recent?.map((message) => message.messageId)).toEqual(["a2", "a1"]);
		expect(result.content[0]!.text).toContain("Opened your recent messages in Plannotator");
	});

	test("on one fixed port a second open is refused and names the open review", async () => {
		const harness = createHarness();
		harness.writeFile("notes.md", "# Notes\n");
		harness.writeFile("spec.md", "# Spec\n");
		const id = sessionIdIn((await harness.call({ action: "annotate", target: "notes.md" })).content[0]!.text)!;
		// Set after the first server bound a random port: no fixed-port bind happens here.
		process.env.PLANNOTATOR_PORT = "19999";
		await expect(harness.call({ action: "annotate", target: "spec.md" })).rejects.toThrow(`notes.md (${id}) is open`);
		// Another Pi session cannot close it, so it is told to ask the user.
		const other = harness.makeCtx(freshSessionId());
		await expect(harness.call({ action: "annotate", target: "spec.md" }, other)).rejects.toThrow(
			"ask the user to finish or close that review in its browser tab",
		);
		expect(harness.launches).toHaveLength(1);
		delete process.env.PLANNOTATOR_PORT;
		expect((await harness.call({ action: "annotate", target: "spec.md" })).terminate).toBe(true);
	});

	test("review maps the call to the slash command's arguments", async () => {
		let received: Record<string, unknown> | undefined;
		const harness = createHarness({
			deps: {
				startCodeReview: async (_ctx, reviewOptions) => {
					received = reviewOptions as Record<string, unknown>;
					return { url: "http://localhost:6001", waitForDecision: () => new Promise(() => undefined), stop: () => undefined };
				},
			},
		});
		const result = await harness.call({ action: "review", options: { base: "main" } });
		expect(received).toMatchObject({ defaultBranch: "main", openStateFromFlags: true });
		expect(received!.sessionBridge).toBeDefined();
		expect(result.terminate).toBe(true);
		expect(result.content[0]!.text).toContain("Opened local changes in Plannotator: http://localhost:6001");
	});

	test("refuses what it cannot open: bad calls, reply, no UI, a missing file", async () => {
		const harness = createHarness();
		await expect(harness.call({ action: "list", target: "x.md" })).rejects.toThrow('action "list" takes no target');
		await expect(harness.call({ action: "reply", session: "pn-abcdef", comment: "c1", text: "done" })).rejects.toThrow("Invalid plannotator call");
		await expect(harness.call({ action: "annotate", target: "missing.md" })).rejects.toThrow("Plannotator did not open: File not found");
		// One target is one argument: words are never split into a tolerant search.
		harness.writeFile("notes.md", "# Notes\n");
		await expect(harness.call({ action: "annotate", target: "look at notes.md" })).rejects.toThrow("File not found");

		const headless = createHarness({ hasUI: false });
		headless.writeFile("notes.md", "# Notes\n");
		await expect(headless.call({ action: "annotate", target: "notes.md" })).rejects.toThrow("no interactive UI");
		expect(harness.launches).toHaveLength(0);
		expect(headless.launches).toHaveLength(0);
	});
});
