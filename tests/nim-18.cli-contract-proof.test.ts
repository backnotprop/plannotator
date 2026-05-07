import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
};

type RunningCommand = {
  pid: number;
  result: Promise<CommandResult>;
  terminate: (signal?: NodeJS.Signals) => void;
};

type SessionInfo = {
  pid: number;
  port: number;
  url: string;
  mode: "plan" | "review" | "annotate";
  project: string;
  startedAt: string;
  label: string;
};

type BuiltWorkspace = {
  notePath: string;
  reviewTargetPath: string;
  workspaceRoot: string;
};

type CliSurfaceGate =
  | {
      available: true;
      workspace: BuiltWorkspace;
    }
  | {
      available: false;
      reason: string;
    };

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const bunExecutable = Bun.which("bun") ?? "bun";
const browserExecutable = Bun.which("true") ?? "/usr/bin/true";
const tempDirs: string[] = [];
const CASE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 15_000;
const SESSION_TIMEOUT_MS = 15_000;

const submitPlanJson = JSON.stringify({
  tool_input: {
    plan: [
      "# NIM-18 CLI Proof Plan",
      "",
      "1. Start the daemon.",
      "2. Submit a pending plan.",
      "3. Reconnect with wait/open.",
    ].join("\n"),
  },
});

let builtWorkspacePromise: Promise<BuiltWorkspace> | undefined;

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function assertLocalDependenciesPresent(): void {
  const nodeModulesPath = join(repoRoot, "node_modules");
  if (existsSync(nodeModulesPath)) {
    return;
  }

  throw new Error(
    "Missing local workspace dependencies: run `bun install` before executing the NIM-18 CLI proof.",
  );
}

function createDisposableWorkspace(): string {
  assertLocalDependenciesPresent();

  const baseDir = createTempDir("plannotator-nim18-");
  const workspaceRoot = join(baseDir, "workspace");

  cpSync(repoRoot, workspaceRoot, {
    recursive: true,
    filter(source) {
      const rel = relative(repoRoot, source);
      if (!rel) {
        return true;
      }

      const topLevel = rel.split("/")[0];
      return topLevel !== ".git" && topLevel !== "node_modules";
    },
  });

  symlinkSync(join(repoRoot, "node_modules"), join(workspaceRoot, "node_modules"), "dir");
  return workspaceRoot;
}

function spawnCommand(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdinText?: string,
): RunningCommand {
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  if (stdinText !== undefined) {
    child.stdin.write(stdinText);
  }
  child.stdin.end();

  return {
    pid: child.pid ?? -1,
    terminate(signal: NodeJS.Signals = "SIGTERM") {
      try {
        child.kill(signal);
      } catch {
        // The process may have already exited.
      }
    },
    result: new Promise<CommandResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          signal,
        });
      });
    }),
  };
}

async function waitForResult(
  resultPromise: Promise<CommandResult>,
  timeoutMs: number,
  description: string,
): Promise<CommandResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      resultPromise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${description} after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function runCommand(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  description: string,
  stdinText?: string,
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  const running = spawnCommand(command, cwd, env, stdinText);
  try {
    return await waitForResult(running.result, timeoutMs, description);
  } catch (error) {
    running.terminate("SIGKILL");
    throw error;
  }
}

async function runGit(
  workspaceRoot: string,
  ...args: string[]
): Promise<CommandResult> {
  return await runCommand(["git", ...args], workspaceRoot, process.env, `git ${args.join(" ")}`);
}

function assertCommandSucceeded(result: CommandResult, label: string): void {
  if (result.exitCode === 0) {
    return;
  }

  throw new Error(
    [
      `${label} failed with exit code ${result.exitCode}.`,
      "",
      "--- stdout ---",
      result.stdout,
      "",
      "--- stderr ---",
      result.stderr,
    ].join("\n"),
  );
}

