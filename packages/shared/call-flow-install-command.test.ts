import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { callFlowTypeScriptCommand, resolveCallFlowNpmCommand, type CallFlowInstallCommand } from "./call-flow-install-command";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "call-flow-command-"));
  roots.push(root);
  const path = join(root, "runtime & 50% ! with spaces");
  mkdirSync(path);
  return path;
}

function writeFixture(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function nodeExecutable(): string {
  const node = Bun.which("node");
  if (!node) throw new Error("Call flow command tests require Node.js on PATH.");
  return node;
}

async function runInstallCommand(command: CallFlowInstallCommand, args: readonly string[], cwd: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...args], {
      cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.on("error", reject);
    child.stdin.end();
  });
}

const echoArguments = "console.log(JSON.stringify(process.argv.slice(2)));\n";

describe("Call flow install commands", () => {
  for (const extension of ["CMD", "bat"]) {
    test.skipIf(process.platform !== "win32")(`npm.${extension} uses its JS entry point and preserves literal arguments`, async () => {
      const root = fixtureRoot();
      const npmPath = join(root, `npm.${extension}`);
      const marker = join(root, "shim-ran.txt");
      writeFixture(npmPath, '@echo shim ran>"%~dp0shim-ran.txt"\r\n@exit /b 91\r\n');
      writeFixture(join(root, "node_modules", "npm", "bin", "npm-cli.js"), echoArguments);
      const resolved = resolveCallFlowNpmCommand(nodeExecutable(), npmPath);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error(resolved.message);
      const args = ["cache", "add", join(root, "pack & ! % ^.tgz"), 'a"quote', "line\nbreak", ""];
      const result = await runInstallCommand(resolved.command, args, root);
      expect(result).toEqual({ exitCode: 0, stdout: JSON.stringify(args) + "\n", stderr: "" });
      expect(existsSync(marker)).toBe(false);
    });
  }

  test.skipIf(process.platform !== "win32")("a batch shim with no npm JS entry point fails before spawn", () => {
    const root = fixtureRoot();
    const npmPath = join(root, "npm.cmd");
    writeFixture(npmPath, "@exit /b 91\r\n");
    expect(resolveCallFlowNpmCommand(nodeExecutable(), npmPath)).toEqual({
      ok: false,
      message: `Call flow could not find npm's JavaScript entry point beside ${npmPath}. Put a standard Node.js/npm installation on PATH.`,
    });
  });

  test("native executable commands keep argv unchanged", async () => {
    const root = fixtureRoot();
    const node = nodeExecutable();
    const resolved = resolveCallFlowNpmCommand(node, node);
    expect(resolved).toEqual({ ok: true, command: [node] });
    if (!resolved.ok) throw new Error(resolved.message);
    expect(await runInstallCommand(resolved.command, ["-e", "console.log('native executable')"], root)).toEqual({ exitCode: 0, stdout: "native executable\n", stderr: "" });
  });

  test("the pinned TypeScript JS entry point runs without a .bin shim", async () => {
    const root = fixtureRoot();
    const marker = join(root, "shim-ran.txt");
    writeFixture(join(root, "node_modules", ".bin", "tsc.cmd"), '@echo shim ran>"%~dp0..\\..\\shim-ran.txt"\r\n@exit /b 91\r\n');
    writeFixture(join(root, "node_modules", "typescript", "bin", "tsc"), echoArguments);
    const args = ["-p", join(root, "tsconfig.json")];
    expect(await runInstallCommand(callFlowTypeScriptCommand(nodeExecutable(), root), args, root)).toEqual({ exitCode: 0, stdout: JSON.stringify(args) + "\n", stderr: "" });
    expect(existsSync(marker)).toBe(false);
  });
});
