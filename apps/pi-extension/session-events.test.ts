import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator, { type PlannotatorExtensionDeps } from "./index.ts";
import { checklistWindow } from "./checklist-window.ts";
import type { BrowserDecisionSession, PlanReviewDecision } from "./plannotator-browser.ts";
import {
	PLANNOTATOR_SESSION_CLOSED_CHANNEL,
	PLANNOTATOR_SESSION_OPENED_CHANNEL,
	claimSessionEventBus,
	newSessionEventId,
	openSessionEvent,
	releaseSessionEventBus,
	type PlannotatorSessionClosedEvent,
	type PlannotatorSessionOpenedEvent,
} from "./session-events.ts";
import { setPiHost } from "./pi-host.ts";
import { createPiReviewRegistry } from "./plannotator-tool-host.ts";

const STALE_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";
const PI_DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "PLANNOTATOR_AGENT_TOOL", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TOOL"] as const;

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const pis: Array<{ events: { emit: (channel: string, data: unknown) => void } }> = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	const home = makeTempDir("plannotator-session-events-home-");
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
	process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-session-events-data-");
	process.env.PLANNOTATOR_AGENT_TOOL = "1";
	process.env.PLANNOTATOR_INBOX_TOOL = "0";
});

afterEach(() => {
	for (const pi of pis.splice(0)) releaseSessionEventBus(pi);
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key]!;
	}
	setPiHost("pi");
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Decide<T> = (result: T) => void;
type ToolDefinition = Record<string, unknown> & { name: string; execute: (...args: unknown[]) => Promise<any> };

function fakeSession<T>(url: string): { session: BrowserDecisionSession<T>; decide: Decide<T>; stop: () => void } {
	let decide!: Decide<T>;
	let fail!: (err: Error) => void;
	const decision = new Promise<T>((resolve, reject) => {
		decide = resolve;
		fail = reject;
	});
	const stop = () => {
		const err = new Error("Plannotator browser session was stopped.");
		err.name = "PlannotatorBrowserSessionStopped";
		fail(err);
	};
	return { session: { url, waitForDecision: () => decision, stop }, decide, stop };
}

