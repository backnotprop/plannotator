import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensurePlannotatorBinary, runPluginPlan, type CommandRunner } from "./binary-client";
import {
  createPluginSuccessResponse,
  getPluginCapabilities,
} from "../../packages/shared/plugin-protocol";

function existsFrom(set: Set<string>) {
  return (candidate: string) => set.has(candidate);
}

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("Pi binary client", () => {
  test("returns a compatible discovered binary", () => {
    const commands: Array<[string, string[]]> = [];
    let timeoutMs: number | null | undefined;
    const run: CommandRunner = (command, args, _input, options) => {
      commands.push([command, args]);
      timeoutMs = options?.timeoutMs;
      return {
        exitCode: 0,
        stdout: JSON.stringify(getPluginCapabilities()),
        stderr: "",
      };
    };

    const result = ensurePlannotatorBinary({
      env: { PLANNOTATOR_BIN: "/opt/plannotator", PATH: "/bin" },
      homeDir: "/home/test",
      exists: existsFrom(new Set(["/opt/plannotator"])),
      platform: "linux",
      pathDelimiter: ":",
      run,
    });

    expect(result).toMatchObject({
      ok: true,
      path: "/opt/plannotator",
      source: "env",
      installed: false,
    });
    expect(commands).toEqual([["/opt/plannotator", ["plugin", "capabilities"]]]);
    expect(timeoutMs).toBe(5000);
  });

  test("skips candidates missing required plugin features", () => {
    const existing = new Set(["/old/plannotator", "/current/plannotator"]);
    const commands: Array<[string, string[]]> = [];
    const run: CommandRunner = (command, args) => {
      commands.push([command, args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ...getPluginCapabilities(),
          features: command === "/old/plannotator" ? ["capabilities", "plan-review"] : getPluginCapabilities().features,
        }),
        stderr: "",
      };
    };

    const result = ensurePlannotatorBinary({
      env: { PATH: "/old:/current" },
      homeDir: "/home/test",
      exists: existsFrom(existing),
      platform: "linux",
      pathDelimiter: ":",
      requiredFeatures: ["archive"],
      run,
    });

    expect(result).toMatchObject({
      ok: true,
      path: "/current/plannotator",
      source: "path",
      installed: false,
    });
    expect(commands).toEqual([
      ["/old/plannotator", ["plugin", "capabilities"]],
      ["/current/plannotator", ["plugin", "capabilities"]],
    ]);
  });

  test("does not install when auto-install is disabled", () => {
    const result = ensurePlannotatorBinary({
      env: { PATH: "/bin", PLANNOTATOR_DISABLE_AUTO_INSTALL: "true" },
      homeDir: "/home/test",
      exists: existsFrom(new Set()),
      platform: "linux",
      pathDelimiter: ":",
      run: () => {
        throw new Error("runner should not be called");
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "missing-binary",
    });
  });

  test("runs the official installer and validates the installed binary", () => {
    const existing = new Set<string>();
    const commands: Array<[string, string[]]> = [];
    const run: CommandRunner = (command, args) => {
      commands.push([command, args]);
      if (command === "bash") {
        existing.add("/home/test/.local/bin/plannotator");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify(getPluginCapabilities()),
        stderr: "",
      };
    };

    const result = ensurePlannotatorBinary({
      env: { PATH: "/bin" },
      homeDir: "/home/test",
      exists: existsFrom(existing),
      platform: "linux",
      pathDelimiter: ":",
      run,
    });

    expect(result).toMatchObject({
      ok: true,
      path: "/home/test/.local/bin/plannotator",
      source: "standard",
      installed: true,
    });
    expect(commands[0][0]).toBe("bash");
    expect(commands[0][1][1]).toBe("curl -fsSL https://plannotator.ai/install.sh | bash");
    expect(commands[1]).toEqual(["/home/test/.local/bin/plannotator", ["plugin", "capabilities"]]);
  });

  test("rediscovers the standard install after an incompatible env override", () => {
    const existing = new Set<string>(["/opt/old-plannotator"]);
    const commands: Array<[string, string[]]> = [];
    const run: CommandRunner = (command, args) => {
      commands.push([command, args]);
      if (command === "/opt/old-plannotator") {
        return { exitCode: 0, stdout: JSON.stringify({ protocol: "old" }), stderr: "" };
      }
      if (command === "bash") {
        existing.add("/home/test/.local/bin/plannotator");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify(getPluginCapabilities()),
        stderr: "",
      };
    };

    const result = ensurePlannotatorBinary({
      env: { PLANNOTATOR_BIN: "/opt/old-plannotator", PATH: "/bin" },
      homeDir: "/home/test",
      exists: existsFrom(existing),
      platform: "linux",
      pathDelimiter: ":",
      run,
    });

    expect(result).toMatchObject({
      ok: true,
      path: "/home/test/.local/bin/plannotator",
      source: "standard",
      installed: true,
    });
    expect(commands[0]).toEqual(["/opt/old-plannotator", ["plugin", "capabilities"]]);
    expect(commands[1][0]).toBe("bash");
    expect(commands[1][1][1]).toBe("curl -fsSL https://plannotator.ai/install.sh | bash");
    expect(commands[2]).toEqual(["/home/test/.local/bin/plannotator", ["plugin", "capabilities"]]);
  });

  test("uses an existing standard install after an incompatible env override", () => {
    const existing = new Set<string>([
      "/opt/old-plannotator",
      "/home/test/.local/bin/plannotator",
    ]);
    const commands: Array<[string, string[]]> = [];
    const run: CommandRunner = (command, args) => {
      commands.push([command, args]);
      if (command === "/opt/old-plannotator") {
        return { exitCode: 0, stdout: JSON.stringify({ protocol: "old" }), stderr: "" };
      }
      if (command === "bash") {
        throw new Error("installer should not run");
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify(getPluginCapabilities()),
        stderr: "",
      };
    };

    const result = ensurePlannotatorBinary({
      env: { PLANNOTATOR_BIN: "/opt/old-plannotator", PATH: "/bin" },
      homeDir: "/home/test",
      exists: existsFrom(existing),
      platform: "linux",
      pathDelimiter: ":",
      run,
    });

    expect(result).toMatchObject({
      ok: true,
      path: "/home/test/.local/bin/plannotator",
      source: "standard",
      installed: false,
    });
    expect(commands).toEqual([
      ["/opt/old-plannotator", ["plugin", "capabilities"]],
      ["/home/test/.local/bin/plannotator", ["plugin", "capabilities"]],
    ]);
  });

  test("reports old binaries as incompatible when install is disabled", () => {
    const result = ensurePlannotatorBinary({
      env: { PATH: "/bin", PLANNOTATOR_DISABLE_AUTO_INSTALL: "yes" },
      homeDir: "/home/test",
      exists: existsFrom(new Set(["/bin/plannotator"])),
      platform: "linux",
      pathDelimiter: ":",
      run: () => ({ exitCode: 0, stdout: JSON.stringify({ protocol: "old" }), stderr: "" }),
    });

    expect(result).toMatchObject({
      ok: false,
      code: "incompatible-binary",
    });
  });

  test("runs plugin plan with JSON stdin and parses the response", async () => {
    const response = createPluginSuccessResponse({ approved: false, feedback: "Revise" });
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    const run: CommandRunner = (command, args, input) => {
      calls.push({ command, args, input });
      return { exitCode: 0, stdout: JSON.stringify(response), stderr: "" };
    };

    expect(
      await runPluginPlan(
        "/bin/plannotator",
        {
          origin: "pi",
          planFilePath: "PLAN.md",
          cwd: "/repo",
        },
        run,
      ),
    ).toEqual(response);
    expect(calls).toEqual([
      {
        command: "/bin/plannotator",
        args: ["plugin", "plan", "--origin", "pi"],
        input: JSON.stringify({ origin: "pi", planFilePath: "PLAN.md", cwd: "/repo" }),
      },
    ]);
  });

  test("turns plugin plan command failures into protocol errors", async () => {
    const result = await runPluginPlan(
      "/bin/plannotator",
      { origin: "pi", plan: "# Plan" },
      () => ({ exitCode: 1, stdout: "", stderr: "failed" }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "plugin-command-failed", message: "failed" },
    });
  });

  test("preserves plugin runner errors when stderr only contains progress", async () => {
    const result = await runPluginPlan(
      "/bin/plannotator",
      { origin: "pi", plan: "# Plan" },
      () => ({
        exitCode: 1,
        stdout: "",
        stderr: "Open this forwarded Plannotator session URL: http://localhost:19432/s/s1\n",
        error: "Command timed out after 1000ms.",
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "plugin-command-failed", message: "Command timed out after 1000ms." },
    });
  });

  test("aborts a running plugin command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-abort-"));
    dirs.push(dir);
    const binary = join(dir, "plannotator");
    writeFileSync(binary, `#!/usr/bin/env bash
echo 'PLANNOTATOR_SESSION_READY {"mode":"plan","url":"http://127.0.0.1:4321/s/s1","port":4321,"isRemote":false}' >&2
trap 'exit 143' TERM
while true; do sleep 1; done
`, "utf-8");
    chmodSync(binary, 0o755);

    const controller = new AbortController();
    let sawSession = false;
    const result = await runPluginPlan(
      binary,
      { origin: "pi", plan: "# Plan" },
      undefined,
      {
        signal: controller.signal,
        onSession: () => {
          sawSession = true;
          controller.abort();
        },
      },
    );

    expect(sawSession).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "plugin-command-failed", message: "Command aborted." },
    });
  });
});
