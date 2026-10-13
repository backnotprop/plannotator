import { afterEach, describe, expect, test } from "bun:test";
import { createTestEnvironment } from "../../../tests/helpers/environment.ts";
import { closeServer, occupyConsecutivePorts } from "../../../tests/helpers/ports.ts";
import { startServerWithSelfPreemption } from "../plannotator-browser.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";

// A local Pi with PLANNOTATOR_PORT set binds every review on ONE port, and an
// annotate session also attaches the agent terminal's WebSocket server to its
// http server. That WebSocket server re-emits every http server "error" as
// its own, so attaching it BEFORE listen turned the first EADDRINUSE of a
// second annotate session into an unhandled "error" event that killed the
// whole Pi process, before the port-in-use retry and the self-preemption that
// takes the port over could run. (Remote mode never crashed: the agent
// terminal is off there.)

const envKeys = [
	"PLANNOTATOR_PORT",
	"PLANNOTATOR_REMOTE",
	"PLANNOTATOR_DATA_DIR",
	"PLANNOTATOR_AGENT_TERMINAL_REMOTE",
] as const;
const environment = createTestEnvironment(envKeys, "plannotator-pi-annotate-fixed-port-");

afterEach(() => environment.restore());

async function reserveFreePort(): Promise<number> {
	const { start, servers } = await occupyConsecutivePorts(1);
	await closeServer(servers[0]!);
	return start;
}

function annotateOptions(name: string) {
	return {
		markdown: `# ${name}`,
		filePath: `${name}.md`,
		htmlContent: "<html></html>",
		mode: "annotate" as const,
		agentCwd: "/tmp/plannotator-agent-cwd",
	};
}

describe("Pi annotate on a fixed local port", () => {
	test("a busy port fails startup with the port-in-use error instead of crashing", async () => {
		environment.reset();
		process.env.PLANNOTATOR_REMOTE = "0";
		process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();
		process.env.PLANNOTATOR_PORT = String(await reserveFreePort());

		const first = await startAnnotateServer(annotateOptions("first"));
		try {
			const plan = await fetch(`${first.url}/api/plan`).then((res) => res.json());
			// The agent terminal (the WebSocket server) is what used to crash.
			expect(plan.agentTerminal.enabled).toBe(true);

			await expect(startAnnotateServer(annotateOptions("second"))).rejects.toThrow(
				`Port ${process.env.PLANNOTATOR_PORT} in use`,
			);

			// The open session is untouched by the failed start.
			const again = await fetch(`${first.url}/api/plan`).then((res) => res.json());
			expect(again.plan).toBe("# first");
		} finally {
			first.stop();
		}
	}, 15_000);

	test("a second annotate session takes the port over through self-preemption", async () => {
		environment.reset();
		process.env.PLANNOTATOR_REMOTE = "0";
		process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();
		const port = await reserveFreePort();
		process.env.PLANNOTATOR_PORT = String(port);

		const first = await startAnnotateServer(annotateOptions("first"));
		let stoppedFirst = 0;
		const second = await startServerWithSelfPreemption(
			() => startAnnotateServer(annotateOptions("second")),
			() => {
				stoppedFirst++;
				first.stop();
				return true;
			},
		);
		try {
			expect(stoppedFirst).toBe(1);
			expect(second.port).toBe(port);
			const plan = await fetch(`${second.url}/api/plan`).then((res) => res.json());
			expect(plan.plan).toBe("# second");
			expect(plan.agentTerminal.enabled).toBe(true);
		} finally {
			second.stop();
			first.stop();
		}
	}, 15_000);
});