function createPi(options: { busWorks?: boolean } = {}) {
	const busWorks = options.busWorks ?? true;
	const cwd = makeTempDir("plannotator-session-events-");
	writeFileSync(join(cwd, "notes.md"), "# Notes\n\nSome text.\n");
	const state = { activeTools: [...PI_DEFAULT_TOOLS] };

	const busListeners = new Map<string, Array<(data: unknown) => void>>();
	const received: Array<{ channel: string; data: any }> = [];
	for (const channel of [PLANNOTATOR_SESSION_OPENED_CHANNEL, PLANNOTATOR_SESSION_CLOSED_CHANNEL]) {
		busListeners.set(channel, [(data) => received.push({ channel, data })]);
	}

	const requests: string[] = [];
	const conversation: unknown[] = [];
	const widgets: Array<string[] | undefined> = [];
	const reviews: Array<{ kind: string; decide: Decide<any>; stop: () => void }> = [];
	let tools = new Map<string, ToolDefinition>();
	let handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	let commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	let goStale: () => void = () => undefined;
	let url = 4300;
	const nextUrl = () => `http://localhost:${(url += 1)}`;

	const deps: PlannotatorExtensionDeps = {
		hasPlanBrowserHtml: () => true,
		hasReviewBrowserHtml: () => true,
		startCodeReview: (async () => {
			const fake = fakeSession<any>(nextUrl());
			reviews.push({ kind: "review", decide: fake.decide, stop: fake.stop });
			return fake.session;
		}) as never,
		startAnnotation: (async () => {
			const fake = fakeSession<any>(nextUrl());
			reviews.push({ kind: "annotate", decide: fake.decide, stop: fake.stop });
			return fake.session;
		}) as never,
		startPlanReview: (async () => {
			const fake = fakeSession<PlanReviewDecision>(nextUrl());
			reviews.push({ kind: "plan", decide: fake.decide, stop: fake.stop });
			return {
				...fake.session,
				reviewId: `review-${reviews.length}`,
				onDecision: () => () => undefined,
				updatePlan: () => null,
			};
		}) as never,
	};

	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => undefined,
		model: undefined,
		modelRegistry: { find: () => undefined },
		sessionManager: {
			getBranch: () => entries,
			getEntries: () => entries,
			getSessionId: () => "events-session",
			getSessionFile: () => null,
			getSessionName: () => undefined,
		},
		ui: {
			notify: () => undefined,
			setStatus: () => undefined,
			setWidget: (key: string, lines: string[] | undefined) => {
				if (key === "plannotator-progress") widgets.push(lines);
			},
			theme: {
				bold: (text: string) => text,
				fg: (_color: string, text: string) => text,
				strikethrough: (text: string) => text,
			},
		},
	};

	function load(): void {
		handlers = new Map();
		tools = new Map();
		commands = new Map();
		let stale = false;
		const guard = () => {
			if (stale) throw new Error(STALE_MESSAGE);
		};
		goStale = () => {
			stale = true;
		};
		const pi = {
			events: {
				on: (channel: string, handler: (data: unknown) => void) => {
					guard();
					busListeners.set(channel, [...(busListeners.get(channel) ?? []), handler]);
					return () => undefined;
				},
				emit: (channel: string, data: unknown) => {
					guard();
					if (!busWorks) throw new Error(STALE_MESSAGE);
					for (const listener of busListeners.get(channel) ?? []) listener(data);
				},
			},
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerFlag: () => undefined,
			registerShortcut: () => undefined,
			registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
			getFlag: () => false,
			getActiveTools: () => {
				guard();
				return [...state.activeTools];
			},
			setActiveTools: (next: string[]) => {
				guard();
				state.activeTools = [...next];
			},
			getThinkingLevel: () => "medium",
			setThinkingLevel: () => undefined,
			setModel: async () => true,
			getCommands: () => [],
			appendEntry: (customType: string, data: unknown) => {
				guard();
				entries.push({ type: "custom", customType, data });
			},
			sendMessage: (message: unknown, sendOptions: unknown) => {
				guard();
				conversation.push({ sendMessage: message, options: sendOptions });
			},
			sendUserMessage: (text: string, sendOptions: unknown) => {
				guard();
				conversation.push({ sendUserMessage: text, options: sendOptions });
			},
		};
		pis.push(pi);
		plannotator(pi as never, deps);
	}

	async function emit(event: string, payload: unknown = {}): Promise<unknown[]> {
		const results = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
		return results;
	}

	const flush = async () => {
		for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
	};

	return {
		received,
		requests,
		conversation,
		widgets,
		reviews,
		ctx,
		async start() {
			load();
			await emit("session_start", { reason: "startup" });
		},
		async reload() {
			await emit("session_shutdown", { reason: "reload" });
			goStale();
			load();
			await emit("session_start", { reason: "reload" });
		},
		async request() {
			const results = await emit("before_agent_start", { prompt: "next", systemPrompt: "BASE" });
			const toolDefinitions = state.activeTools.map((name) => {
				const tool = tools.get(name);
				return tool ? JSON.stringify(tool) : name;
			});
			requests.push(JSON.stringify({ results, activeTools: state.activeTools, toolDefinitions, conversation }));
		},
		async command(name: string, args = "") {
			await commands.get(name)!.handler(args, ctx);
			await flush();
		},
		async tool(name: string, input: unknown) {
			const result = await tools.get(name)!.execute(`call-${name}`, input, undefined, undefined, ctx);
			await flush();
			return result;
		},
		async agentEnd() {
			await emit("agent_end", { messages: [] });
			await flush();
		},
		async decide(index: number, result: unknown) {
			reviews[index]!.decide(result);
			await flush();
		},
		flush,
	};
}

async function trapFatal(run: () => Promise<void>): Promise<unknown[]> {
	const fatal: unknown[] = [];
	const onFatal = (err: unknown) => fatal.push(err);
	process.on("uncaughtException", onFatal);
	process.on("unhandledRejection", onFatal);
	try {
		await run();
		await new Promise((resolve) => setTimeout(resolve, 30));
	} finally {
		process.off("uncaughtException", onFatal);
		process.off("unhandledRejection", onFatal);
	}
	return fatal;
}

const opened = (pi: { received: Array<{ channel: string; data: any }> }) =>
	pi.received.filter((event) => event.channel === PLANNOTATOR_SESSION_OPENED_CHANNEL).map((event) => event.data as PlannotatorSessionOpenedEvent);
const closed = (pi: { received: Array<{ channel: string; data: any }> }) =>
	pi.received.filter((event) => event.channel === PLANNOTATOR_SESSION_CLOSED_CHANNEL).map((event) => event.data as PlannotatorSessionClosedEvent);

