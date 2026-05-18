import { fileURLToPath } from "node:url";
import { authTokenFromBrowserUrl } from "./daemon/client";
import { getScenario, scenarioDefinitions } from "./scenarios";
import { runScenario } from "./scenarios/run-scenario";
import type { ScenarioId } from "./scenarios/types";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const args = process.argv.slice(2);

if (args.includes("--list")) {
  for (const scenario of scenarioDefinitions) {
    console.log(`${scenario.id}\t${scenario.agent}\t${scenario.title}`);
  }
  process.exit(0);
}

const scenarioId = readArg("--scenario") as ScenarioId | undefined;
const runAll = args.includes("--all");
const json = args.includes("--json");
const manual = args.includes("--manual");
const sharedDaemon = args.includes("--shared-daemon");

if (!scenarioId && !runAll) {
  console.error("Usage: bun run src/cli.ts -- --scenario <id> [--json] [--manual] [--shared-daemon]");
  console.error("       bun run src/cli.ts -- --all [--json]");
  console.error("       bun run src/cli.ts -- --list");
  process.exit(1);
}

const selected = runAll ? scenarioDefinitions : [getScenario(scenarioId as ScenarioId)];
const results = [];

for (const scenario of selected) {
  const result = await runScenario(scenario, {
    repoRoot,
    completion: manual ? "manual" : "auto",
    useSharedDaemon: sharedDaemon,
    stopDaemonOnFinish: !sharedDaemon,
    daemonBaseUrl: process.env.PLANNOTATOR_SIMULATOR_DAEMON_URL,
    daemonAuthToken: authTokenFromBrowserUrl(process.env.PLANNOTATOR_SIMULATOR_DAEMON_BROWSER_URL),
    onLog: (entry) => {
      if (!json) console.error(`[${scenario.id}] ${entry.message}`);
    },
  });
  results.push({
    id: scenario.id,
    exitCode: result.process.exitCode,
    session: result.session,
    stdout: result.process.stdout,
    stderr: result.process.stderr,
  });
}

if (json) {
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} else {
  for (const result of results) {
    console.log(`${result.id}: exit=${result.exitCode} session=${result.session?.url ?? "none"}`);
  }
}

function readArg(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}
