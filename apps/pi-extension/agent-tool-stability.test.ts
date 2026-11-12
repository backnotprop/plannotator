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

type PiActivation = "pre-0.99" | "0.99+";

type ToolDefinition = Record<string, unknown> & { name: string; execute: (...args: unknown[]) => Promise<any> };

function createPi(options: { activation: PiActivation; hasUI: boolean; ohMyPi?: boolean }) {
	const cwd = makeTempDir("plannotator-tool-stability-");
	const home = makeTempDir("plannotator-tool-stability-home-");
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
	writeFileSync(join(cwd, "PLAN.md"), PLAN);

	const state = { activeTools: [...PI_DEFAULT_TOOLS] };
	const registrations: ToolDefinition[] = [];
	const setLog: Array<{ step: string; before: boolean; after: boolean }> = [];
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

	function load(previousActive: string[] | null): void {
		handlers = new Map();
		tools = new Map();
		commands = new Map();
		const loaded: ToolDefinition[] = [];
		const pi = {
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
	await pi.agentEnd("agent_end after approval");
	await pi.agentEnd("agent_end complete");
	expect(pi.lastPhase()).toBe("idle");
	await pi.request("idle after completion");

	await pi.togglePlanMode("plan mode on again");
	await pi.request("second planning turn");
	await pi.togglePlanMode("plan mode off mid-plan");
	expect(pi.lastPhase()).toBe("idle");
	await pi.request("idle after leaving plan mode");

	await pi.togglePlanMode("plan mode on for tree");
	await pi.tree();
	await pi.request("after tree");
	await pi.reload();
	await pi.request("after reload");
}

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
			expect(toolFlips(pi)).toEqual(
				activation === "0.99+" ? [{ step: "session_start", before: false, after: true }] : [],
			);
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

		const mine = pi.registrations.filter((tool) => tool.name === TOOL);
		expect(mine).toHaveLength(2);
		for (const tool of mine) {
			expect(tool.description).toBe(PLANNOTATOR_TOOL_DESCRIPTION);
			expect(tool.parameters).toBe(PLANNOTATOR_TOOL_INPUT_SCHEMA);
			expect(tool.defaultActive).toBe(false);
		}
		for (const tool of pi.registrations) {
			expect([tool.name, "promptSnippet" in tool, "promptGuidelines" in tool]).toEqual([tool.name, false, false]);
		}
	});

	test("before_agent_start never returns a systemPrompt", async () => {
		const pi = createPi({ activation: "pre-0.99", hasUI: true });
		await runLifecycle(pi);
		const results = pi.beforeAgentStartResults.filter((result) => result !== undefined);
		expect(results.length).toBeGreaterThan(0);
		for (const result of results) expect(Object.keys(result as object)).not.toContain("systemPrompt");
	});

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