async function initializeDisposableGitRepo(workspaceRoot: string): Promise<void> {
  assertCommandSucceeded(await runGit(workspaceRoot, "init", "-b", "main"), "git init");
  assertCommandSucceeded(
    await runGit(workspaceRoot, "config", "user.name", "Plannotator Tests"),
    "git config user.name",
  );
  assertCommandSucceeded(
    await runGit(workspaceRoot, "config", "user.email", "tests@example.com"),
    "git config user.email",
  );
  assertCommandSucceeded(await runGit(workspaceRoot, "add", "."), "git add");
  assertCommandSucceeded(
    await runGit(workspaceRoot, "commit", "-m", "baseline"),
    "git commit baseline",
  );
}

async function ensureBuiltWorkspace(): Promise<BuiltWorkspace> {
  if (!builtWorkspacePromise) {
    builtWorkspacePromise = (async () => {
      const workspaceRoot = createDisposableWorkspace();

      assertCommandSucceeded(
        await runCommand(
          [bunExecutable, "run", "build:review"],
          workspaceRoot,
          process.env,
          "bun run build:review",
          undefined,
          CASE_TIMEOUT_MS,
        ),
        "bun run build:review",
      );
      assertCommandSucceeded(
        await runCommand(
          [bunExecutable, "run", "build:hook"],
          workspaceRoot,
          process.env,
          "bun run build:hook",
          undefined,
          CASE_TIMEOUT_MS,
        ),
        "bun run build:hook",
      );

      const fixturesDir = join(workspaceRoot, "proof-fixtures");
      mkdirSync(fixturesDir, { recursive: true });

      const notePath = join(fixturesDir, "nim-18-note.md");
      writeFileSync(
        notePath,
        "# NIM-18 Annotate Target\n\nThis markdown note exists so the CLI can open a real annotate session.\n",
        "utf8",
      );

      const reviewTargetPath = join(fixturesDir, "review-target.ts");
      writeFileSync(reviewTargetPath, 'export const reviewTarget = "baseline";\n', "utf8");

      await initializeDisposableGitRepo(workspaceRoot);

      return {
        notePath,
        reviewTargetPath,
        workspaceRoot,
      };
    })();
  }

  return await builtWorkspacePromise;
}

function createHomeDir(): string {
  const homeDir = join(createTempDir("plannotator-nim18-home-"), "home");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(join(homeDir, ".plannotator"), { recursive: true });
  return homeDir;
}

function cliEnv(homeDir: string, workspaceRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    PLANNOTATOR_BROWSER: browserExecutable,
    PLANNOTATOR_CWD: workspaceRoot,
  };
}

async function runCli(
  workspaceRoot: string,
  homeDir: string,
  args: string[],
  stdinText?: string,
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  return await runCommand(
    [bunExecutable, "run", "apps/hook/server/index.ts", ...args],
    workspaceRoot,
    cliEnv(homeDir, workspaceRoot),
    `plannotator ${args.join(" ") || "<default>"}`,
    stdinText,
    timeoutMs,
  );
}

function spawnCli(
  workspaceRoot: string,
  homeDir: string,
  args: string[],
  stdinText?: string,
): RunningCommand {
  return spawnCommand(
    [bunExecutable, "run", "apps/hook/server/index.ts", ...args],
    workspaceRoot,
    cliEnv(homeDir, workspaceRoot),
    stdinText,
  );
}

function sessionsDir(homeDir: string): string {
  return join(homeDir, ".plannotator", "sessions");
}