async function eventOnlyLifecycle(pi: ReturnType<typeof createPi>): Promise<void> {
	await pi.start();
	await pi.request();
	await pi.command("plannotator-review");
	await pi.request();
	await pi.decide(0, { approved: false, exit: true });
	await pi.request();
	await pi.command("plannotator-annotate", "notes.md");
	await pi.request();
	await pi.reload();
	await pi.request();
	await pi.decide(1, { feedback: "", exit: true });
	await pi.request();
}

describe("session events never change the model's request (prompt cache)", () => {
	test("every request is byte-identical while reviews open, close, and outlive /reload", async () => {
		const pi = createPi();
		const fatal = await trapFatal(() => eventOnlyLifecycle(pi));
		expect(fatal).toEqual([]);

		expect(opened(pi).map((event) => event.action)).toEqual(["code-review", "annotate"]);
		expect(closed(pi).map((event) => [event.action, event.outcome, event.closedBy])).toEqual([
			["code-review", "closed", "reviewer"],
			["annotate", "closed", "reviewer"],
		]);
		expect(pi.conversation).toEqual([]);
		expect(pi.requests).toHaveLength(6);
		for (const request of pi.requests) expect(request).toBe(pi.requests[0]!);
		expect(pi.requests[0]).toContain("\"plannotator\"");
		expect(pi.requests[0]).not.toContain("systemPrompt");
	});

	test("the same requests whether the bus delivers or throws (a dead bus changes nothing)", async () => {
		const live = createPi({ busWorks: true });
		const dead = createPi({ busWorks: false });
		const quiet = console.error;
		console.error = () => undefined;
		try {
			expect(await trapFatal(() => eventOnlyLifecycle(live))).toEqual([]);
			expect(await trapFatal(() => eventOnlyLifecycle(dead))).toEqual([]);
		} finally {
			console.error = quiet;
		}
		expect(closed(live)).toHaveLength(2);
		expect(dead.received).toEqual([]);
		expect(dead.requests).toEqual(live.requests);
	});
});

