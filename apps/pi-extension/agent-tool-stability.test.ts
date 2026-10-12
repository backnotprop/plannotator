/**
 * The `plannotator` tool must not move under a running Pi session.
 *
 * Pi sends the active tool list with every model request, ahead of the
 * conversation, so adding or removing a tool mid-session changes the prompt
 * prefix and throws away the provider's prompt cache for the rest of the
 * session. Plan mode is the risky part: it adds and releases tools at every
 * phase change (planning, executing, idle, /tree, reload).
 *
 * Driven through the real extension over a fake Pi that records every
 * registerTool and setActiveTools call and models both activation rules the
 * peer range spans: Pi before 0.99 activates every registered tool, Pi 0.99+
 * honors `defaultActive: false`.
 *
 * What regresses if this fails:
 *  - a phase change drops or re-adds `plannotator` (cache miss mid-session);
 *  - the tool is activated (or deactivated) after the first request;
 *  - a print/JSON session sees a tool that can never deliver its decision;
 *  - the tool's definition drifts from the shared contract, or a
 *    plannotator tool starts adding promptSnippet/promptGuidelines (which Pi
 *    folds into the system prompt);
 *  - the agent tool switch stops keeping the tool out (off is Pi's default).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator, { type PlannotatorExtensionDeps } from "./index.ts";
import { setPiHost } from "./pi-host.ts";
import type { PlanReviewDecision } from "./plannotator-browser.ts";
import {
	PLANNOTATOR_TOOL_DESCRIPTION,
	PLANNOTATOR_TOOL_INPUT_SCHEMA,
	PLANNOTATOR_TOOL_NAME,
} from "./generated/plannotator-tool.ts";

const TOOL = PLANNOTATOR_TOOL_NAME;
const PI_DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const PLAN = "# Plan\n\n- [ ] Implement the change\n";

const tempDirs: string[] = [];
const savedEnv = {
	home: process.env.HOME,
	agentDir: process.env.PI_CODING_AGENT_DIR,
	agentTool: process.env.PLANNOTATOR_AGENT_TOOL,
	dataDir: process.env.PLANNOTATOR_DATA_DIR,
};
function restore(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
beforeEach(() => {
	// Off by default on Pi; the lifecycle tests are about the tool once on.
	process.env.PLANNOTATOR_AGENT_TOOL = "1";
});
afterEach(() => {
	restore("HOME", savedEnv.home);
	restore("PI_CODING_AGENT_DIR", savedEnv.agentDir);
	restore("PLANNOTATOR_AGENT_TOOL", savedEnv.agentTool);
	restore("PLANNOTATOR_DATA_DIR", savedEnv.dataDir);
	setPiHost("pi");
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Pi's rule for which registered tools a (re)build activates. */
type PiActivation = "pre-0.99" | "0.99+";

type ToolDefinition = Record<string, unknown> & { name: string; execute: (...args: unknown[]) => Promise<any> };