function readSessions(homeDir: string): SessionInfo[] {
  const dir = sessionsDir(homeDir);
  if (!existsSync(dir)) {
    return [];
  }

  const sessions: SessionInfo[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }

    const filePath = join(dir, entry);
    try {
      sessions.push(JSON.parse(readFileSync(filePath, "utf8")) as SessionInfo);
    } catch {
      // Corrupt or partially-written session files are not valid proof evidence.
    }
  }

  return sessions.sort(
    (left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime(),
  );
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start <= timeoutMs) {
    if (predicate()) {
      return;
    }

    await Bun.sleep(50);
  }

  throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms.`);
}

async function readActiveRequestId(session: SessionInfo): Promise<string> {
  const response = await fetch(`${session.url}/api/state`);
  const body = (await response.json()) as { document?: { id?: string } };
  const requestId = body.document?.id;
  if (!requestId) {
    throw new Error(`No active request id available from ${session.url}/api/state.`);
  }
  return requestId;
}

async function waitForActiveSession(
  homeDir: string,
  expectedMode?: SessionInfo["mode"],
): Promise<SessionInfo> {
  await waitForCondition(() => {
    const sessions = readSessions(homeDir);
    if (expectedMode) {
      return sessions.some((session) => session.mode === expectedMode);
    }

    return sessions.length > 0;
  }, SESSION_TIMEOUT_MS, `${expectedMode ?? "any"} active session file`);

  const sessions = readSessions(homeDir);
  if (expectedMode) {
    const match = sessions.find((session) => session.mode === expectedMode);
    if (match) {
      return match;
    }
  }

  const [latest] = sessions;
  if (!latest) {
    throw new Error("Expected an active session file, but none were present.");
  }

  return latest;
}

async function postReviewFeedback(url: string, feedback: string): Promise<Response> {
  return await fetch(`${url}/api/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      feedback,
      annotations: [],
    }),
  });
}

