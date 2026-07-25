import { describe, expect, test } from "bun:test";
import plannotator from "./index.ts";

type Handler = (event: unknown, context: ReturnType<typeof createContext>) => unknown;

function createContext() {
	return {
		cwd: process.cwd(),
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

function createRuntime(initialTools: string[]) {
	const commands = new Map<string, { handler: (args: string, context: ReturnType<typeof createContext>) => unknown }>();
	const handlers = new Map<string, Handler[]>();
	let activeTools = [...initialTools];

	const pi = {
		appendEntry: () => undefined,
		events: { on: () => () => undefined },
		getActiveTools: () => [...activeTools],
		getFlag: () => false,
		getThinkingLevel: () => "medium",
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, command: { handler: (args: string, context: ReturnType<typeof createContext>) => unknown }) => {
			commands.set(name, command);
		},
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerTool: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
		setActiveTools: (tools: string[]) => {
			activeTools = [...tools];
		},
		setModel: async () => true,
		setThinkingLevel: () => undefined,
	};

	plannotator(pi as never);

	return {
		commands,
		getActiveTools: () => activeTools,
		run: async (event: string, context: ReturnType<typeof createContext>) => {
			for (const handler of handlers.get(event) ?? []) await handler({}, context);
		},
		setActiveTools: (tools: string[]) => {
			activeTools = [...tools];
		},
	};
}

describe("Plannotator phase tool ownership", () => {
	test("leaving planning removes only tools Plannotator added", async () => {
		const runtime = createRuntime([
			"inspect",
			"search",
			"plannotator_submit_plan",
		]);
		const context = createContext();
		await runtime.run("session_start", context);
		expect(runtime.getActiveTools()).toEqual(["inspect", "search"]);

		await runtime.commands.get("plannotator")?.handler("", context);
		expect(runtime.getActiveTools()).toEqual([
			"inspect",
			"search",
			"plannotator_submit_plan",
		]);

		runtime.setActiveTools(["search", "external_new", "plannotator_submit_plan"]);
		await runtime.commands.get("plannotator")?.handler("", context);
		expect(runtime.getActiveTools()).toEqual(["search", "external_new"]);
	});
});
