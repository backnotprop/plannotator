/**
 * "Ask this session" in Oh My Pi (#1814), proved on the REAL `omp` binary:
 * OMP loads this extension from source with `-e` (it loads Pi extensions
 * through its legacy-Pi compat layer), runs in RPC mode, and talks to a
 * scripted OpenAI-compatible model (tests/helpers/scripted-model.ts), so no
 * provider is called. The review opens through the extension's own slash
 * command, and Ask AI is driven over the review server's HTTP API exactly as
 * the browser drives it.
 *
 * Opt-in: set PLANNOTATOR_OMP_BIN to an `omp` executable (for example after
 * `bun add @oh-my-pi/pi-coding-agent` in a temp dir:
 * `<dir>/node_modules/.bin/omp`). Everything runs under a temp HOME and a temp
 * OMP agent dir; the person's own ~/.omp and ~/.plannotator are never read.
 * Checked with OMP 18.8.9.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastMessage, startScriptedModel } from "../../tests/helpers/scripted-model.ts";

const ompBin = process.env.PLANNOTATOR_OMP_BIN;
const extensionDir = import.meta.dir;
const ASK_HEADER = "[Plannotator Ask AI]";
const ANSWER = "The doc says 42.";

const stubbed: string[] = [];
afterAll(() => {
	for (const path of stubbed) rmSync(path, { force: true });
});

/** The extension refuses to open without its built HTML; a stub is enough for the API proof. */
function stubHtml(): void {
	for (const name of ["plannotator.html", "review-editor.html"]) {
		const path = join(extensionDir, name);
		if (existsSync(path)) continue;
		writeFileSync(path, "<!doctype html><title>test</title>");
		stubbed.push(path);
	}
}

async function waitFor<T>(what: string, check: () => T | undefined | null | false, ms = 30_000): Promise<T> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = check();
		if (value) return value;
		await Bun.sleep(100);
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!ompBin || process.platform === "win32")("Oh My Pi: Ask this session (the real omp in RPC mode)", () => {
	test("/plannotator-annotate in OMP offers Ask this session, and a question is answered by the OMP session", async () => {
		stubHtml();
		const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-omp-")));
		const home = join(root, "home");
		const agentDir = join(home, ".omp", "agent");
		const project = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(project, { recursive: true });
		writeFileSync(join(project, "notes.md"), "# Notes\n\nThe secret number is 42.\n");

		const model = startScriptedModel((request) =>
			lastMessage(request).text.includes(ASK_HEADER) ? { text: ANSWER } : { text: "OK." },
		);
		writeFileSync(
			join(agentDir, "models.yml"),
			[
				"providers:",
				"  scripted:",
				`    baseUrl: ${model.baseUrl}`,
				"    apiKey: scripted-key",
				"    api: openai-completions",
				"    models:",
				"      - id: scripted",
				"        name: Scripted",
				"        reasoning: false",
				"        input: [text]",
				"        contextWindow: 200000",
				"        maxTokens: 8192",
				"",
			].join("\n"),
		);

		const env: Record<string, string> = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: home,
			PI_CODING_AGENT_DIR: agentDir,
			PLANNOTATOR_DATA_DIR: join(home, ".plannotator"),
			XDG_CONFIG_HOME: join(home, ".config"),
			XDG_CACHE_HOME: join(home, ".cache"),
			XDG_DATA_HOME: join(home, ".local", "share"),
			XDG_STATE_HOME: join(home, ".local", "state"),
			PLANNOTATOR_BROWSER: "/usr/bin/true",
			PLANNOTATOR_GLIMPSE: "0",
		};
		const omp = Bun.spawn(
			[ompBin!, "--mode", "rpc", "--model", "scripted/scripted", "--no-extensions", "-e", extensionDir, "--no-skills", "--no-rules", "--no-title", "--no-lsp", "--session-dir", join(root, "sessions")],
			{ cwd: project, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		const events: Array<Record<string, any>> = [];
		void (async () => {
			let buffered = "";
			for await (const chunk of omp.stdout) {
				buffered += new TextDecoder().decode(chunk);
				let newline: number;
				while ((newline = buffered.indexOf("\n")) >= 0) {
					const line = buffered.slice(0, newline);
					buffered = buffered.slice(newline + 1);
					try {
						events.push(JSON.parse(line));
					} catch {
						// a non-JSON line is not a protocol frame
					}
				}
			}
		})();
		const send = (frame: unknown) => {
			omp.stdin.write(`${JSON.stringify(frame)}\n`);
			omp.stdin.flush();
		};

		try {
			await waitFor("the RPC ready frame", () => events.some((event) => event.type === "ready"));
			send({ id: "open", type: "prompt", message: "/plannotator-annotate notes.md" });
			const url = await waitFor("the review URL in a notification", () => {
				for (const event of events) {
					if (event.type !== "extension_ui_request") continue;
					const match = /http:\/\/(?:localhost|127\.0\.0\.1):\d+/.exec(JSON.stringify(event));
					if (match) return match[0];
				}
				return null;
			});

			const capabilities = await (await fetch(`${url}/api/ai/capabilities`)).json();
			expect(capabilities.defaultProvider).toBe("session-bridge");
			expect(capabilities.providers.map((provider: { id: string }) => provider.id)).toEqual(["session-bridge"]);
			expect(capabilities.providers[0].sessionBridge).toMatchObject({ host: "pi", status: "ready" });

			const session = await (
				await fetch(`${url}/api/ai/session`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ providerId: "session-bridge", context: { mode: "annotate", annotate: { content: "# Notes", filePath: join(project, "notes.md") } } }),
				})
			).json();
			const answer = await (
				await fetch(`${url}/api/ai/query`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId: session.sessionId, prompt: "What number does the doc mention?" }),
				})
			).text();
			// The answer streamed back is the OMP session's own turn: the scripted
			// model only says it to a request that carries Plannotator's question.
			expect(answer).toContain(ANSWER);
			expect(answer).toContain('"success":true');
			// The question entered the OMP session as Plannotator's custom message.
			expect(events.some((event) => event.type === "message_start" && event.message?.customType === "plannotator-ask")).toBe(true);
		} finally {
			omp.stdin.end();
			await Promise.race([omp.exited, Bun.sleep(5_000)]);
			omp.kill(9);
			model.stop();
			rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);
});
