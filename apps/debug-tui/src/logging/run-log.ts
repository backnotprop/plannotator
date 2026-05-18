import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScenarioRunLog, ScenarioRunResult } from "../scenarios/run-scenario";
import type { ScenarioDefinition } from "../scenarios/types";

export interface SimulatorRunLog {
  path: string;
  latestPath: string;
  append(entry: ScenarioRunLog): Promise<void>;
  appendText(text: string): Promise<void>;
  appendResult(result: ScenarioRunResult): Promise<void>;
}

export async function createSimulatorRunLog(
  repoRoot: string,
  scenario: ScenarioDefinition,
): Promise<SimulatorRunLog> {
  const dir = join(repoRoot, "plannotator-local", "simulator-runs");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}-${scenario.id}.log`);
  const latestPath = join(dir, "latest.log");
  const header = [
    `scenario=${scenario.id}`,
    `agent=${scenario.agent}`,
    `kind=${scenario.kind}`,
    `session=${scenario.expectedSessionMode}`,
    "",
  ].join("\n");
  await Promise.all([writeFile(path, header), writeFile(latestPath, header)]);

  const appendText = async (text: string) => {
    await Promise.all([appendFile(path, text), appendFile(latestPath, text)]);
  };

  return {
    path,
    latestPath,
    append(entry) {
      return appendText(`${entry.at} ${entry.message}\n`);
    },
    appendText,
    appendResult(result) {
      return appendText(
        [
          "",
          `exitCode=${result.process.exitCode}`,
          `signal=${result.process.signal ?? ""}`,
          `timedOut=${result.process.timedOut}`,
          `session=${result.session?.url ?? ""}`,
          "",
          "stdout:",
          result.process.stdout,
          "",
          "stderr:",
          result.process.stderr,
          "",
        ].join("\n"),
      );
    },
  };
}
