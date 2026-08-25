/**
 * Test-only child entry for pi-stdio-failure.test.ts (#1378).
 *
 * Runs the Pi Node provider in a REAL `node` process, because that is the
 * runtime under Pi (jiti on Node) and because the whole bug is a Node stream
 * behavior: an `error` event with no listener becomes an `uncaughtException`.
 * Bun's node:child_process / node:stream shims do not reproduce that faithfully,
 * so an in-process `bun test` could pass against code that kills the host in
 * production (the same lesson live-proxy-node.child.ts was created for).
 *
 * This entry deliberately installs NO `uncaughtException` handler: if the
 * provider lets a stream error escape, this process dies and the suite sees a
 * non-zero exit with no result line. Surviving to print the result line IS the
 * "the host stays alive" assertion.
 *
 * Env contract: FAKE_PI (path to the executable fake Pi), FAKE_PI_MODE_FILE
 * (file whose contents select the fake's behavior). Prints one JSON line of
 * results on stdout, then exits 0.
 */

import { writeFileSync } from "node:fs";
import { PiProcessNode, PiSDKNodeProvider } from "./pi-sdk-node.ts";
import type { AIMessage } from "../types.ts";

const fakePi = process.env.FAKE_PI;
const modeFile = process.env.FAKE_PI_MODE_FILE;
if (!fakePi || !modeFile) throw new Error("FAKE_PI and FAKE_PI_MODE_FILE are required");

const cwd = process.cwd();
const setMode = (mode: string) => writeFileSync(modeFile, mode);

/** Resolve once the fake has announced itself on stdout. */
function waitForEvent(
	proc: PiProcessNode,
	type: string,
	timeoutMs = 10_000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			off();
			reject(new Error(`timed out waiting for ${type}`));
		}, timeoutMs);
		const off = proc.onEvent((event) => {
			if (event.type === type) {
				clearTimeout(timer);
				off();
				resolve();
			}
		});
	});
}

async function collect(iter: AsyncIterable<AIMessage>, capMs = 15_000): Promise<AIMessage[]> {
	const out: AIMessage[] = [];
	const deadline = Date.now() + capMs;
	for await (const msg of iter) {
		out.push(msg);
		if (Date.now() > deadline) break;
	}
	return out;
}

const results: Record<string, unknown> = {};

// ---------------------------------------------------------------------------
// 1. A broken stdin pipe rejects the in-flight request and kills nothing else.
// ---------------------------------------------------------------------------
{
	setMode("closed-stdin");
	const proc = new PiProcessNode();
	await proc.spawn(fakePi, cwd);
	// The fake has closed the read end of its stdin by the time it says this,
	// so the very next write hits a pipe with no reader: EPIPE.
	await waitForEvent(proc, "ready_broken");

	let sawProcessExited = false;
	proc.onEvent((event) => {
		if (event.type === "process_exited") sawProcessExited = true;
	});

	try {
		await proc.sendAndWait({ type: "get_state" });
		results.brokenRejected = false;
	} catch (err) {
		results.brokenRejected = true;
		results.brokenMessage = err instanceof Error ? err.message : String(err);
	}
	results.brokenAliveAfter = proc.alive;
	results.brokenSawProcessExited = sawProcessExited;

	// A fire-and-forget send on the already-failed process must not throw either.
	try {
		proc.send({ type: "abort" });
		results.postFailureSendThrew = false;
	} catch {
		results.postFailureSendThrew = true;
	}
	proc.kill();
}

// ---------------------------------------------------------------------------
// 2. The provider is restartable: a fresh process talks normally afterwards.
// ---------------------------------------------------------------------------
{
	setMode("echo");
	const proc = new PiProcessNode();
	await proc.spawn(fakePi, cwd);
	const state = await proc.sendAndWait({ type: "get_state" });
	results.recoveredSessionId = state.sessionId;
	results.recoveredAlive = proc.alive;
	proc.kill();
}

// ---------------------------------------------------------------------------
// 3. End to end through the session: the failure surfaces to the Ask AI UI as
//    an error message, and a later query on the SAME session re-spawns and
//    completes normally.
// ---------------------------------------------------------------------------
{
	// "break-after-first" answers the session's opening get_state and closes its
	// stdin in the same tick, so the prompt write that follows is guaranteed to
	// hit a dead pipe. That is the reported shape: a session that came up fine
	// and then lost the pipe mid-conversation.
	setMode("break-after-first");
	const provider = new PiSDKNodeProvider({ type: "pi-sdk", piExecutablePath: fakePi, cwd });
	const session = await provider.createSession({
		context: { mode: "plan-review", plan: { plan: "# Test plan" } },
		cwd,
	});

	const failed = await collect(session.query("hello"));
	results.sessionFailedMessages = failed.map((m) => ({
		type: m.type,
		code: (m as { code?: string }).code,
	}));

	setMode("echo");
	const recovered = await collect(session.query("hello again"));
	results.sessionRecoveredTypes = recovered.map((m) => m.type);

	provider.dispose();
}

process.stdout.write(`${JSON.stringify(results)}\n`);
process.exit(0);
