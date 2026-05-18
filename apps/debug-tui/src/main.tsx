import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import { useMemo, useState } from "react";
import type React from "react";
import { copyTextToClipboard } from "./clipboard";
import { authTokenFromBrowserUrl, createSimulatorDaemonClient } from "./daemon/client";
import { createSimulatorRunLog } from "./logging/run-log";
import { scenarioDefinitions } from "./scenarios";
import { runScenario, type ScenarioRunLog } from "./scenarios/run-scenario";
import type { ScenarioDefinition } from "./scenarios/types";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const defaultLatestLogPath = join(repoRoot, "plannotator-local", "simulator-runs", "latest.log");
const daemonBaseUrl = process.env.PLANNOTATOR_SIMULATOR_DAEMON_URL;
const daemonAuthToken = authTokenFromBrowserUrl(process.env.PLANNOTATOR_SIMULATOR_DAEMON_BROWSER_URL);

function SimulatorApp() {
  const renderer = useRenderer();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [autoComplete, setAutoComplete] = useState(false);
  const [logPath, setLogPath] = useState<string>(defaultLatestLogPath);
  const [copyStatus, setCopyStatus] = useState<string>("c copies log, p copies log path");
  const [logs, setLogs] = useState<ScenarioRunLog[]>([]);
  const selected = scenarioDefinitions[selectedIndex] ?? scenarioDefinitions[0];

  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      renderer.stop();
      return;
    }
    if (key.name === "c") {
      void copyLogFile(logPath, setCopyStatus);
      return;
    }
    if (key.name === "p") {
      void copyPlainText(logPath, "Copied log path.", setCopyStatus);
      return;
    }
    if (key.name === "m") {
      setAutoComplete((value) => !value);
    }
    if (key.name === "up" || key.name === "k") {
      setSelectedIndex((index) => Math.max(0, index - 1));
    }
    if (key.name === "down" || key.name === "j") {
      setSelectedIndex((index) => Math.min(scenarioDefinitions.length - 1, index + 1));
    }
    if (key.name === "return") {
      if (runningIds.has(selected.id)) return;
      void runSelected(selected, { autoComplete, setRunningIds, setLogs, setLogPath });
    }
    if (key.name === "a") {
      const notRunning = scenarioDefinitions.filter((s) => !runningIds.has(s.id));
      for (const scenario of notRunning) {
        void runSelected(scenario, { autoComplete, setRunningIds, setLogs, setLogPath });
      }
    }
  });

  const recentLogs = useMemo(() => logs.slice(-16), [logs]);

  return (
    <box style={{ flexDirection: "column", height: "100%", padding: 1 }}>
      <text style={{ fg: "#ffffff" }}>Plannotator Agent Simulator</text>
      <text style={{ fg: "#9ca3af" }}>
        Enter starts scenario. a starts all. m toggles manual/auto. c copies logs. q exits.
      </text>
      <text style={{ fg: "#9ca3af" }}>
        mode={autoComplete ? "auto-complete" : "manual"} running={runningIds.size} daemon=
        {daemonBaseUrl ?? "discover"}
      </text>
      <text style={{ fg: copyStatus.startsWith("Copy failed") ? "#fca5a5" : "#9ca3af" }}>
        {copyStatus}
      </text>
      <box style={{ flexDirection: "row", flexGrow: 1, marginTop: 1 }}>
        <box
          style={{
            flexDirection: "column",
            width: "42%",
            border: true,
            borderStyle: "single",
            padding: 1,
          }}
        >
          {scenarioDefinitions.map((scenario, index) => (
            <ScenarioRow
              key={scenario.id}
              scenario={scenario}
              selected={index === selectedIndex}
              running={runningIds.has(scenario.id)}
            />
          ))}
        </box>
        <box
          style={{
            flexDirection: "column",
            flexGrow: 1,
            border: true,
            borderStyle: "single",
            marginLeft: 1,
            padding: 1,
          }}
        >
          <text style={{ fg: "#ffffff" }}>{selected.title}</text>
          <text style={{ fg: "#9ca3af" }}>{selected.description}</text>
          <text style={{ fg: "#9ca3af", marginTop: 1 }}>
            agent={selected.agent} kind={selected.kind} session={selected.expectedSessionMode}
          </text>
          <text style={{ fg: "#ffffff", marginTop: 2 }}>Logs ({logs.length})</text>
          {recentLogs.map((log) => (
            <text key={`${log.at}-${log.message}`} selectable style={{ fg: "#d1d5db" }}>
              {formatLogTime(log.at)} {log.message}
            </text>
          ))}
        </box>
      </box>
    </box>
  );
}

