import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface RuntimeFixture {
  name: string;
  modulePath: string;
  exportName: string;
}

interface SshInvocation {
  pid: number;
  args: string[];
  gitTerminalPrompt?: string;
  sshAskpassRequire?: string;
}

const fixtures: RuntimeFixture[] = [
  {
    name: "Bun",
    modulePath: resolve(import.meta.dir, "git.ts"),
    exportName: "runtime",
  },
  {
    name: "Pi",
    modulePath: resolve(import.meta.dir, "../../apps/pi-extension/server/vcs.ts"),
    exportName: "reviewRuntime",
  },
];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function createSshFixture(): { repo: string; marker: string; command: string } {
  const root = mkdtempSync(join(tmpdir(), "plannotator-git-background-"));
  tempDirs.push(root);
  const repo = join(root, "repo");
  const marker = join(root, "ssh-invocations.jsonl");
  const fakeSsh = join(root, "fake-ssh.ts");
  mkdirSync(repo);

  for (const args of [
    ["init", "--quiet", repo],
    ["-C", repo, "remote", "add", "origin", "ssh://example.invalid/repository"],
  ]) {
    const result = spawnSync("git", args, { encoding: "utf-8" });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }

  writeFileSync(
    fakeSsh,
    `import { appendFileSync, openSync, writeSync } from "node:fs";
const args = process.argv.slice(2);
const marker = process.env.SSH_MARKER;
if (!marker) throw new Error("SSH_MARKER is required");
appendFileSync(marker, JSON.stringify({
  pid: process.pid,
  args,
  gitTerminalPrompt: process.env.GIT_TERMINAL_PROMPT,
  sshAskpassRequire: process.env.SSH_ASKPASS_REQUIRE,
}) + "\\n");
const batchMode = args.some((arg) => /^(?:-o)?BatchMode=yes$/i.test(arg));
const behavior = process.env.SSH_BEHAVIOR ?? "prompt";
if (behavior === "hang" || (behavior === "prompt" && !batchMode)) {
  const prompt = "Enter passphrase for key '/tmp/plannotator-test-key':\\n";
  if (behavior === "prompt") {
    try {
      const tty = openSync("/dev/tty", "w");
      writeSync(tty, prompt);
    } catch {
      process.stderr.write(prompt);
    }
  }
  await Bun.sleep(30_000);
}
process.exit(1);
`,
    "utf-8",
  );
  chmodSync(fakeSsh, 0o755);

  return {
    repo,
    marker,
    command: `${shellQuote(process.execPath)} ${shellQuote(fakeSsh)}`,
  };
}