async function postPlanApproval(url: string, feedback: string): Promise<Response> {
  return await fetch(`${url}/api/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      feedback,
      annotations: [],
      permissionMode: "acceptEdits",
      planSave: {
        enabled: false,
      },
    }),
  });
}

function expectSuccessOutput(result: CommandResult, matcher: RegExp): void {
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(matcher);
}

function expectCollisionGuidance(result: CommandResult): void {
  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("409");
  expect(result.stderr).toContain("plannotator wait");
  expect(result.stderr).toContain("plannotator open");
  expect(result.stderr).toContain("plannotator clear --force");
}

function updateReviewFixture(reviewTargetPath: string, marker: string): void {
  writeFileSync(reviewTargetPath, `export const reviewTarget = ${JSON.stringify(marker)};\n`, "utf8");
}

async function terminateIfRunning(command: RunningCommand): Promise<void> {
  command.terminate("SIGTERM");

  try {
    await waitForResult(command.result, 5_000, `pid ${command.pid} to exit after SIGTERM`);
  } catch {
    command.terminate("SIGKILL");
    await waitForResult(command.result, 5_000, `pid ${command.pid} to exit after SIGKILL`);
  }
}

async function probeCliSurface(): Promise<CliSurfaceGate> {
  const workspace = await ensureBuiltWorkspace();
  const homeDir = createHomeDir();

  const probes = await Promise.all([
    runCli(workspace.workspaceRoot, homeDir, ["status"]),
    runCli(workspace.workspaceRoot, homeDir, ["wait"]),
    runCli(workspace.workspaceRoot, homeDir, ["open"]),
    runCli(workspace.workspaceRoot, homeDir, ["clear", "--force"]),
  ]);

  const fallthroughProbeLabels = ["status", "wait", "open", "clear --force"];
  const fallbackHits = probes
    .map((probe, index) => ({
      label: fallthroughProbeLabels[index],
      probe,
    }))
    .filter(({ probe }) => probe.stderr.includes("Failed to parse hook event from stdin"));

  if (fallbackHits.length > 0) {
    return {
      available: false,
      reason: [
        "NIM-18 expects the public CLI to expose daemon subcommands start/stop/status/submit/review/annotate/wait/clear/open instead of falling back to hook-mode stdin parsing.",
        "",
        ...fallbackHits.flatMap(({ label, probe }) => [
          `$ plannotator ${label}`,
          `exit ${probe.exitCode}`,
          probe.stdout ? `stdout: ${probe.stdout.trimEnd()}` : "stdout: <empty>",
          probe.stderr ? `stderr: ${probe.stderr.trimEnd()}` : "stderr: <empty>",
          "",
        ]),
      ].join("\n"),
    };
  }

  return {
    available: true,
    workspace,
  };
}

const cliSurfaceGate = await probeCliSurface();

function requireWorkspace(): BuiltWorkspace {
  if (!cliSurfaceGate.available) {
    throw new Error(cliSurfaceGate.reason);
  }

  return cliSurfaceGate.workspace;
}

describe("NIM-18 CLI contract proof", () => {
  test("defines daemon-owned start/stop/status/submit/review/annotate/wait/clear/open commands before CLI semantics activate", () => {
    if (!cliSurfaceGate.available) {
      throw new Error(cliSurfaceGate.reason);
    }
  });

  if (!cliSurfaceGate.available) {
    return;
  }

  test("uses start/status/stop as the human-facing daemon lifecycle contract", async () => {
    const workspace = requireWorkspace();
    const homeDir = createHomeDir();

    try {
      const started = await runCli(workspace.workspaceRoot, homeDir, ["start"]);
      expectSuccessOutput(started, /\bstarted\b/i);

      const secondStart = await runCli(workspace.workspaceRoot, homeDir, ["start"]);
      expectSuccessOutput(secondStart, /\brunning\b/i);

      const status = await runCli(workspace.workspaceRoot, homeDir, ["status"]);
      expectSuccessOutput(status, /\brunning\b/i);

      const stopped = await runCli(workspace.workspaceRoot, homeDir, ["stop"]);
      expectSuccessOutput(stopped, /\bstopped\b/i);

      const stoppedStatus = await runCli(workspace.workspaceRoot, homeDir, ["status"]);
      expect(stoppedStatus.exitCode).not.toBe(0);
      expect(`${stoppedStatus.stdout}\n${stoppedStatus.stderr}`).toMatch(/\bstopped\b/i);
    } finally {
      await runCli(workspace.workspaceRoot, homeDir, ["stop"]).catch(() => undefined);
    }
  }, CASE_TIMEOUT_MS);

  test("returns the same 409 recovery guidance no matter whether the second front-door command is submit, review, or annotate", async () => {
    const workspace = requireWorkspace();
    const homeDir = createHomeDir();

    try {
      expectSuccessOutput(await runCli(workspace.workspaceRoot, homeDir, ["start"]), /\bstarted\b|\brunning\b/i);

      const firstAnnotate = spawnCli(
        workspace.workspaceRoot,
        homeDir,
        ["annotate", workspace.notePath],
      );

      try {
        await waitForActiveSession(homeDir, "annotate");

        const submitCollision = await runCli(
          workspace.workspaceRoot,
          homeDir,
          ["submit"],
          submitPlanJson,
        );
        expectCollisionGuidance(submitCollision);

        updateReviewFixture(workspace.reviewTargetPath, `collision-${Date.now()}`);
        const reviewCollision = await runCli(workspace.workspaceRoot, homeDir, ["review"]);
        expectCollisionGuidance(reviewCollision);

        const annotateCollision = await runCli(
          workspace.workspaceRoot,
          homeDir,
          ["annotate", workspace.notePath],
        );
        expectCollisionGuidance(annotateCollision);
      } finally {
        await runCli(workspace.workspaceRoot, homeDir, ["clear", "--force"]).catch(() => undefined);
        await waitForResult(firstAnnotate.result, CASE_TIMEOUT_MS, "annotate command to exit after clear");
      }
    } finally {
      await runCli(workspace.workspaceRoot, homeDir, ["stop"]).catch(() => undefined);
    }
  }, CASE_TIMEOUT_MS);

  test("open reattaches to the active daemon-owned browser session and wait replays the approved plan verdict after a client disconnect", async () => {
    const workspace = requireWorkspace();
    const homeDir = createHomeDir();

    try {
      expectSuccessOutput(await runCli(workspace.workspaceRoot, homeDir, ["start"]), /\bstarted\b|\brunning\b/i);

      const submitCommand = spawnCli(
        workspace.workspaceRoot,
        homeDir,
        ["submit"],
        submitPlanJson,
      );

      const session = await waitForActiveSession(homeDir, "plan");
      const requestId = await readActiveRequestId(session);
      await terminateIfRunning(submitCommand);

      const openResult = await runCli(workspace.workspaceRoot, homeDir, ["open"]);
      expectSuccessOutput(openResult, new RegExp(session.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      const waitCommand = spawnCli(workspace.workspaceRoot, homeDir, ["wait", "--request-id", requestId]);

      const approve = await postPlanApproval(
        session.url,
        "Approved via NIM-18 wait reconnect proof.",
      );
      expect(approve.status).toBe(200);

      const waitResult = await waitForResult(
        waitCommand.result,
        CASE_TIMEOUT_MS,
        "plannotator wait to replay the approved plan verdict",
      );
      expect(waitResult.exitCode).toBe(0);
      expect(waitResult.stderr).toBe("");
      expect(waitResult.stdout).toContain("Approved via NIM-18 wait reconnect proof.");
    } finally {
      await runCli(workspace.workspaceRoot, homeDir, ["stop"]).catch(() => undefined);
    }
  }, CASE_TIMEOUT_MS);

  test("clear --force cancels a disconnected pending plan and reopens the singleton slot for the next submit", async () => {
    const workspace = requireWorkspace();
    const homeDir = createHomeDir();

    try {
      expectSuccessOutput(await runCli(workspace.workspaceRoot, homeDir, ["start"]), /\bstarted\b|\brunning\b/i);

      const submitCommand = spawnCli(
        workspace.workspaceRoot,
        homeDir,
        ["submit"],
        submitPlanJson,
      );

      const session = await waitForActiveSession(homeDir, "plan");
      const requestId = await readActiveRequestId(session);
      await terminateIfRunning(submitCommand);

      const waitCommand = spawnCli(workspace.workspaceRoot, homeDir, ["wait", "--request-id", requestId]);
      const forcedClear = await runCli(workspace.workspaceRoot, homeDir, ["clear", "--force"]);
      expectSuccessOutput(forcedClear, /\bcleared\b|\bcancelled\b/i);

      const waitResult = await waitForResult(
        waitCommand.result,
        CASE_TIMEOUT_MS,
        "plannotator wait to surface the cancelled verdict",
      );
      expect(waitResult.exitCode).toBe(1);
      expect(waitResult.stderr).toBe("");
      expect(waitResult.stdout).toMatch(/Submission cleared before a verdict was delivered\.|\bcancelled\b/i);

      const replacementSubmit = spawnCli(
        workspace.workspaceRoot,
        homeDir,
        ["submit"],
        submitPlanJson,
      );

      try {
        const replacementSession = await waitForActiveSession(homeDir, "plan");
        const approve = await postPlanApproval(
          replacementSession.url,
          "Replacement submission approved after force clear.",
        );
        expect(approve.status).toBe(200);

        const replacementResult = await waitForResult(
          replacementSubmit.result,
          CASE_TIMEOUT_MS,
          "replacement submit command to resolve",
        );
        expect(replacementResult.exitCode).toBe(0);
        expect(replacementResult.stderr).toBe("");
        expect(replacementResult.stdout).toContain(
          "Replacement submission approved after force clear.",
        );
      } finally {
        replacementSubmit.terminate("SIGTERM");
      }
    } finally {
      await runCli(workspace.workspaceRoot, homeDir, ["stop"]).catch(() => undefined);
    }
  }, CASE_TIMEOUT_MS);

  test("review still uses the public CLI surface rather than bypassing the daemon contract", async () => {
    const workspace = requireWorkspace();
    const homeDir = createHomeDir();

    try {
      expectSuccessOutput(await runCli(workspace.workspaceRoot, homeDir, ["start"]), /\bstarted\b|\brunning\b/i);

      updateReviewFixture(workspace.reviewTargetPath, `review-${Date.now()}`);
      const reviewCommand = spawnCli(workspace.workspaceRoot, homeDir, ["review"]);

      const session = await waitForActiveSession(homeDir, "review");
      const feedback = await postReviewFeedback(
        session.url,
        "Review verdict delivered through daemon-backed CLI flow.",
      );
      expect(feedback.status).toBe(200);

      const reviewResult = await waitForResult(
        reviewCommand.result,
        CASE_TIMEOUT_MS,
        "plannotator review to return the daemon-backed review verdict",
      );
      expect(reviewResult.exitCode).toBe(0);
      expect(reviewResult.stderr).toBe("");
      expect(reviewResult.stdout).toContain(
        "Review verdict delivered through daemon-backed CLI flow.",
      );
    } finally {
      await runCli(workspace.workspaceRoot, homeDir, ["stop"]).catch(() => undefined);
    }
  }, CASE_TIMEOUT_MS);
});
