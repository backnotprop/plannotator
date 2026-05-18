import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginSessionInfo } from "@plannotator/shared/plugin-protocol";
import { completeSession, createSimulatorDaemonClient } from "../daemon/client";
import { runPlannotatorCommand, type ProcessRunResult } from "../process/run-plannotator";
import type { ScenarioDefinition, ScenarioFixture } from "./types";

export interface ScenarioRunLog {
  at: string;
  message: string;
}

export interface ScenarioRunResult {
  scenario: ScenarioDefinition;
  fixture: ScenarioFixture;
  process: ProcessRunResult;
  session?: PluginSessionInfo;
  daemonSessionsSeen: number;
  logs: ScenarioRunLog[];
}

export interface ScenarioRunOptions {
  repoRoot: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  onLog?: (entry: ScenarioRunLog) => void;
  completion?: "auto" | "manual";
  useSharedDaemon?: boolean;
  stopDaemonOnFinish?: boolean;
  daemonBaseUrl?: string;
  daemonAuthToken?: string;
}

export async function runScenario(
  scenario: ScenarioDefinition,
  options: ScenarioRunOptions,
): Promise<ScenarioRunResult> {
  const logs: ScenarioRunLog[] = [];
  const fetchImpl = options.fetch ?? fetch;
  const log = (message: string) => {
    const entry = { at: new Date().toISOString(), message };
    logs.push(entry);
    options.onLog?.(entry);
    void publishDebugLog({
      baseUrl: options.daemonBaseUrl,
      daemonAuthToken: options.daemonAuthToken,
      fetch: fetchImpl,
      scenarioId: scenario.id,
      entry,
    });
  };

  await assertFrontendShellBuilt(options.repoRoot);
  const fixture = await scenario.buildFixture(options.repoRoot);
  const command = scenario.buildCommand(options.repoRoot, fixture);
  if (options.useSharedDaemon && scenario.agent !== "codex") {
    command.env = { ...(command.env ?? {}) };
    delete command.env.HOME;
  }
  let sessionFromStderr: PluginSessionInfo | undefined;
  const shouldStopDaemon = options.stopDaemonOnFinish ?? !options.useSharedDaemon;

  try {
    log(`starting ${scenario.id}`);
    const processPromise = runPlannotatorCommand(command, {
      timeoutMs: options.timeoutMs,
      onLog: (line) => log(line),
      onSessionReady: (session) => {
        sessionFromStderr = session;
        log(`session ready ${session.url}`);
      },
    });

    const session = await waitForScenarioSession({
      fixture,
      expectedMode: scenario.expectedSessionMode,
      sessionFromStderr: () => sessionFromStderr,
      fetch: fetchImpl,
      timeoutMs: options.timeoutMs ?? 120_000,
      daemonBaseUrl: options.daemonBaseUrl,
      daemonAuthToken: options.daemonAuthToken,
    });
    if ((options.completion ?? "auto") === "auto") {
      log(`completing ${session.mode} session ${session.url}`);
      await completeSession(fetchImpl, session.url, scenario.expectedSessionMode);
    } else {
      log(`waiting for browser action at ${session.url}`);
    }

    const process = await processPromise;
    return {
      scenario,
      fixture,
      process,
      session,
      daemonSessionsSeen: session.daemonSessionsSeen,
      logs,
    };
  } finally {
    if (shouldStopDaemon) {
      await shutdownDaemon(fixture, fetchImpl);
    }
    await fixture.cleanup?.();
  }
}

async function assertFrontendShellBuilt(repoRoot: string): Promise<void> {
  try {
    await access(join(repoRoot, "apps", "debug-frontend", "dist", "index.html"));
  } catch {
    throw new Error("Debug frontend shell is not built. Run `bun run build:debug-frontend` first.");
  }
}

async function waitForScenarioSession({
  fixture,
  expectedMode,
  sessionFromStderr,
  fetch,
  timeoutMs,
  daemonBaseUrl,
  daemonAuthToken,
}: {
  fixture: ScenarioFixture;
  expectedMode: string;
  sessionFromStderr: () => PluginSessionInfo | undefined;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  daemonBaseUrl?: string;
  daemonAuthToken?: string;
}): Promise<PluginSessionInfo & { daemonSessionsSeen: number }> {
  const deadline = Date.now() + timeoutMs;
  let daemonSessionsSeen = 0;
  while (Date.now() < deadline) {
    const ready = sessionFromStderr();
    const state = await readDaemonState(fixture);
    const baseUrl = daemonBaseUrl ?? state?.baseUrl ?? (ready ? new URL(ready.url).origin : undefined);
    const authToken = daemonAuthToken ?? state?.authToken;
    if (baseUrl) {
      const client = createSimulatorDaemonClient(baseUrl, fetch, { authToken });
      try {
        const sessions = await client.listSessions();
        daemonSessionsSeen = Math.max(daemonSessionsSeen, sessions.length);
        const session = sessions.find(
          (item) => item.mode === expectedMode && (!ready || item.url === ready.url),
        );
        if (session) {
          const sessionUrl = session.url;
          const url = new URL(sessionUrl);
          return {
            mode: expectedMode as PluginSessionInfo["mode"],
            url: sessionUrl,
            port: Number(url.port),
            isRemote: ready?.isRemote ?? state?.isRemote === true,
            daemonSessionsSeen,
          };
        }
      } catch {
        // The daemon state can appear before the server is ready. Keep polling.
      }
    }

    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${expectedMode} session.`);
}

async function publishDebugLog({
  baseUrl,
  daemonAuthToken,
  fetch,
  scenarioId,
  entry,
}: {
  baseUrl?: string;
  daemonAuthToken?: string;
  fetch: typeof globalThis.fetch;
  scenarioId: string;
  entry: ScenarioRunLog;
}): Promise<void> {
  if (!baseUrl) return;
  try {
    await createSimulatorDaemonClient(baseUrl, fetch, { authToken: daemonAuthToken }).postDebugLog({
      at: entry.at,
      source: "agent-simulator",
      scenarioId,
      message: entry.message,
      level: "info",
    });
  } catch {
    // Debug forwarding must never change scenario behavior.
  }
}

async function readDaemonState(fixture: ScenarioFixture): Promise<{ baseUrl?: string; isRemote?: boolean; authToken?: string } | null> {
  const home = fixture.env?.HOME ?? process.env.HOME;
  if (!home) return null;
  try {
    return JSON.parse(await readFile(join(home, ".plannotator", "daemon.json"), "utf8")) as {
      baseUrl?: string;
      isRemote?: boolean;
      authToken?: string;
    };
  } catch {
    return null;
  }
}

async function shutdownDaemon(fixture: ScenarioFixture, fetchImpl: typeof fetch): Promise<void> {
  const state = await readDaemonState(fixture);
  if (!state?.baseUrl) return;
  try {
    await createSimulatorDaemonClient(state.baseUrl, fetchImpl, { authToken: state.authToken }).shutdown();
  } catch {
    // Best-effort test cleanup; failed scenario output still contains process logs.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