describe("plannotator:session-opened / session-closed", () => {
	test("a slash command's review: one pair, with the tool's pn- id, the URL and the outcome", async () => {
		const pi = createPi();
		await pi.start();
		await pi.command("plannotator-review");
		const [open] = opened(pi);
		expect(open).toMatchObject({ action: "code-review", url: "http://localhost:4301", piSessionId: "events-session" });
		expect(open!.id).toMatch(/^pn-[0-9a-f]{6}$/);
		expect(typeof open!.openedAt).toBe("number");
		expect(closed(pi)).toEqual([]);

		await pi.decide(0, { approved: true });
		expect(closed(pi)).toEqual([{ ...open!, outcome: "approved", closedAt: expect.any(Number) }]);
		expect(pi.received.map((event) => event.channel)).toEqual([PLANNOTATOR_SESSION_OPENED_CHANNEL, PLANNOTATOR_SESSION_CLOSED_CHANNEL]);
	});

	test("feedback is `submitted`, the agent's close is `closed` by the agent", async () => {
		const pi = createPi();
		await pi.start();
		await pi.command("plannotator-annotate", "notes.md");
		await pi.decide(0, { feedback: "Rename the heading." });
		await pi.command("plannotator-annotate", "notes.md");
		await pi.decide(1, { feedback: "", exit: true, closedBy: "agent", unsentAnnotations: 0 });
		expect(closed(pi).map((event) => [event.outcome, event.closedBy])).toEqual([
			["submitted", undefined],
			["closed", "agent"],
		]);
	});

	test("the plannotator tool's reviews emit the same pair", async () => {
		const pi = createPi();
		await pi.start();
		await pi.tool("plannotator", { action: "review" });
		expect(opened(pi).map((event) => event.action)).toEqual(["code-review"]);
		await pi.decide(0, { approved: false, feedback: "Fix the null check." });
		expect(closed(pi).map((event) => event.outcome)).toEqual(["submitted"]);
	});

	test("a review that ends after /reload: no throw, and the close goes out on the live instance's bus", async () => {
		const pi = createPi();
		await pi.start();
		await pi.command("plannotator-annotate", "notes.md");
		const [open] = opened(pi);
		const fatal = await trapFatal(async () => {
			await pi.reload();
			await pi.decide(0, { feedback: "after reload" });
		});
		expect(fatal).toEqual([]);
		expect(closed(pi)).toEqual([expect.objectContaining({ id: open!.id, outcome: "submitted" })]);
	});

	test("a server that stopped without a decision closes as `stopped`", async () => {
		const pi = createPi();
		await pi.start();
		await pi.command("plannotator-review");
		const quiet = console.error;
		console.error = () => undefined;
		try {
			pi.reviews[0]!.stop();
			await pi.flush();
		} finally {
			console.error = quiet;
		}
		expect(closed(pi).map((event) => [event.outcome, event.closedBy])).toEqual([["closed", "stopped"]]);
	});

	test("plan review: opened on submit, closed `approved`", async () => {
		const pi = createPi();
		writeFileSync(join(pi.ctx.cwd, "PLAN.md"), "# Plan\n\n- [ ] One step\n");
		await pi.start();
		await pi.command("plannotator-plan-mode");
		await pi.tool("plannotator_submit_plan", { filePath: "PLAN.md" });
		expect(opened(pi).map((event) => event.action)).toEqual(["plan-review"]);
		await pi.decide(0, { approved: true });
		expect(closed(pi).map((event) => [event.action, event.outcome])).toEqual([["plan-review", "approved"]]);
	});

	test("plan review abandoned by leaving plan mode closes as `stopped`", async () => {
		const pi = createPi();
		writeFileSync(join(pi.ctx.cwd, "PLAN.md"), "# Plan\n\n- [ ] One step\n");
		await pi.start();
		await pi.command("plannotator-plan-mode");
		await pi.tool("plannotator_submit_plan", { filePath: "PLAN.md" });
		await pi.command("plannotator-plan-mode");
		expect(closed(pi).map((event) => [event.action, event.outcome, event.closedBy])).toEqual([["plan-review", "closed", "stopped"]]);
	});

	test("an open plan review closed by /reload goes out on the bus of the session it belonged to", async () => {
		const pi = createPi();
		writeFileSync(join(pi.ctx.cwd, "PLAN.md"), "# Plan\n\n- [ ] One step\n");
		await pi.start();
		await pi.command("plannotator-plan-mode");
		await pi.tool("plannotator_submit_plan", { filePath: "PLAN.md" });
		const fatal = await trapFatal(() => pi.reload());
		expect(fatal).toEqual([]);
		expect(closed(pi).map((event) => [event.action, event.outcome, event.closedBy])).toEqual([["plan-review", "closed", "stopped"]]);
	});
});

