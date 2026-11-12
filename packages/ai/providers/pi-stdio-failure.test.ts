import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { guardChildStreams, writeChildLine } from "./child-io.ts";

const FAKE_PI = `#!/usr/bin/env node
import { closeSync, readFileSync, readSync } from "node:fs";

const mode = readFileSync(process.env.FAKE_PI_MODE_FILE, "utf8").trim();
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
// Park forever: the failure under test must be a broken PIPE, not a child exit.
const stayAlive = () => setInterval(() => {}, 3600_000);

// Read one line straight off fd 0 WITHOUT ever constructing process.stdin.
// A stream would keep its own reference to the descriptor, and destroying it
// does not reliably close the pipe's read end — the parent's next write then
// still succeeds into the pipe buffer, which is not the condition under test.
function readLineRaw() {
  const buf = Buffer.alloc(65536);
  let acc = "";
  while (!acc.includes("\\n")) {
    let n;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      if (err.code === "EAGAIN") continue;
      throw err;
    }
    if (n <= 0) break;
    acc += buf.subarray(0, n).toString();
  }
  return acc.split("\\n")[0];
}

if (mode === "closed-stdin") {
  closeSync(0);
  say({ type: "ready_broken" });
  stayAlive();
} else if (mode === "break-after-first") {
  const msg = JSON.parse(readLineRaw());
  say({ type: "response", id: msg.id, success: true, data: { sessionId: "fake-session" } });
  closeSync(0);
  stayAlive();
} else {
  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.type === "get_state") {
        say({ type: "response", id: msg.id, success: true, data: { sessionId: "fake-session" } });
      } else if (msg.type === "prompt") {
        say({ type: "response", id: msg.id, success: true, data: {} });
        say({ type: "agent_end" });
      } else if (msg.id) {
        say({ type: "response", id: msg.id, success: true, data: {} });
      }
    }
  });
  say({ type: "ready" });
}
`;

const describeE2E = process.platform === "win32" ? describe.skip : describe;

describeE2E("Pi provider stdio failure (real node child)", () => {
	test("a broken stdin pipe fails the provider and leaves the host alive", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-stdio-1378-"));
		try {
			const fakePi = join(dir, "fake-pi.mjs");
			writeFileSync(fakePi, FAKE_PI);
			chmodSync(fakePi, 0o755);
			const modeFile = join(dir, "mode.txt");
			writeFileSync(modeFile, "echo");

			const build = await Bun.build({
				entrypoints: [join(import.meta.dir, "pi-stdio-failure.child.ts")],
				target: "node",
				format: "esm",
			});
			if (!build.success) {
				throw new Error(`child build failed: ${build.logs.map((l) => l.message).join("; ")}`);
			}
			const entry = join(dir, "child.mjs");
			writeFileSync(entry, await build.outputs[0]!.text());

			const child = Bun.spawn(["node", entry], {
				cwd: dir,
				env: { ...process.env, FAKE_PI: fakePi, FAKE_PI_MODE_FILE: modeFile },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);

			expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });

			const results = JSON.parse(stdout.trim().split("\n").pop()!);

			expect(results.brokenRejected).toBe(true);
			expect(String(results.brokenMessage).toLowerCase()).toContain("stdin");
			expect(results.brokenAliveAfter).toBe(false);
			expect(results.brokenSawProcessExited).toBe(true);
			expect(results.postFailureSendThrew).toBe(false);

			expect(results.recoveredSessionId).toBe("fake-session");
			expect(results.recoveredAlive).toBe(true);

			expect(results.sessionFailedMessages.some((m: { type: string }) => m.type === "error")).toBe(true);
			expect(results.sessionRecoveredTypes).toContain("result");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

type WriteCb = (err?: Error | null) => void;

function fakeStdin(mode: "sync-throw" | "async-error" | "ok") {
	const stream = new EventEmitter() as EventEmitter & {
		destroyed: boolean;
		writableEnded: boolean;
		write: (chunk: string, cb?: WriteCb) => boolean;
		written: string[];
	};
	stream.destroyed = false;
	stream.writableEnded = false;
	stream.written = [];
	stream.write = (chunk: string, cb?: WriteCb) => {
		if (mode === "sync-throw") {
			const err = new Error("write EPIPE") as Error & { code: string };
			err.code = "EPIPE";
			throw err;
		}
		if (mode === "async-error") {
			queueMicrotask(() => cb?.(new Error("write EPIPE")));
			return false;
		}
		stream.written.push(chunk);
		return true;
	};
	return stream;
}

const asProc = (stdin: unknown): ChildProcess => ({ stdin }) as unknown as ChildProcess;

describe("writeChildLine", () => {
	test("reports a synchronous EPIPE as a returned error, never a throw", () => {
		const failures: Error[] = [];
		let returned: Error | null = null;
		expect(() => {
			returned = writeChildLine(asProc(fakeStdin("sync-throw")), "x\n", "Pi process", (e) =>
				failures.push(e),
			);
		}).not.toThrow();
		expect(returned!.message).toContain("EPIPE");
		expect(returned!.message).toContain("Pi process");
		expect(failures).toHaveLength(0);
	});

	test("routes an asynchronous EPIPE to the failure handler", async () => {
		const failures: Error[] = [];
		const returned = writeChildLine(asProc(fakeStdin("async-error")), "x\n", "Pi process", (e) =>
			failures.push(e),
		);
		expect(returned).toBeNull();
		await new Promise((r) => setTimeout(r, 5));
		expect(failures).toHaveLength(1);
		expect(failures[0]!.message).toContain("EPIPE");
	});

	test("treats an absent, destroyed, or ended stdin as a failure rather than a silent no-op", () => {
		const label = "Pi process";
		const cb = () => {};
		expect(writeChildLine(null, "x\n", label, cb)?.message).toContain("stdin is closed");
		expect(writeChildLine(asProc(undefined), "x\n", label, cb)?.message).toContain("stdin is closed");

		const destroyed = fakeStdin("ok");
		destroyed.destroyed = true;
		expect(writeChildLine(asProc(destroyed), "x\n", label, cb)?.message).toContain("stdin is closed");

		const ended = fakeStdin("ok");
		ended.writableEnded = true;
		expect(writeChildLine(asProc(ended), "x\n", label, cb)?.message).toContain("stdin is closed");
	});

	test("passes the line through when the pipe is healthy", () => {
		const stdin = fakeStdin("ok");
		expect(writeChildLine(asProc(stdin), "hello\n", "Pi process", () => {})).toBeNull();
		expect(stdin.written).toEqual(["hello\n"]);
	});
});

describe("guardChildStreams", () => {
	test("routes an error event from the child or any pipe to the failure handler", () => {
		const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
		proc.stdin = new EventEmitter();
		proc.stdout = new EventEmitter();
		proc.stderr = null;

		const failures: string[] = [];
		guardChildStreams(proc as unknown as ChildProcess, "Pi process", (e) => failures.push(e.message));

		expect(() => proc.emit("error", new Error("spawn ENOENT"))).not.toThrow();
		expect(() => (proc.stdin as EventEmitter).emit("error", new Error("write EPIPE"))).not.toThrow();
		expect(() => (proc.stdout as EventEmitter).emit("error", new Error("read ECONNRESET"))).not.toThrow();

		expect(failures).toHaveLength(3);
		expect(failures[0]).toContain("process failed");
		expect(failures[1]).toContain("stdin failed");
		expect(failures[2]).toContain("stdout failed");
		expect(failures.every((m) => m.startsWith("Pi process "))).toBe(true);
	});
});
