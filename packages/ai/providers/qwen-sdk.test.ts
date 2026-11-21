/**
 * The Qwen Code Ask AI provider against a fake `qwen`
 * (tests/test-fixtures/fake-qwen-cli.ts). No real Qwen Code runs, and
 * QWEN_HOME always points into a temp folder.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeQwenCli, fakeQwenRuns } from "../../../tests/test-fixtures/fake-qwen-cli.ts";
import type { AIMessage, AISession } from "../types.ts";
import { QWEN_ASK_AI_SESSION_PREFIX, QwenSDKProvider, qwenHomeDir } from "./qwen-sdk.ts";

const tempDirs: string[] = [];
const providers: QwenSDKProvider[] = [];
const fakes: Array<{ log: string; script: string }> = [];
const savedQwenHome = process.env.QWEN_HOME;

afterEach(() => {
	if (savedQwenHome === undefined) delete process.env.QWEN_HOME;
	else process.env.QWEN_HOME = savedQwenHome;
	for (const provider of providers.splice(0)) provider.dispose();
	// No fake qwen outlives its test: kill a run this test started only while
	// its pid still runs this test's fake script (a pid can be reused).
	for (const fake of fakes.splice(0)) {
		for (const run of fakeQwenRuns(fake.log)) {
			const ps = spawnSync("ps", ["-o", "command=", "-p", String(run.pid)], { env: process.env, encoding: "utf8" });
			if (ps.status !== 0 || !ps.stdout.includes(fake.script)) continue;
			try {
				process.kill(run.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "plannotator-qwen-sdk-"));
	tempDirs.push(dir);
	process.env.QWEN_HOME = join(dir, "qwen-home");
	const fake = fakeQwenCli(dir);
	const provider = new QwenSDKProvider({ type: "qwen-sdk", cwd: dir, qwenExecutablePath: fake.bin });
	providers.push(provider);
	fakes.push({ log: fake.log, script: fake.script });
	return { dir, fake, provider };
}

async function newSession(provider: QwenSDKProvider, model?: string): Promise<AISession> {
	return provider.createSession({
		context: { mode: "plan-review", plan: { plan: "# The plan under review" } },
		...(model ? { model } : {}),
	});
}

async function ask(session: AISession, prompt: string): Promise<AIMessage[]> {
	const out: AIMessage[] = [];
	for await (const msg of session.query(prompt)) out.push(msg);
	return out;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const posix = process.platform !== "win32";

describe("QwenSDKProvider", () => {
	test.if(posix)("the first question starts a plan-mode qwen session with the write tools off and the context on stdin; the next continues it", async () => {
		const { fake, provider } = setup();
		const session = await newSession(provider, "qwen3-coder-plus");

		const first = await ask(session, "What does step 2 do?");
		expect(first.filter((m) => m.type === "text_delta").map((m) => (m as { delta: string }).delta).join("")).toBe("pong");
		expect(first.at(-1)).toMatchObject({ type: "result", success: true, result: "pong", sessionId: session.id });
		expect(first.some((m) => m.type === "error")).toBe(false);

		const second = await ask(session, "And step 3?");
		expect(second.at(-1)).toMatchObject({ type: "result", success: true });

		const [run1, run2] = fakeQwenRuns(fake.log);
		const qwenId = run1!.args[1]!;
		// Marked as an Ask AI chat, so `plannotator last` can skip it.
		expect(qwenId.startsWith(QWEN_ASK_AI_SESSION_PREFIX)).toBe(true);
		expect(qwenId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		const rest = [
			"--output-format", "stream-json", "--include-partial-messages",
			"--approval-mode", "plan",
			// Plan mode alone runs a write tool the user's settings auto-approve.
			"--exclude-tools=exit_plan_mode,edit,write_file,notebook_edit,save_memory,manage_memory,enter_worktree,exit_worktree",
			"--max-wall-time", "10m",
			"--model", "qwen3-coder-plus",
		];
		expect(run1!.args).toEqual(["--session-id", qwenId, ...rest]);
		expect(run2!.args).toEqual(["--resume", qwenId, ...rest]);
		// The review context goes with the first question only, and on stdin.
		expect(run1!.stdin).toContain("# The plan under review");
		expect(run1!.stdin).toContain("What does step 2 do?");
		expect(run1!.args.join(" ")).not.toContain("step 2");
		expect(run2!.stdin).not.toContain("# The plan under review");
		expect(run2!.stdin).toContain("And step 3?");
	});

	// The Inbox MCP server Plannotator adds to Qwen's settings.json inherits
	// Qwen's env: with the marker it lists no tools, so an Ask AI question can
	// never post to the person's Inbox.
	test.if(posix)("every qwen run starts with Plannotator's integration off", async () => {
		const { fake, provider } = setup();
		const session = await newSession(provider);
		await ask(session, "What does step 2 do?");
		await ask(session, "And step 3?");
		const runs = fakeQwenRuns(fake.log);
		expect(runs).toHaveLength(2);
		for (const run of runs) {
			expect(run.switches).toEqual({ PLANNOTATOR_ASK_AI_CHILD: "1", PLANNOTATOR_INBOX_TOOL: "0", PLANNOTATOR_AGENT_TOOL: "0" });
		}
	});

	test.if(posix)("a run stopped by qwen's wall-time budget reports it with qwen's stderr", async () => {
		const { fake, provider } = setup();
		fake.setMode("wall-time");
		const messages = await ask(await newSession(provider), "Explain");
		expect(messages).toHaveLength(1);
		const error = messages[0] as { type: string; error: string; code: string };
		expect(error.type).toBe("error");
		expect(error.code).toBe("qwen_process_exit");
		expect(error.error).toContain("longer than 10m");
		expect(error.error).toContain("Run exceeded --max-wall-time");
	});

	test.if(posix)("a first question that got no answer is retried as a new qwen session, not a resume", async () => {
		const { fake, provider } = setup();
		const session = await newSession(provider);
		// Even with Qwen's "No saved session found" on stderr: a first question
		// has no session to lose, so it is not asked again in the same query.
		fake.setMode("no-session");
		const failed = await ask(session, "First try");
		expect(failed[0]).toMatchObject({ type: "error", code: "qwen_process_exit" });
		expect((failed[0] as { error: string }).error).toContain("exited with code 1");
		// A failing first question runs once: there is no saved session to miss.
		expect(fakeQwenRuns(fake.log)).toHaveLength(1);

		fake.setMode("answer");
		const retried = await ask(session, "Second try");
		expect(retried.at(-1)).toMatchObject({ type: "result", success: true });

		const [run1, run2] = fakeQwenRuns(fake.log);
		expect(run1!.args[0]).toBe("--session-id");
		expect(run2!.args[0]).toBe("--session-id");
		expect(run2!.args[1]).not.toBe(run1!.args[1]);
		// The retry still carries the review context: no conversation holds it yet.
		expect(run2!.stdin).toContain("# The plan under review");
	});

	test.if(posix)("abort stops the running qwen and ends the question without an error", async () => {
		const { fake, provider } = setup();
		fake.setMode("hang");
		const session = await newSession(provider);
		const pending = ask(session, "Long question");
		let run = fakeQwenRuns(fake.log)[0];
		for (let i = 0; i < 100 && !run; i++) {
			await Bun.sleep(20);
			run = fakeQwenRuns(fake.log)[0];
		}
		expect(run).toBeDefined();
		session.abort();
		const messages = await pending;
		expect(messages.some((m) => m.type === "error")).toBe(false);
		let alive = pidAlive(run!.pid);
		for (let i = 0; i < 100 && alive; i++) {
			await Bun.sleep(20);
			alive = pidAlive(run!.pid);
		}
		expect(alive).toBe(false);
	});

	test.if(posix)("a follow-up whose saved session is gone starts a new session with the context and still answers", async () => {
		const { fake, provider } = setup();
		const session = await newSession(provider);
		await ask(session, "First");
		fake.setMode("resume-fails");
		const second = await ask(session, "Second");
		expect(second.some((m) => m.type === "error")).toBe(false);
		expect(second.at(-1)).toMatchObject({ type: "result", success: true, result: "pong" });

		fake.setMode("answer");
		await ask(session, "Third");
		const [run1, run2, run3, run4] = fakeQwenRuns(fake.log);
		expect(run2!.args.slice(0, 2)).toEqual(["--resume", run1!.args[1]]);
		expect(run3!.args[0]).toBe("--session-id");
		expect(run3!.args[1]).not.toBe(run1!.args[1]);
		expect(run3!.args[1]!.startsWith(QWEN_ASK_AI_SESSION_PREFIX)).toBe(true);
		expect(run3!.stdin).toContain("# The plan under review");
		expect(run3!.stdin).toContain("Second");
		// Later questions continue the new session.
		expect(run4!.args.slice(0, 2)).toEqual(["--resume", run3!.args[1]]);
		expect(run4!.stdin).not.toContain("# The plan under review");
	});

	test.if(posix)("a follow-up that fails at startup for another reason shows the error and keeps the conversation", async () => {
		const { fake, provider } = setup();
		const session = await newSession(provider);
		await ask(session, "First");
		fake.setMode("resume-startup-fails");
		const failed = await ask(session, "Second");
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({ type: "error", code: "qwen_process_exit" });
		expect((failed[0] as { error: string }).error).toContain("authentication failed");
		fake.setMode("answer");
		await ask(session, "Third");
		const runs = fakeQwenRuns(fake.log);
		// Not asked again as a new session, and the next question resumes the same one.
		expect(runs).toHaveLength(3);
		expect(runs[1]!.args.slice(0, 2)).toEqual(["--resume", runs[0]!.args[1]]);
		expect(runs[2]!.args.slice(0, 2)).toEqual(["--resume", runs[0]!.args[1]]);
		expect(runs[2]!.stdin).not.toContain("# The plan under review");
	});

	test.if(posix)("a follow-up that fails another way keeps the conversation for the next question", async () => {
		const { fake, provider } = setup();
		const session = await newSession(provider);
		await ask(session, "First");
		fake.setMode("wall-time");
		const failed = await ask(session, "Second");
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({ type: "error", code: "qwen_process_exit" });
		fake.setMode("answer");
		await ask(session, "Third");
		const runs = fakeQwenRuns(fake.log);
		// No retry of the timed-out run, and the same conversation afterwards.
		expect(runs).toHaveLength(3);
		expect(runs[2]!.args.slice(0, 2)).toEqual(["--resume", runs[0]!.args[1]]);
	});

	test.if(posix)("the next question waits up to 5 s for a qwen still running after its answer, then stops it", async () => {
		const { fake, provider } = setup();
		const session = await newSession(provider);
		fake.setMode("linger");
		await ask(session, "First");
		const answeredAt = Date.now();
		fake.setMode("answer");
		await ask(session, "Second");
		const [run1, run2] = fakeQwenRuns(fake.log);
		expect(run2!.at - answeredAt).toBeGreaterThanOrEqual(4_500);
		let alive = pidAlive(run1!.pid);
		for (let i = 0; i < 100 && alive; i++) {
			await Bun.sleep(20);
			alive = pidAlive(run1!.pid);
		}
		expect(alive).toBe(false);
	}, 15_000);

	test.if(posix)("Stop during that wait ends the question at once and starts no run", async () => {
		const { fake, provider } = setup();
		const session = await newSession(provider);
		fake.setMode("linger");
		await ask(session, "First");
		const pending = ask(session, "Second");
		await Bun.sleep(200);
		const stoppedAt = Date.now();
		session.abort();
		const messages = await pending;
		expect(Date.now() - stoppedAt).toBeLessThan(2_000);
		expect(messages).toEqual([]);
		expect(fakeQwenRuns(fake.log)).toHaveLength(1);
	}, 15_000);

	test("a qwen that cannot be started is reported, not thrown", async () => {
		const { dir } = setup();
		const provider = new QwenSDKProvider({ type: "qwen-sdk", cwd: dir, qwenExecutablePath: join(dir, "no-such-qwen") });
		const messages = await ask(await newSession(provider), "Hello");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ type: "error", code: "qwen_process_exit" });
		expect((messages[0] as { error: string }).error).toContain("Qwen Code could not run");
	});

	test("models come from $QWEN_HOME/settings.json (comments allowed) without running qwen", async () => {
		const { dir, fake, provider } = setup();
		const home = process.env.QWEN_HOME!;
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(home, "settings.json"),
			`{
  // Qwen Code accepts comments here.
  "model": { "name": "qwen3-coder-plus" },
  "modelProviders": {
    "openai": [
      { "id": "qwen3-coder-plus", "name": "Qwen3 Coder Plus" },
      { "id": "gpt-local", "name": "Local model" },
    ],
  },
}`,
		);
		await provider.fetchModels();
		expect(provider.models).toEqual([
			{ id: "qwen3-coder-plus", label: "Qwen3 Coder Plus", default: true },
			{ id: "gpt-local", label: "Local model" },
		]);
		expect(fakeQwenRuns(fake.log)).toHaveLength(0);

		rmSync(join(home, "settings.json"));
		const empty = new QwenSDKProvider({ type: "qwen-sdk", cwd: dir });
		await empty.fetchModels();
		expect(empty.models).toBeUndefined();
	});

	test("qwenHomeDir follows qwen: $QWEN_HOME with ~ expanded and relative paths from cwd, else ~/.qwen", () => {
		const home = join(tmpdir(), "home-x");
		const cwd = join(tmpdir(), "project-y");
		expect(qwenHomeDir({}, home, cwd)).toBe(join(home, ".qwen"));
		expect(qwenHomeDir({ QWEN_HOME: "  " }, home, cwd)).toBe(join(home, ".qwen"));
		expect(qwenHomeDir({ QWEN_HOME: "~/qh" }, home, cwd)).toBe(join(home, "qh"));
		expect(qwenHomeDir({ QWEN_HOME: "rel/qh" }, home, cwd)).toBe(join(cwd, "rel", "qh"));
		expect(qwenHomeDir({ QWEN_HOME: join(tmpdir(), "abs") }, home, cwd)).toBe(join(tmpdir(), "abs"));
	});
});