describe("where an event goes when its opener is gone", () => {
	const fakeBus = (behavior: "works" | "stale") => {
		const got: string[] = [];
		const pi = {
			events: {
				emit: (channel: string) => {
					if (behavior === "stale") throw new Error(STALE_MESSAGE);
					got.push(channel);
				},
			},
		};
		pis.push(pi);
		return { pi, got };
	};

	test("a slot holder torn down without releasing it is forgotten quietly, never thrown or logged", async () => {
		const opener = fakeBus("works");
		const leftover = fakeBus("stale");
		claimSessionEventBus(leftover.pi);
		const logged: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
		try {
			const fatal = await trapFatal(async () => {
				openSessionEvent(opener.pi, () => false, { id: "pn-000001", action: "annotate", url: "http://localhost:1" }).close({ outcome: "submitted" });
				await new Promise((resolve) => setTimeout(resolve, 5));
			});
			expect(fatal).toEqual([]);
		} finally {
			console.error = original;
		}
		expect(logged).toEqual([]);
		expect(opener.got).toEqual([]);
		const live = fakeBus("works");
		claimSessionEventBus(live.pi);
		openSessionEvent(opener.pi, () => false, { id: "pn-000002", action: "annotate", url: "http://localhost:2" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(live.got).toEqual([PLANNOTATOR_SESSION_OPENED_CHANNEL]);
	});

	test("an opener that throws although its session was live: logged, then the live instance gets it", async () => {
		const opener = fakeBus("stale");
		const live = fakeBus("works");
		claimSessionEventBus(live.pi);
		const logged: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
		try {
			openSessionEvent(opener.pi, () => true, { id: "pn-000003", action: "code-review", url: "http://localhost:3" });
			await new Promise((resolve) => setTimeout(resolve, 5));
		} finally {
			console.error = original;
		}
		expect(logged).toEqual([expect.stringContaining(`could not emit ${PLANNOTATOR_SESSION_OPENED_CHANNEL}`)]);
		expect(live.got).toEqual([PLANNOTATOR_SESSION_OPENED_CHANNEL]);
	});
});

describe("pn- ids are unique among the open reviews", () => {
	test("a plannotator:request review's id skips ids open reviews hold, and frees its own on close", async () => {
		const sink = { events: { emit: () => undefined } };
		pis.push(sink);
		const held = openSessionEvent(sink, () => true, { id: "pn-00000a", action: "annotate", url: "http://localhost:1" });
		const registryIds = new Set(["pn-00000b"]);
		expect(newSessionEventId((id) => registryIds.has(id), () => "00000a")).toBe("pn-00000c");
		held.close({ outcome: "submitted" });
		expect(newSessionEventId((id) => registryIds.has(id), () => "00000a")).toBe("pn-00000a");
		await new Promise((resolve) => setTimeout(resolve, 5));
	});

	test("the registry never hands out an id a plannotator:request review holds", async () => {
		const sink = { events: { emit: () => undefined } };
		pis.push(sink);
		const held = openSessionEvent(sink, () => true, { id: "pn-00001a", action: "code-review", url: "http://localhost:2" });
		const { isSessionEventIdOpen } = await import("./session-events.ts");
		const registry = createPiReviewRegistry({ randomHex: () => "00001a", isTaken: isSessionEventIdOpen });
		const review = registry.add({ kind: "annotate", subject: "notes.md", url: "http://localhost:3", owner: "s" });
		expect(review.id).toBe("pn-00001b");
		held.close({ outcome: "submitted" });
		await new Promise((resolve) => setTimeout(resolve, 5));
	});
});

describe("the checklist widget keeps the next open item in view (#1412)", () => {
	const items = (count: number, done: number) =>
		Array.from({ length: count }, (_, index) => ({ step: index + 1, text: `Item ${String(index + 1).padStart(2, "0")}`, completed: index < done }));
	const steps = (window: Array<{ step: number }>) => window.map((item) => item.step);

	test("ten items or fewer: all of them", () => {
		expect(steps(checklistWindow(items(10, 3)))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(steps(checklistWindow(items(4, 0)))).toEqual([1, 2, 3, 4]);
	});

	test("the issue's fifteen items: first ten, then one item down per completed step, then the last ten", () => {
		for (let done = 0; done <= 9; done += 1) expect(steps(checklistWindow(items(15, done)))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(steps(checklistWindow(items(15, 10)))).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
		expect(steps(checklistWindow(items(15, 11)))).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		expect(steps(checklistWindow(items(15, 14)))).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
		expect(steps(checklistWindow(items(15, 15)))).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
	});

	test("steps done out of order: the window follows the first open one", () => {
		const list = items(20, 0).map((item) => ({ ...item, completed: item.step !== 3 && item.step <= 15 }));
		expect(steps(checklistWindow(list))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		list[2]!.completed = true;
		expect(steps(checklistWindow(list))).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
	});

	test("in a running plan: at most 10 widget lines, the next open step always among them, nothing sent", async () => {
		const pi = createPi();
		const plan = `# Plan\n\n${Array.from({ length: 15 }, (_, index) => `- [ ] Item ${String(index + 1).padStart(2, "0")}`).join("\n")}\n`;
		writeFileSync(join(pi.ctx.cwd, "PLAN.md"), plan);
		await pi.start();
		await pi.command("plannotator-plan-mode");
		await pi.tool("plannotator_submit_plan", { filePath: "PLAN.md" });
		await pi.decide(0, { approved: true });
		const sentBefore = pi.conversation.length;

		for (let step = 1; step <= 12; step += 1) {
			const lines = pi.widgets.at(-1)!;
			expect(lines.length).toBeLessThanOrEqual(10);
			expect(lines.some((line) => line.startsWith("☐ ") && line.includes(`Item ${String(step).padStart(2, "0")}`))).toBe(true);
			await pi.tool("plannotator_mark_done", { step });
		}
		const lines = pi.widgets.at(-1)!;
		expect(lines).toHaveLength(10);
		expect(lines[0]).toContain("Item 04");
		expect(lines.at(-1)).toContain("☐ Item 13");
		const sent = JSON.stringify(pi.conversation.slice(sentBefore));
		expect(sent).not.toContain("☐");
		expect(sent).not.toContain("☑");
	});
});
