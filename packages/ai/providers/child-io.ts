/**
 * Stdio guards for the JSONL/JSON-RPC child processes the AI providers drive.
 *
 * Both `PiProcessNode` (pi-sdk-node.ts) and `CodexAppServerProcess`
 * (codex-app-server.ts) talk to a nested agent over pipes, and a pipe can
 * break at any instant — the child exits, is killed, or closes stdin while a
 * command is in flight. Two Node behaviors turn that ordinary condition into
 * a host-killing crash:
 *
 *  1. `stream.write()` on a broken pipe reports `EPIPE` either synchronously
 *     (throw) or asynchronously (an `error` event on the stream), and which
 *     one you get is a timing race. A `destroyed` check before the write
 *     cannot close that race: the child can close the pipe between the check
 *     and the write.
 *  2. An `error` event on a Node stream (or on the `ChildProcess` itself)
 *     with NO listener is re-thrown as an `uncaughtException`. Inside an
 *     embedded extension that is not "the provider failed" — it terminates
 *     the HOST agent process.
 *
 * That is issue #1378: a Plannotator plan review opened from Pi on Windows
 * took the whole Pi host down with `write EPIPE` out of `PiProcessNode.send()`.
 * Windows only made it likelier to land on the async path during teardown;
 * the mechanism is platform-independent.
 *
 * The contract these helpers enforce: a broken pipe is a PROVIDER failure.
 * It never escalates past the provider, it is reported exactly like any other
 * process end (in-flight requests reject, listeners see the process end), and
 * the provider is left dead so the next query re-spawns it.
 */

import type { ChildProcess } from "node:child_process";

/** Normalize an unknown thrown/emitted value to an Error. */
export function toChildError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}

/**
 * Attach `error` listeners to the child process and every piped stream so a
 * broken pipe can never reach `uncaughtException`.
 *
 * Call this immediately after `spawn()` returns — before awaiting the spawn
 * handshake — so a stream that fails during startup is already covered. The
 * spawn handshake may register its own one-shot `error` listener; Node allows
 * several, and `onFailure` is expected to be idempotent.
 */
export function guardChildStreams(
	proc: ChildProcess,
	label: string,
	onFailure: (error: Error) => void,
): void {
	const report = (stream: string) => (err: unknown) => {
		onFailure(new Error(`${label} ${stream} failed: ${toChildError(err).message}`));
	};
	proc.on("error", report("process"));
	proc.stdin?.on("error", report("stdin"));
	proc.stdout?.on("error", report("stdout"));
	proc.stderr?.on("error", report("stderr"));
}

/**
 * Write one already-newline-terminated line to a child's stdin.
 *
 * Returns the Error the write failed with, or `null` when the bytes were
 * accepted by the stream. Failures that only surface later (the write
 * callback, or an `error` event covered by {@link guardChildStreams}) are
 * reported through `onAsyncFailure` instead, so BOTH the sync-throw and the
 * async-event paths end up at the caller's failure handling.
 */
export function writeChildLine(
	proc: ChildProcess | null,
	line: string,
	label: string,
	onAsyncFailure: (error: Error) => void,
): Error | null {
	const stdin = proc?.stdin;
	if (!stdin || stdin.destroyed || stdin.writableEnded) {
		return new Error(`${label} stdin is closed`);
	}
	try {
		stdin.write(line, (err) => {
			if (err) {
				onAsyncFailure(
					new Error(`${label} stdin write failed: ${toChildError(err).message}`),
				);
			}
		});
	} catch (err) {
		return new Error(`${label} stdin write failed: ${toChildError(err).message}`);
	}
	return null;
}
