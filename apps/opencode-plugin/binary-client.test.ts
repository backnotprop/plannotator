import { describe, expect, test } from "bun:test";
import { ensurePlannotatorBinary, runPluginPlan, type CommandRunner } from "./binary-client";
import {
  createPluginSuccessResponse,
  getPluginCapabilities,
} from "../../packages/shared/plugin-protocol";

function existsFrom(set: Set<string>) {
  return (candidate: string) => set.has(candidate);
}

describe("OpenCode binary client", () => {
  test("returns a compatible discovered binary", () => {
    const existing = new Set(["/bin/plannotator"]);
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
      env: { PATH: "/bin" },
      homeDir: "/home/test",
      exists: existsFrom(existing),
      platform: "linux",
      pathDelimiter: ":",
      run,
    });

    expect(result).toMatchObject({
      ok: true,
      path: "/bin/plannotator",
      source: "path",
      installed: false,
    });
    expect(commands).toEqual([["/bin/plannotator", ["plugin", "capabilities"]]]);
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

  test("reports a missing binary when auto-install is disabled", () => {
    const result = ensurePlannotatorBinary({
      env: { PATH: "/bin", PLANNOTATOR_DISABLE_AUTO_INSTALL: "1" },
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

  test("runs the official installer and rediscovers the binary", () => {
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

  test("uses the local source shim before auto-installing", () => {
    const existing = new Set(["/repo/plannotator/bin/plannotator.js"]);
    const commands: Array<[string, string[]]> = [];
    const run: CommandRunner = (command, args) => {
      commands.push([command, args]);
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
      env: { PATH: "/bin" },
      homeDir: "/home/test",
      sourceRoot: "/repo/plannotator",
      exists: existsFrom(existing),
      platform: "linux",
      pathDelimiter: ":",
      run,
    });

    expect(result).toMatchObject({
      ok: true,
      path: "/repo/plannotator/bin/plannotator.js",
      source: "source",
      installed: false,
    });
    expect(commands).toEqual([["/repo/plannotator/bin/plannotator.js", ["plugin", "capabilities"]]]);
  });


  test("only pins the installer when an explicit install version is provided", () => {
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
      installVersion: "1.2.3",
      run,
    });

    expect(result).toMatchObject({ ok: true, installed: true });
    expect(commands[0]).toEqual([
      "bash",
      ["-c", "curl -fsSL https://plannotator.ai/install.sh | bash -s -- --version 'v1.2.3'"],
    ]);
  });

  test("rediscovers the standard install after an incompatible PATH binary", () => {
    const existing = new Set<string>(["/old/plannotator"]);
    const commands: Array<[string, string[]]> = [];
    const run: CommandRunner = (command, args) => {
      commands.push([command, args]);
      if (command === "/old/plannotator") {
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
      env: { PATH: "/old" },
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
    expect(commands[0]).toEqual(["/old/plannotator", ["plugin", "capabilities"]]);
    expect(commands[1][0]).toBe("bash");
    expect(commands[1][1][1]).toBe("curl -fsSL https://plannotator.ai/install.sh | bash");
    expect(commands[2]).toEqual(["/home/test/.local/bin/plannotator", ["plugin", "capabilities"]]);
  });

  test("uses an existing standard install after an incompatible PATH binary", () => {
    const existing = new Set<string>([
      "/old/plannotator",
      "/home/test/.local/bin/plannotator",
    ]);
    const commands: Array<[string, string[]]> = [];
    const run: CommandRunner = (command, args) => {
      commands.push([command, args]);
      if (command === "/old/plannotator") {
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
      env: { PATH: "/old" },
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
      ["/old/plannotator", ["plugin", "capabilities"]],
      ["/home/test/.local/bin/plannotator", ["plugin", "capabilities"]],
    ]);
  });

  test("reports incompatible binaries when capabilities are missing", () => {
    const result = ensurePlannotatorBinary({
      env: { PATH: "/bin", PLANNOTATOR_DISABLE_AUTO_INSTALL: "1" },
      homeDir: "/home/test",
      exists: existsFrom(new Set(["/bin/plannotator"])),
      platform: "linux",
      pathDelimiter: ":",
      run: () => ({ exitCode: 1, stdout: "", stderr: "unknown command" }),
    });

    expect(result).toMatchObject({
      ok: false,
      code: "incompatible-binary",
    });
  });

  test("runs plugin plan with JSON stdin and parses the response", async () => {
    const response = createPluginSuccessResponse({ approved: true });
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    const run: CommandRunner = (command, args, input) => {
      calls.push({ command, args, input });
      return { exitCode: 0, stdout: JSON.stringify(response), stderr: "" };
    };

    expect(
      await runPluginPlan(
        "/bin/plannotator",
        {
          origin: "opencode",
          plan: "# Plan",
          cwd: "/repo",
        },
        run,
      ),
    ).toEqual(response);
    expect(calls).toEqual([
      {
        command: "/bin/plannotator",
        args: ["plugin", "plan", "--origin", "opencode"],
        input: JSON.stringify({ origin: "opencode", plan: "# Plan", cwd: "/repo" }),
      },
    ]);
  });

  test("turns malformed plugin plan output into a protocol error", async () => {
    const result = await runPluginPlan(
      "/bin/plannotator",
      { origin: "opencode", plan: "# Plan" },
      () => ({ exitCode: 0, stdout: "not-json", stderr: "" }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid-plugin-response" },
    });
  });

  test("preserves plugin runner errors when stderr only contains progress", async () => {
    const result = await runPluginPlan(
      "/bin/plannotator",
      { origin: "opencode", plan: "# Plan" },
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
});
