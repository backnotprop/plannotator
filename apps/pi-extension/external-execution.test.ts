import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator from "./index.ts";
import { PLANNOTATOR_PLAN_APPROVED_CHANNEL } from "./plannotator-events.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("external plan execution", () => {
	test("hands off an approved --plan session and restores its original state", async () => {
		const cwd = makeTempDir("plannotator-external-execution-");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "plannotator.json"), JSON.stringify({
			executionMode: "external",
			phases: {
				planning: {
					model: { provider: "test", id: "planning-model" },
					thinking: "high",
				},
			},
		}));
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [ ] Implement the change\n");

		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const emitted: Array<{ channel: string; payload: unknown }> = [];
		const entries: Array<{ type: string; data: unknown }> = [];
		const sentUserMessages: unknown[] = [];
		let activeTools = ["read", "bash", "edit", "write"];
		let thinkingLevel = "medium";
		let selectedModel = { provider: "test", id: "original-model" };

		const pi = {
			events: {
				on: () => undefined,
				emit: (channel: string, payload: unknown) => emitted.push({ channel, payload }),
			},
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				const eventHandlers = handlers.get(event) ?? [];
				eventHandlers.push(handler);
				handlers.set(event, eventHandlers);
			},
			registerFlag: () => undefined,
			registerShortcut: () => undefined,
			registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool),
			getFlag: () => true,
			getActiveTools: () => [...activeTools],
			setActiveTools: (tools: string[]) => { activeTools = [...tools]; },
			getThinkingLevel: () => thinkingLevel,
			setThinkingLevel: (level: string) => { thinkingLevel = level; },
			setModel: async (model: { provider: string; id: string }) => {
				selectedModel = model;
				return true;
			},
			appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
			sendMessage: () => undefined,
			sendUserMessage: (message: unknown) => sentUserMessages.push(message),
		};
		const ctx = {
			cwd,
			hasUI: false,
			model: { provider: "test", id: "original-model" },
			modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
			sessionManager: {
				getEntries: () => [],
				getSessionId: () => "test-session",
				getSessionFile: () => null,
				getSessionName: () => undefined,
			},
			ui: {
				notify: () => undefined,
				setStatus: () => undefined,
				setWidget: () => undefined,
				theme: { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text },
			},
		};

		plannotator(pi as never);
		for (const handler of handlers.get("session_start") ?? []) {
			await handler({ reason: "startup" }, ctx);
		}
		const result = await tools.get("plannotator_submit_plan")!.execute("call-1", { filePath: "PLAN.md" }, undefined, undefined, ctx) as {
			details: { approved: boolean; handedOff?: boolean };
			terminate?: boolean;
		};

		expect(result.details).toEqual({ approved: true, handedOff: true });
		expect(result.terminate).toBe(true);
		expect(emitted).toContainEqual({
			channel: PLANNOTATOR_PLAN_APPROVED_CHANNEL,
			payload: {
				cwd,
				planFilePath: "PLAN.md",
				planContent: "# Plan\n\n- [ ] Implement the change\n",
			},
		});
		for (const handler of handlers.get("agent_end") ?? []) {
			await handler({ messages: [] }, ctx);
		}
		expect(entries.some((entry) => entry.type === "plannotator-execute")).toBe(false);
		expect(entries).toContainEqual({ type: "plannotator-handoff", data: { planFilePath: "PLAN.md" } });
		expect(sentUserMessages).toEqual([]);
		expect(activeTools).toEqual(["read", "bash", "edit", "write"]);
		expect(thinkingLevel).toBe("medium");
		expect(selectedModel).toEqual({ provider: "test", id: "original-model" });
	});
});
