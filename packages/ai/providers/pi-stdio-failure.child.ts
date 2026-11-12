import { writeFileSync } from "node:fs";
import { PiProcessNode, PiSDKNodeProvider } from "./pi-sdk-node.ts";
import type { AIMessage } from "../types.ts";

const fakePi = process.env.FAKE_PI;
const modeFile = process.env.FAKE_PI_MODE_FILE;
if (!fakePi || !modeFile) throw new Error("FAKE_PI and FAKE_PI_MODE_FILE are required");

const cwd = process.cwd();
const setMode = (mode: string) => writeFileSync(modeFile, mode);

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

{
	setMode("closed-stdin");
	const proc = new PiProcessNode();
	await proc.spawn(fakePi, cwd);
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

	try {
		proc.send({ type: "abort" });
		results.postFailureSendThrew = false;
	} catch {
		results.postFailureSendThrew = true;
	}
	proc.kill();
}

{
	setMode("echo");
	const proc = new PiProcessNode();
	await proc.spawn(fakePi, cwd);
	const state = await proc.sendAndWait({ type: "get_state" });
	results.recoveredSessionId = state.sessionId;
	results.recoveredAlive = proc.alive;
	proc.kill();
}

{
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
