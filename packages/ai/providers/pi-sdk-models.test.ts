import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiSDKNodeProvider } from "./pi-sdk-node.ts";
import { PiSDKProvider } from "./pi-sdk.ts";

/**
 * A stand-in for `pi`. `--version` prints the version the test baked in;
 * `--mode rpc` answers the commands a model-discovery probe and a session
 * startup send, and appends every command it receives to a log file so a test
 * can assert the order and content of what the provider sent. The rows carry
 * different `reasoning` / `thinkingLevelMap` shapes so the per-model level
 * derivation is exercised end to end, and two providers share a display name
 * to cover the label format.
 */
const FAKE_PI = `
import { appendFileSync } from "node:fs";

const LOG = __LOG_PATH__;
if (process.argv.includes("--version")) {
  process.stdout.write(__VERSION__ + "\\n");
  process.exit(0);
}
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
              thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh", max: "max" },
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

function createFakePi(version: string): { dir: string; executable: string; logPath: string } {
	const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-models-"));
	const logPath = join(dir, "commands.jsonl");
	writeFileSync(logPath, "");
	const source = join(dir, "fake-pi.mjs");
	writeFileSync(
		source,
		FAKE_PI.replace("__LOG_PATH__", JSON.stringify(logPath)).replace("__VERSION__", JSON.stringify(version)),
	);

	if (process.platform === "win32") {
		const executable = join(dir, "fake-pi.cmd");
		writeFileSync(executable, `@echo off\r\n"${process.execPath}" "%~dp0fake-pi.mjs" %*\r\n`);
		return { dir, executable, logPath };
	}

	const executable = join(dir, "fake-pi");
	writeFileSync(executable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(source)} "$@"\n`);
	chmodSync(executable, 0o755);
	return { dir, executable, logPath };
}

function sentCommands(logPath: string): Array<Record<string, unknown>> {
	return readFileSync(logPath, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

const SESSION_SCOPED = "0.85.1";
const PERSISTS_GLOBALLY = "0.84.2";

for (const [runtime, Provider] of [
	["Bun", PiSDKProvider],
	["Node", PiSDKNodeProvider],
] as const) {
	async function withProvider(
		version: string,
		run: (provider: InstanceType<typeof Provider>, logPath: string) => Promise<void>,
	): Promise<void> {
		const { dir, executable, logPath } = createFakePi(version);
		const provider = new Provider({ type: "pi-sdk", cwd: dir, piExecutablePath: executable });
		try {
			await run(provider, logPath);
		} finally {
			provider.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	}

	async function ask(provider: InstanceType<typeof Provider>, reasoningEffort?: string): Promise<void> {
		const session = await provider.createSession({
			context: { mode: "code-review", review: { patch: "" } },
			model: "provider-a/shared-model",
			...(reasoningEffort ? { reasoningEffort } : {}),
		});
		for await (const _message of session.query("hello")) {
			// Drain the turn; the fake ends it with `agent_end`.
		}
	}

	test(`${runtime}: discovery lists each model's own levels and "Name (provider)" labels`, async () => {
		await withProvider(SESSION_SCOPED, async (provider) => {
			await provider.fetchModels();
			expect(provider.toolVersion).toBe(SESSION_SCOPED);
			expect(provider.models).toEqual([
				{
					id: "provider-a/shared-model",
					label: "Shared name (provider-a)",
					default: true,
					// `off` nulled by the map; xhigh and max named by it.
					reasoningEfforts: [
						{ id: "minimal", label: "Minimal" },
						{ id: "low", label: "Low" },
						{ id: "medium", label: "Medium" },
						{ id: "high", label: "High" },
						{ id: "xhigh", label: "XHigh" },
						{ id: "max", label: "Max" },
					],
				},
				{
					id: "provider-b/shared-model",
					label: "Shared name (provider-b)",
					// No map: off..high, never xhigh/max.
					reasoningEfforts: [
						{ id: "off", label: "Off" },
						{ id: "minimal", label: "Minimal" },
						{ id: "low", label: "Low" },
						{ id: "medium", label: "Medium" },
						{ id: "high", label: "High" },
					],
				},
				{ id: "provider-c/other-model", label: "Another name (provider-c)" },
			]);
		});
	});

	test(`${runtime}: a picked level is sent after set_model`, async () => {
		await withProvider(SESSION_SCOPED, async (provider, logPath) => {
			await ask(provider, "max");
			const commands = sentCommands(logPath);
			const modelIndex = commands.findIndex((c) => c.type === "set_model");
			const levelIndex = commands.findIndex((c) => c.type === "set_thinking_level");
			expect(commands[modelIndex]).toMatchObject({ provider: "provider-a", modelId: "shared-model" });
			expect(commands[levelIndex]).toMatchObject({ level: "max" });
			// The levels a model accepts depend on the model, so the level must
			// follow the model, never precede it.
			expect(levelIndex).toBeGreaterThan(modelIndex);
		});
	});

	test(`${runtime}: Auto sends no level, leaving pi's own default`, async () => {
		await withProvider(SESSION_SCOPED, async (provider, logPath) => {
			await ask(provider);
			expect(sentCommands(logPath).some((c) => c.type === "set_thinking_level")).toBe(false);
		});
	});

	test(`${runtime}: a pi that persists set_thinking_level globally is offered no levels and sent none`, async () => {
		await withProvider(PERSISTS_GLOBALLY, async (provider, logPath) => {
			await provider.fetchModels();
			expect(provider.models?.length).toBe(3);
			expect(provider.models?.some((m) => m.reasoningEfforts)).toBe(false);
			// A level that arrives anyway (e.g. a pick made against another
			// server) must still not reach pi's settings.
			await ask(provider, "high");
			expect(sentCommands(logPath).some((c) => c.type === "set_thinking_level")).toBe(false);
		});
	});
}
