import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import plannotator from "./index.ts";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createContext(cwd: string) {
	return {
		cwd,
		hasUI: false,
		isIdle: () => true,
		model: undefined,
		modelRegistry: { find: () => undefined },
		sessionManager: {
			getEntries: () => [],
			getSessionFile: () => undefined,
			getSessionId: () => "test-session",
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
}

function createRuntime() {
	type Context = ReturnType<typeof createContext>;
	type Handler = (event: unknown, context: Context) => unknown;
	const commands = new Map<string, { handler: (args: string, context: Context) => unknown }>();
	const handlers = new Map<string, Handler[]>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const tools = new Map<string, ToolDefinition>();
	let activeTools = ["inspect", "plannotator_submit_plan"];

	const pi = {
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		events: { on: () => () => undefined },
		getActiveTools: () => [...activeTools],
		getFlag: () => false,
		getThinkingLevel: () => "medium",
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, command: { handler: (args: string, context: Context) => unknown }) => {
			commands.set(name, command);
		},
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
		setActiveTools: (nextTools: string[]) => {
			activeTools = [...nextTools];
		},
		setModel: async () => true,
		setThinkingLevel: () => undefined,
	};

	plannotator(pi as never);

	return {
		commands,
		entries,
		getActiveTools: () => activeTools,
		run: async (event: string, context: Context) => {
			for (const handler of handlers.get(event) ?? []) await handler({}, context);
		},
		tools,
	};
}

describe("plannotator_submit_plan availability", () => {
	test("reviews from idle without starting execution, then keeps planning approval behavior", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "plannotator-submit-any-mode-"));
		tempDirectories.push(cwd);
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [ ] First step\n", "utf8");
		writeFileSync(join(cwd, "SECOND.md"), "# Second plan\n", "utf8");
		const runtime = createRuntime();
		const context = createContext(cwd);
		await runtime.run("session_start", context);
		expect(runtime.getActiveTools()).toContain("plannotator_submit_plan");

		const submitPlan = runtime.tools.get("plannotator_submit_plan");
		expect(submitPlan).toBeDefined();
		const idleResult = await submitPlan!.execute(
			"idle-review",
			{ filePath: "PLAN.md" },
			undefined,
			undefined,
			context as never,
		);
		expect(idleResult.details).toMatchObject({ approved: true });
		expect(runtime.entries.some((entry) => entry.type === "plannotator-execute")).toBe(false);

		await runtime.commands.get("plannotator")?.handler("", context);
		const planningResult = await submitPlan!.execute(
			"planning-review",
			{ filePath: "PLAN.md" },
			undefined,
			undefined,
			context as never,
		);
		expect(planningResult.details).toMatchObject({ approved: true });
		expect(runtime.entries.filter((entry) => entry.type === "plannotator-execute")).toHaveLength(1);

		const executingResult = await submitPlan!.execute(
			"executing-review",
			{ filePath: "SECOND.md" },
			undefined,
			undefined,
			context as never,
		);
		expect(executingResult.details).toMatchObject({ approved: true });
		expect(runtime.entries.filter((entry) => entry.type === "plannotator-execute")).toHaveLength(1);
		const executionEntry = runtime.entries.find((entry) => entry.type === "plannotator-execute");
		expect(executionEntry?.data).toEqual({ lastSubmittedPath: "PLAN.md" });
	});
});
