import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { buildBinary } from "./daemon";

export type RunCliOptions = {
  stdin?: string;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
};

export type RunCliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function buildEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...(env ?? {}) };
}

export async function runCli(
  args: string[],
  opts: RunCliOptions = {},
): Promise<RunCliResult> {
  const binary = await buildBinary();
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return await new Promise<RunCliResult>((resolveRun, reject) => {
    const child = spawn(binary, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: buildEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
    }
    child.stdin?.end();

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      reject(
        new Error(
          `runCli timed out after ${timeoutMs}ms running plannotator ${args.join(" ")}.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        ),
      );
    }, timeoutMs);

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveRun({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

export type CliBackgroundHandle = {
  kill(signal?: NodeJS.Signals): void;
  waitForExit(): Promise<RunCliResult>;
  pid: number;
};

export function runCliBackground(
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string } = {},
): CliBackgroundHandle {
  // Background launches a binary that has already been built; callers must
  // await buildBinary() once before calling runCliBackground.
  let child: ChildProcess | undefined;
  let stdout = "";
  let stderr = "";
  const exitPromise = new Promise<RunCliResult>((resolveExit, rejectExit) => {
    buildBinary()
      .then((binary) => {
        child = spawn(binary, args, {
          cwd: opts.cwd ?? process.cwd(),
          env: buildEnv(opts.env),
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", (err) => rejectExit(err));
        child.once("close", (code) => {
          resolveExit({ exitCode: code ?? 1, stdout, stderr });
        });
      })
      .catch(rejectExit);
  });

  return {
    get pid() {
      return child?.pid ?? -1;
    },
    kill(signal: NodeJS.Signals = "SIGTERM") {
      if (!child) {
        return;
      }
      try {
        child.kill(signal);
      } catch {}
    },
    waitForExit() {
      return exitPromise;
    },
  };
}
