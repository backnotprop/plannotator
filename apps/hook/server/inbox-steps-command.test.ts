import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer, type InboxServer } from "@plannotator/server/inbox";
import type { CallCommandDeps } from "./inbox-call-command";
import { runInboxStepsCommand } from "./inbox-steps-command";

const roots: string[] = [];
const servers: InboxServer[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

const LIST = [
  { step: "Classify failed charges", status: "done" },
  { step: "Replay the failures in staging", status: "doing", note: "38 of 40 recovered" },
  { step: "Ship it behind a flag", status: "todo" },
];

async function world(steps: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-checklist-cli-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const project = join(root, "app");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  if (steps) writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxSteps: true }));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "send_message", arguments: { body: "Retry plan.", subject: "Retry worker", project_path: project, agent_session: "ses_cli", agent_host: "claude-code", agent_name: "Claude Code" } },
    }),
  });
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data:"));
  const thread = JSON.parse(data ? data.slice(5) : text).result.structuredContent.thread_id as string;
  const out: string[] = [];
  const err: string[] = [];
  const deps = (stdin?: string): CallCommandDeps => ({
    cwd: project,
    env: {},
    ensureRunning: async () => ({ port: server.port }) as Awaited<ReturnType<CallCommandDeps["ensureRunning"]>>,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    ...(stdin !== undefined ? { stdin: async () => stdin } : {}),
  });
  return { server, thread, out, err, deps };
}

test("on: the list lands as the --session's own, from the argument and from stdin, with the progress on stdout", async () => {
  const w = await world(true);
  const code = await runInboxStepsCommand(["--session", "claude-code:ses_cli", w.thread, "--json", JSON.stringify(LIST)], w.deps());
  expect(w.err.join("")).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(w.out.join(""))).toMatchObject({ thread_id: w.thread, changed: true, done: 1, total: 3, doing: "Replay the failures in staging" });
  expect(w.server.store.stepsOf(w.thread, "ses_cli")!.steps.map((s) => s.status)).toEqual(["done", "doing", "todo"]);
  expect(w.server.store.threadSteps(w.thread)).toHaveLength(1);

  w.out.length = 0;
  const next = LIST.map((s) => ({ ...s, status: "done" }));
  expect(await runInboxStepsCommand(["--session", "claude-code:ses_cli", w.thread, "--json", "-"], w.deps(`﻿${JSON.stringify(next)}`))).toBe(0);
  expect(JSON.parse(w.out.join(""))).toMatchObject({ done: 3, total: 3 });
});

test("off: exit 1 with steps_off, nothing on stdout, nothing written", async () => {
  const w = await world(false);
  const before = w.server.store.cursor();
  expect(await runInboxStepsCommand(["--session", "claude-code:ses_cli", w.thread, "--json", JSON.stringify(LIST)], w.deps())).toBe(1);
  expect(w.err.join("")).toStartWith("steps_off: ");
  expect(w.out).toEqual([]);
  expect(w.server.store.cursor()).toBe(before);
});

test("a list that is not a JSON array is bad usage (exit 2) and reaches no Inbox", async () => {
  const w = await world(true);
  let asked = false;
  const deps = { ...w.deps(), ensureRunning: async () => ((asked = true), { port: w.server.port }) as Awaited<ReturnType<CallCommandDeps["ensureRunning"]>> };
  expect(await runInboxStepsCommand([w.thread, "--json", '{"step":"x"}'], deps)).toBe(2);
  expect(await runInboxStepsCommand([w.thread, "--json", "[{"], deps)).toBe(2);
  expect(await runInboxStepsCommand([w.thread], deps)).toBe(2);
  expect(asked).toBe(false);
  expect(w.out).toEqual([]);
});