function ScenarioRow({
  scenario,
  selected,
  running,
}: {
  scenario: ScenarioDefinition;
  selected: boolean;
  running: boolean;
}) {
  const marker = running ? ">" : selected ? "*" : " ";
  const color = running ? "#fbbf24" : selected ? "#ffffff" : "#d1d5db";
  return (
    <text style={{ fg: color, bg: selected ? "#374151" : undefined }}>
      {marker} {scenario.id}
    </text>
  );
}

async function runSelected(
  scenario: ScenarioDefinition,
  options: {
    autoComplete: boolean;
    setRunningIds: React.Dispatch<React.SetStateAction<Set<string>>>;
    setLogs: React.Dispatch<React.SetStateAction<ScenarioRunLog[]>>;
    setLogPath: (path: string) => void;
  },
): Promise<void> {
  options.setRunningIds((ids) => new Set([...ids, scenario.id]));
  const runLog = await createSimulatorRunLog(repoRoot, scenario);
  options.setLogPath(runLog.latestPath);
  const queued = { at: new Date().toISOString(), message: `queued ${scenario.id}` };
  await runLog.append(queued);
  options.setLogs((logs) => [...logs, queued]);
  void forwardLogToDaemon(scenario.id, queued);
  try {
    const result = await runScenario(scenario, {
      repoRoot,
      completion: options.autoComplete ? "auto" : "manual",
      useSharedDaemon: true,
      stopDaemonOnFinish: false,
      timeoutMs: 10 * 60_000,
      daemonBaseUrl,
      daemonAuthToken,
      onLog: (entry) => {
        void runLog.append(entry);
        options.setLogs((logs) => [...logs, entry]);
      },
    });
    await runLog.appendResult(result);
    options.setLogs((logs) => [
      ...logs,
      {
        at: new Date().toISOString(),
        message: `finished ${scenario.id} exit=${result.process.exitCode}`,
      },
    ]);
  } catch (err) {
    const entry = {
      at: new Date().toISOString(),
      message: `[${scenario.id}] ${err instanceof Error ? err.message : "scenario failed"}`,
    };
    await runLog.append(entry);
    options.setLogs((logs) => [...logs, entry]);
  } finally {
    options.setRunningIds((ids) => {
      const next = new Set(ids);
      next.delete(scenario.id);
      return next;
    });
  }
}

async function forwardLogToDaemon(scenarioId: string, entry: ScenarioRunLog): Promise<void> {
  if (!daemonBaseUrl) return;
  try {
    await createSimulatorDaemonClient(daemonBaseUrl, fetch, { authToken: daemonAuthToken }).postDebugLog({
      at: entry.at,
      source: "agent-simulator",
      scenarioId,
      message: entry.message,
      level: "info",
    });
  } catch {
    // The local run log remains the source of truth if debug forwarding is unavailable.
  }
}

async function copyLogFile(
  path: string,
  setCopyStatus: (message: string) => void,
): Promise<void> {
  try {
    const text = await readFile(path, "utf8");
    await copyPlainText(text, "Copied latest log.", setCopyStatus);
  } catch (err) {
    setCopyStatus(err instanceof Error ? `Copy failed: ${err.message}` : "Copy failed.");
  }
}

async function copyPlainText(
  text: string,
  successMessage: string,
  setCopyStatus: (message: string) => void,
): Promise<void> {
  const result = await copyTextToClipboard(text);
  setCopyStatus(result.ok ? successMessage : result.message);
}

function formatLogTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

if (import.meta.main) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  createRoot(renderer).render(<SimulatorApp />);
}