function createHttpCredentialFixture(remoteUrl: string): {
  repo: string;
  askpassMarker: string;
  askpass: string;
} {
  const root = mkdtempSync(join(tmpdir(), "plannotator-git-credentials-"));
  tempDirs.push(root);
  const repo = join(root, "repo");
  const askpassMarker = join(root, "askpass-invoked");
  const askpass = join(root, "fake-askpass.ts");
  mkdirSync(repo);

  for (const args of [
    ["init", "--quiet", repo],
    ["-C", repo, "remote", "add", "origin", remoteUrl],
  ]) {
    const result = spawnSync("git", args, { encoding: "utf-8" });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }

  writeFileSync(
    askpass,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const marker = process.env.ASKPASS_MARKER;
if (!marker) throw new Error("ASKPASS_MARKER is required");
appendFileSync(marker, "invoked\\n");
await Bun.sleep(30_000);
`,
    "utf-8",
  );
  chmodSync(askpass, 0o755);

  return { repo, askpassMarker, askpass };
}

function parseSshInvocation(line: string): SshInvocation | null {
  const value: unknown = JSON.parse(line);
  if (
    typeof value !== "object" ||
    value === null ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !("args" in value) ||
    !Array.isArray(value.args) ||
    !value.args.every((arg) => typeof arg === "string")
  ) {
    return null;
  }
  const gitTerminalPrompt = "gitTerminalPrompt" in value && typeof value.gitTerminalPrompt === "string"
    ? value.gitTerminalPrompt
    : undefined;
  const sshAskpassRequire = "sshAskpassRequire" in value && typeof value.sshAskpassRequire === "string"
    ? value.sshAskpassRequire
    : undefined;
  return { pid: value.pid, args: value.args, gitTerminalPrompt, sshAskpassRequire };
}

function readInvocations(marker: string): SshInvocation[] {
  try {
    return readFileSync(marker, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const invocation = parseSshInvocation(line);
        return invocation ? [invocation] : [];
      });
  } catch {
    return [];
  }
}

function terminateTransports(invocations: SshInvocation[]): void {
  for (const invocation of invocations) {
    try {
      process.kill(invocation.pid, "SIGKILL");
    } catch {
      // The fixed path exits before cleanup reaches it.
    }
  }
}

describe.skipIf(process.platform === "win32")("background remote discovery", () => {
  for (const fixture of fixtures) {
    test(`${fixture.name} discovery cannot prompt through a controlling terminal`, () => {
      const { repo, marker, command } = createSshFixture();
      const runtimeUrl = pathToFileURL(fixture.modulePath).href;
      const reviewCoreUrl = pathToFileURL(resolve(import.meta.dir, "../shared/review-core.ts")).href;
      const source = `
        const runtimeModule = await import(${JSON.stringify(runtimeUrl)});
        const { detectRemoteDefaultInfo } = await import(${JSON.stringify(reviewCoreUrl)});
        const result = await detectRemoteDefaultInfo(
          runtimeModule[${JSON.stringify(fixture.exportName)}],
          ${JSON.stringify(repo)},
        );
        if (result !== null) process.exit(2);
      `;

      const result = spawnSync(process.execPath, ["--eval", source], {
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_SSH_COMMAND: command,
          SSH_MARKER: marker,
        },
        timeout: 2_000,
      });
      const invocations = readInvocations(marker);
      terminateTransports(invocations);

      expect(invocations.length).toBeGreaterThan(0);
      expect(invocations.every((invocation) => invocation.gitTerminalPrompt === "0")).toBe(true);
      expect(invocations.every((invocation) => invocation.sshAskpassRequire === "never")).toBe(true);
      expect(
        invocations.every((invocation) =>
          invocation.args.some((arg) => /^(?:-o)?BatchMode=yes$/i.test(arg)),
        ),
      ).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    }, 5_000);

    test(`${fixture.name} timeout kills the Git transport process tree`, async () => {
      const { repo, marker, command } = createSshFixture();
      const runtimeUrl = pathToFileURL(fixture.modulePath).href;
      const source = `
        const runtimeModule = await import(${JSON.stringify(runtimeUrl)});
        await runtimeModule[${JSON.stringify(fixture.exportName)}].runGit(
          ["ls-remote", "--symref", "origin", "HEAD"],
          { cwd: ${JSON.stringify(repo)}, timeoutMs: 150, interaction: "forbid" },
        );
      `;

      const startedAt = performance.now();
      const result = spawnSync(process.execPath, ["--eval", source], {
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_SSH_COMMAND: command,
          SSH_BEHAVIOR: "hang",
          SSH_MARKER: marker,
        },
        timeout: 2_000,
      });
      const elapsedMs = performance.now() - startedAt;
      const invocations = readInvocations(marker);
      await Bun.sleep(50);

      try {
        expect(invocations.length).toBeGreaterThan(0);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(elapsedMs).toBeLessThan(1_000);
        for (const invocation of invocations) {
          expect(() => process.kill(invocation.pid, 0)).toThrow();
        }
      } finally {
        terminateTransports(invocations);
      }
    }, 5_000);

    test(`${fixture.name} interactive fetch keeps the inherited authentication policy`, () => {
      const { repo, marker, command } = createSshFixture();
      const runtimeUrl = pathToFileURL(fixture.modulePath).href;
      const source = `
        const runtimeModule = await import(${JSON.stringify(runtimeUrl)});
        await runtimeModule[${JSON.stringify(fixture.exportName)}].runGit(
          ["fetch", "origin", "main"],
          { cwd: ${JSON.stringify(repo)}, timeoutMs: 2_000 },
        );
      `;

      const result = spawnSync(process.execPath, ["--eval", source], {
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_SSH_COMMAND: command,
          GIT_TERMINAL_PROMPT: "inherited",
          SSH_ASKPASS_REQUIRE: "force",
          SSH_BEHAVIOR: "record",
          SSH_MARKER: marker,
        },
        timeout: 2_000,
      });
      const invocations = readInvocations(marker);
      terminateTransports(invocations);

      expect(invocations.length).toBeGreaterThan(0);
      expect(invocations.every((invocation) => invocation.gitTerminalPrompt === "inherited")).toBe(true);
      expect(invocations.every((invocation) => invocation.sshAskpassRequire === "force")).toBe(true);
      expect(
        invocations.every((invocation) =>
          invocation.args.every((arg) => !/^(?:-o)?BatchMode=yes$/i.test(arg)),
        ),
      ).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    }, 5_000);

    test(`${fixture.name} background HTTP(S) auth does not invoke askpass`, async () => {
      const authServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          return new Response("Authentication required", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="Plannotator test"' },
          });
        },
      });
      const { repo, askpassMarker, askpass } = createHttpCredentialFixture(
        `http://127.0.0.1:${authServer.port}/repository.git`,
      );
      const runtimeUrl = pathToFileURL(fixture.modulePath).href;
      const source = `
        const runtimeModule = await import(${JSON.stringify(runtimeUrl)});
        await runtimeModule[${JSON.stringify(fixture.exportName)}].runGit(
          ["ls-remote", "--symref", "origin", "HEAD"],
          { cwd: ${JSON.stringify(repo)}, timeoutMs: 500, interaction: "forbid" },
        );
      `;

      try {
        const proc = Bun.spawn([process.execPath, "--eval", source], {
          env: {
            ...process.env,
            ASKPASS_MARKER: askpassMarker,
            GIT_ASKPASS: askpass,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);

        expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 });
        expect(() => readFileSync(askpassMarker, "utf-8")).toThrow();
      } finally {
        authServer.stop(true);
      }
    }, 5_000);
  }
});
