import type { ChildProcess } from "node:child_process";

export function toChildError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}

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
