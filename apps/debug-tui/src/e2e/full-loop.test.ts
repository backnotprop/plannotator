import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parsePluginResponse } from "@plannotator/shared/plugin-protocol";
import { getScenario } from "../scenarios";
import { runScenario } from "../scenarios/run-scenario";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

describe.skipIf(process.env.PLANNOTATOR_AGENT_SIMULATOR_E2E !== "1")(
  "agent simulator full process-to-daemon loop",
  () => {
    test(
      "spawns the real Plannotator plugin command, creates a daemon plan session, and approves it",
      async () => {
        await buildFrontendShell();
        const result = await runScenario(getScenario("opencode-plan"), {
          repoRoot,
          timeoutMs: 120_000,
        });

        expect(result.session?.mode).toBe("plan");
        expect(result.process.exitCode).toBe(0);
        const response = parsePluginResponse(result.process.stdout.trim());
        expect(response?.ok).toBe(true);
        expect(response?.ok === true ? response.result : undefined).toMatchObject({
          approved: true,
        });
      },
      180_000,
    );
  },
);

async function buildFrontendShell(): Promise<void> {
  const child = spawn("bun", ["run", "--cwd", "apps/debug-frontend", "build"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    throw new Error(`frontend build failed:\n${output}`);
  }
}