function createPi(options: { activation: PiActivation; hasUI: boolean; ohMyPi?: boolean }) {
	const cwd = makeTempDir("plannotator-tool-stability-");
	// Isolate Pi-side config lookup (never the developer's ~/.pi).
	const home = makeTempDir("plannotator-tool-stability-home-");
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
	writeFileSync(join(cwd, "PLAN.md"), PLAN);

	const state = { activeTools: [...PI_DEFAULT_TOOLS] };
	/** Every registerTool call, across reloads. */
	const registrations: ToolDefinition[] = [];
	/** Every setActiveTools call, in order, with what it changed for `plannotator`. */
	const setLog: Array<{ step: string; before: boolean; after: boolean }> = [];
	/** `plannotator` active at each model request. */
	const requests: Array<{ step: string; active: boolean }> = [];
	const beforeAgentStartResults: unknown[] = [];
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const sentUserMessages: string[] = [];
	const reviews: Array<{ decide: (result: PlanReviewDecision) => void }> = [];
	let step = "load";

	const ctx = {
		cwd,
		hasUI: options.hasUI,
		mode: options.hasUI ? "tui" : "print",
		isProjectTrusted: () => true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => undefined,
		model: undefined,
		modelRegistry: { find: () => undefined },
		sessionManager: {
			// The path /tree and resume re-derive phase state from.
			getBranch: () => entries,
			getEntries: () => entries,
			getSessionId: () => "stability-session",
			getSessionFile: () => null,
			getSessionName: () => undefined,
		},
		ui: {
			notify: () => undefined,
			setStatus: () => undefined,
			setWidget: () => undefined,
			theme: {
				bold: (text: string) => text,
				fg: (_color: string, text: string) => text,
				strikethrough: (text: string) => text,
			},
		},
	};

	const startPlanReview: NonNullable<PlannotatorExtensionDeps["startPlanReview"]> = async () => {
		let resolve!: (result: PlanReviewDecision) => void;
		const decision = new Promise<PlanReviewDecision>((res) => {
			resolve = res;
		});
		reviews.push({ decide: (result) => resolve(result) });
		return {
			url: "http://localhost:4100",
			reviewId: `review-${reviews.length}`,
			waitForDecision: () => decision,
			onDecision: () => () => undefined,
			stop: () => undefined,
			updatePlan: () => null,
		} as never;
	};

	let handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	let tools = new Map<string, ToolDefinition>();
	let commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();

	/** One extension instance, as Pi builds it on startup and on every /reload. */
	function load(previousActive: string[] | null): void {
		handlers = new Map();
		tools = new Map();
		commands = new Map();
		const loaded: ToolDefinition[] = [];
		const pi = {
			// Oh My Pi's ExtensionAPI also carries its schema builder and SDK module
			// (what apps/pi-extension/pi-host.ts reads); Pi's never does.
			...(options.ohMyPi ? { arktype: () => undefined, pi: {} } : {}),
			events: { on: () => () => undefined, emit: () => undefined },
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerFlag: () => undefined,
			registerShortcut: () => undefined,
			registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
			registerTool: (tool: ToolDefinition) => {
				registrations.push(tool);
				loaded.push(tool);
				tools.set(tool.name, tool);
			},
			getFlag: () => false,
			getActiveTools: () => [...state.activeTools],
			setActiveTools: (next: string[]) => {
				setLog.push({ step, before: state.activeTools.includes(TOOL), after: next.includes(TOOL) });
				state.activeTools = [...next];
			},
			getThinkingLevel: () => "medium",
			setThinkingLevel: () => undefined,
			setModel: async () => true,
			getCommands: () => [],
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
			sendMessage: () => undefined,
			sendUserMessage: (text: string) => sentUserMessages.push(text),
		};
		plannotator(pi as never, { startPlanReview, hasPlanBrowserHtml: () => true });
		// Pi's _refreshToolRegistry after the extensions load: the previous
		// active list (on reload) or the defaults, plus the registered tools its
		// version activates on registration.
		const activated = loaded
			.filter((tool) => options.activation === "pre-0.99" || tool.defaultActive !== false)
			.map((tool) => tool.name);
		state.activeTools = [...new Set([...(previousActive ?? PI_DEFAULT_TOOLS), ...activated])];
	}

	async function emit(event: string, payload: unknown = {}): Promise<unknown[]> {
		const results = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
		return results;
	}

	async function settle(until: () => boolean): Promise<void> {
		for (let i = 0; i < 50 && !until(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
	}

	return {
		state,
		registrations,
		setLog,
		requests,
		beforeAgentStartResults,
		reviews,
		sentUserMessages,
		lastPhase: () => (entries.filter((entry) => entry.customType === "plannotator").at(-1)?.data as { phase?: string } | undefined)?.phase,
		async start() {
			step = "session_start";
			load(null);
			await emit("session_start", { reason: "startup" });
		},
		async reload() {
			step = "reload";
			await emit("session_shutdown", { reason: "reload" });
			load(state.activeTools);
			await emit("session_start", { reason: "reload" });
		},
		/** One model request: before_agent_start, then the tool list Pi sends. */
		async request(label: string) {
			step = `request:${label}`;
			const results = await emit("before_agent_start", { prompt: label, systemPrompt: "BASE" });
			beforeAgentStartResults.push(...results);
			requests.push({ step: label, active: state.activeTools.includes(TOOL) });
		},
		async togglePlanMode(label: string) {
			step = label;
			await commands.get("plannotator-plan-mode")!.handler("", ctx);
		},
		async submit() {
			step = "submit";
			return tools.get("plannotator_submit_plan")!.execute("call-submit", { filePath: "PLAN.md" }, undefined, undefined, ctx);
		},
		async approve() {
			step = "approve";
			reviews.at(-1)!.decide({ approved: true });
			await settle(() => sentUserMessages.length > 0);
		},
		async markDone(stepNumber: number) {
			step = `mark_done:${stepNumber}`;
			return tools.get("plannotator_mark_done")!.execute("call-done", { step: stepNumber }, undefined, undefined, ctx);
		},
		async agentEnd(label: string) {
			step = label;
			await emit("agent_end", { messages: [] });
		},
		async tree() {
			step = "tree";
			await emit("session_tree", {});
		},
	};
}

type Harness = ReturnType<typeof createPi>;

/** The whole plan-mode lifecycle, with a model request wherever a turn would run. */
async function runLifecycle(pi: Harness): Promise<void> {
	await pi.start();
	await pi.request("idle");
	await pi.togglePlanMode("plan mode on");
	await pi.request("planning turn");
	await pi.submit();
	await pi.request("after submit");
	await pi.approve();
	expect(pi.lastPhase()).toBe("executing");
	await pi.request("execution turn");
	await pi.markDone(1);
	await pi.request("after mark_done");
	// The approval turn ends (Pi then continues the plan), then the turn that
	// completed the last step ends: the plan is complete and Plannotator idles.
	await pi.agentEnd("agent_end after approval");
	await pi.agentEnd("agent_end complete");
	expect(pi.lastPhase()).toBe("idle");
	await pi.request("idle after completion");

	// Plan mode off mid-plan.
	await pi.togglePlanMode("plan mode on again");
	await pi.request("second planning turn");
	await pi.togglePlanMode("plan mode off mid-plan");
	expect(pi.lastPhase()).toBe("idle");
	await pi.request("idle after leaving plan mode");

	// /tree back onto a path that is planning, then a reload.
	await pi.togglePlanMode("plan mode on for tree");
	await pi.tree();
	await pi.request("after tree");
	await pi.reload();
	await pi.request("after reload");
}

/** setActiveTools calls that added or removed `plannotator`. */
function toolFlips(pi: Harness) {
	return pi.setLog.filter((call) => call.before !== call.after);
}

describe("the plannotator tool stays put for the whole session", () => {
	for (const activation of ["pre-0.99", "0.99+"] as const) {
		test(`interactive session, Pi ${activation}: active at every request, never added or removed after the start`, async () => {
			const pi = createPi({ activation, hasUI: true });
			await runLifecycle(pi);

			expect(pi.requests.length).toBeGreaterThan(8);
			expect(pi.requests.filter((request) => !request.active)).toEqual([]);
			// The only change Plannotator may make is the one activation at the
			// first session_start (Pi 0.99+ leaves it inactive on registration),
			// before any request was sent.
			expect(toolFlips(pi)).toEqual(
				activation === "0.99+" ? [{ step: "session_start", before: false, after: true }] : [],
			);
			// Phase changes did run (the log is not trivially empty).
			expect(pi.setLog.length).toBeGreaterThan(4);
		});

		test(`print/JSON session, Pi ${activation}: never active at any request`, async () => {
			const pi = createPi({ activation, hasUI: false });
			await pi.start();
			await pi.request("idle");
			await pi.togglePlanMode("plan mode on");
			await pi.request("planning turn");
			await pi.togglePlanMode("plan mode off");
			await pi.request("idle again");
			await pi.reload();
			await pi.request("after reload");

			expect(pi.requests.filter((request) => request.active)).toEqual([]);
			// Pi before 0.99 activates it on registration, on startup and again on
			// /reload; each new instance takes it out at its session_start, before
			// that session's first request. Nothing else ever touches it.
			expect(toolFlips(pi)).toEqual(
				activation === "pre-0.99"
					? [
							{ step: "session_start", before: true, after: false },
							{ step: "reload", before: true, after: false },
						]
					: [],
			);
		});
	}

	test("registered once per extension instance, exactly as the shared contract defines it", async () => {
		const pi = createPi({ activation: "0.99+", hasUI: true });
		await runLifecycle(pi);

		// Two instances: startup and the reload.
		const mine = pi.registrations.filter((tool) => tool.name === TOOL);
		expect(mine).toHaveLength(2);
		for (const tool of mine) {
			expect(tool.description).toBe(PLANNOTATOR_TOOL_DESCRIPTION);
			expect(tool.parameters).toBe(PLANNOTATOR_TOOL_INPUT_SCHEMA);
			expect(tool.defaultActive).toBe(false);
		}
		// Pi folds promptSnippet/promptGuidelines into the system prompt; no
		// Plannotator tool may add to it.
		for (const tool of pi.registrations) {
			expect([tool.name, "promptSnippet" in tool, "promptGuidelines" in tool]).toEqual([tool.name, false, false]);
		}
	});

	test("before_agent_start never returns a systemPrompt", async () => {
		const pi = createPi({ activation: "pre-0.99", hasUI: true });
		await runLifecycle(pi);
		const results = pi.beforeAgentStartResults.filter((result) => result !== undefined);
		// Framing messages were delivered, so the handler did return something.
		expect(results.length).toBeGreaterThan(0);
		for (const result of results) expect(Object.keys(result as object)).not.toContain("systemPrompt");
	});

	// Off is the default on Pi (owner's call), and the env var turns it off
	// over a config.json that turned it on.
	for (const [label, env] of [["unset (the Pi default)", undefined], ["PLANNOTATOR_AGENT_TOOL=0", "0"]] as const) {
		test(`the agent tool off, ${label}: never registered, never active, plan mode unaffected`, async () => {
			if (env === undefined) delete process.env.PLANNOTATOR_AGENT_TOOL;
			else process.env.PLANNOTATOR_AGENT_TOOL = env;
			const pi = createPi({ activation: "pre-0.99", hasUI: true });
			await runLifecycle(pi);

			expect(pi.registrations.map((tool) => tool.name)).not.toContain(TOOL);
			expect(pi.requests.filter((request) => request.active)).toEqual([]);
			expect(pi.registrations.map((tool) => tool.name)).toContain("plannotator_submit_plan");
		});
	}

	// Oh My Pi lists an extension tool as one short line, so the tool is on by
	// default there (owner's call 2026-10-12), with the same lifecycle as Pi.
	test("Oh My Pi, nothing set: registered and active at every request, never moved after the start", async () => {
		delete process.env.PLANNOTATOR_AGENT_TOOL;
		const pi = createPi({ activation: "0.99+", hasUI: true, ohMyPi: true });
		await runLifecycle(pi);

		expect(pi.registrations.filter((tool) => tool.name === TOOL)).toHaveLength(2);
		expect(pi.requests.filter((request) => !request.active)).toEqual([]);
		expect(toolFlips(pi)).toEqual([{ step: "session_start", before: false, after: true }]);
	});

	for (const [label, setup] of [
		["PLANNOTATOR_AGENT_TOOL=0", () => (process.env.PLANNOTATOR_AGENT_TOOL = "0")],
		[
			'config.json { "agentTool": false }',
			() => {
				delete process.env.PLANNOTATOR_AGENT_TOOL;
				const dataDir = makeTempDir("plannotator-tool-stability-data-");
				writeFileSync(join(dataDir, "config.json"), JSON.stringify({ agentTool: false }));
				process.env.PLANNOTATOR_DATA_DIR = dataDir;
			},
		],
	] as const) {
		test(`Oh My Pi, ${label}: never registered, never active`, async () => {
			setup();
			const pi = createPi({ activation: "pre-0.99", hasUI: true, ohMyPi: true });
			await runLifecycle(pi);

			expect(pi.registrations.map((tool) => tool.name)).not.toContain(TOOL);
			expect(pi.requests.filter((request) => request.active)).toEqual([]);
		});
	}
});
