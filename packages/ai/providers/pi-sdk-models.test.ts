import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiSDKNodeProvider } from "./pi-sdk-node.ts";
import { PiSDKProvider } from "./pi-sdk.ts";

/**
 * A stand-in for `pi --mode rpc`. It answers the commands a model-discovery
 * probe and a session startup send, and appends every command it receives to a
 * log file so a test can assert the order and content of what the provider
 * sent. `provider-a` and `provider-b` share a display name to cover the label
 * fix; the three rows carry different `reasoning` / `thinkingLevelMap` shapes so
 * the thinking-level derivation is exercised, not just read.
 */
const FAKE_PI = `
import { appendFileSync } from "node:fs";

const LOG = __LOG_PATH__;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    appendFileSync(LOG, JSON.stringify(message) + "\\n");

    const respond = (data) =>
      process.stdout.write(
        JSON.stringify({ type: "response", id: message.id, success: true, ...(data ? { data } : {}) }) + "\\n",
      );

    switch (message.type) {
      case "get_available_models":
        respond({
          models: [
            {
              provider: "provider-a",
              id: "shared-model",
              name: "Shared name",
              reasoning: true,
              thinkingLevelMap: {
                off: null,
                minimal: "low",
                low: "low",
                medium: "medium",
                high: "high",
                xhigh: "xhigh",
                max: null,
              },
            },
            { provider: "provider-b", id: "shared-model", name: "Shared name", reasoning: true },
            { provider: "provider-c", id: "other-model", name: "Another name", reasoning: false },
          ],
        });
        break;
      case "get_state":
        respond({ sessionId: "fake-session" });
        break;
      case "prompt":
        respond();
        process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
        break;
      default:
        respond();
    }
  }
});
`;

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function createFakePi(): { dir: string; executable: string; logPath: string } {
	const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-models-"));
	const logPath = join(dir, "commands.jsonl");
	const source = join(dir, "fake-pi.mjs");
	writeFileSync(source, FAKE_PI.replace("__LOG_PATH__", JSON.stringify(logPath)));

	if (process.platform === "win32") {
		const executable = join(dir, "fake-pi.cmd");
		writeFileSync(
			executable,
			`@echo off\r\n"${process.execPath}" "%~dp0fake-pi.mjs" %*\r\n`,
		);
		return { dir, executable, logPath };
	}

	const executable = join(dir, "fake-pi");
	writeFileSync(
		executable,
		`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(source)} "$@"\n`,
	);
	chmodSync(executable, 0o755);
	return { dir, executable, logPath };
}

function sentCommands(logPath: string): Array<Record<string, unknown>> {
	return readFileSync(logPath, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

const expectedModels = [
	{
		id: "provider-a/shared-model",
		label: "provider-a/shared-model",
		default: true,
		reasoningEfforts: [
			{ id: "minimal", label: "Minimal" },
			{ id: "low", label: "Low" },
			{ id: "medium", label: "Medium" },
			{ id: "high", label: "High" },
			{ id: "xhigh", label: "XHigh" },
		],
		defaultReasoningEffort: "medium",
	},
	{
		id: "provider-b/shared-model",
		label: "provider-b/shared-model",
		reasoningEfforts: [
			{ id: "off", label: "Off" },
			{ id: "minimal", label: "Minimal" },
			{ id: "low", label: "Low" },
			{ id: "medium", label: "Medium" },
			{ id: "high", label: "High" },
		],
		defaultReasoningEffort: "medium",
	},
	{ id: "provider-c/other-model", label: "provider-c/other-model" },
];

for (const [runtime, Provider] of [
	["Bun", PiSDKProvider],
	["Node", PiSDKNodeProvider],
] as const) {
	test(`${runtime} Pi discovery uses canonical labels and per-model thinking levels`, async () => {
		const { dir, executable } = createFakePi();
		const provider = new Provider({
			type: "pi-sdk",
			cwd: dir,
			piExecutablePath: executable,
		});

		try {
			await provider.fetchModels();
			expect(provider.models).toEqual(expectedModels);
		} finally {
			provider.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test(`${runtime} Pi session applies the selected thinking level after the model`, async () => {
		const { dir, executable, logPath } = createFakePi();
		const provider = new Provider({
			type: "pi-sdk",
			cwd: dir,
			piExecutablePath: executable,
		});

		try {
			const session = await provider.createSession({
				context: { mode: "code-review", review: { patch: "" } },
				model: "provider-a/shared-model",
				reasoningEffort: "low",
			});
			for await (const _message of session.query("hello")) {
				// Drain the turn; the fake ends it with `agent_end`.
			}

			const commands = sentCommands(logPath);
			const modelIndex = commands.findIndex((c) => c.type === "set_model");
			const levelIndex = commands.findIndex((c) => c.type === "set_thinking_level");
			expect(commands[modelIndex]).toMatchObject({
				type: "set_model",
				provider: "provider-a",
				modelId: "shared-model",
			});
			expect(commands[levelIndex]).toMatchObject({ type: "set_thinking_level", level: "low" });
			// The levels a model accepts depend on the model, so the level must
			// be set after the model, never before it.
			expect(levelIndex).toBeGreaterThan(modelIndex);
		} finally {
			provider.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test(`${runtime} Pi session leaves the thinking level alone when none was chosen`, async () => {
		const { dir, executable, logPath } = createFakePi();
		const provider = new Provider({
			type: "pi-sdk",
			cwd: dir,
			piExecutablePath: executable,
		});

		try {
			const session = await provider.createSession({
				context: { mode: "code-review", review: { patch: "" } },
				model: "provider-a/shared-model",
			});
			for await (const _message of session.query("hello")) {
				// Drain the turn; the fake ends it with `agent_end`.
			}

			// Pi keeps its own configured default when Ask AI sends no level.
			expect(sentCommands(logPath).some((c) => c.type === "set_thinking_level")).toBe(false);
		} finally {
			provider.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
