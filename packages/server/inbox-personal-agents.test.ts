/**
 * Whether a personal agent is connected on this computer (inbox-personal-agents.ts), as the Inbox reads it for the
 * personal agents dialog. What regresses: a Hermes cloud agent added in Settings, the Inbox tool on for OpenClaw, or
 * a thread a personal agent started not closing the dialog; a Claude Code routine closing it; a change on disk not
 * being seen on the next read. A temp data dir; no Inbox is started.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cloudAgentsPath } from "./inbox-cloud-agents";
import { personalAgentConnectedHere } from "./inbox-personal-agents";

let dataDir = "";
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "pa-connected-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const noThreads = { threadIds: () => [], message: () => undefined };
const writeCloud = (presets: string[]) => {
  const path = cloudAgentsPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const agents = presets.map((preset, i) => ({ session: `cloud.${String(i).padStart(12, "0")}`, name: preset, preset, url: null, key: null, project_id: null, created_at: "2026-11-01T00:00:00.000Z", key_set_at: null, key_rejected_at: null }));
  writeFileSync(path, JSON.stringify({ v: 1, agents }));
};

test("a cloud agent added in Settings: Hermes closes it, a Claude Code routine does not, read again on every call", () => {
  expect(personalAgentConnectedHere({ dataDir, config: {}, store: noThreads })).toBe(false);
  writeCloud(["claude-routine"]);
  expect(personalAgentConnectedHere({ dataDir, config: {}, store: noThreads })).toBe(false);
  writeCloud(["claude-routine", "hermes"]);
  expect(personalAgentConnectedHere({ dataDir, config: {}, store: noThreads })).toBe(true);
});

test("the Inbox tool turned on for OpenClaw closes it; turned off does not", () => {
  expect(personalAgentConnectedHere({ dataDir, config: { inboxTool: { openclaw: true } }, store: noThreads })).toBe(true);
  expect(personalAgentConnectedHere({ dataDir, config: { inboxTool: { openclaw: false, "claude-code": true } }, store: noThreads })).toBe(false);
});

test("a thread a personal agent started closes it; a coding agent's does not", () => {
  const store = (host: string) => ({ threadIds: () => ["t1"], message: () => ({ author: { kind: "agent", host, session: "s" } }) as never });
  expect(personalAgentConnectedHere({ dataDir, config: {}, store: store("claude-code") })).toBe(false);
  expect(personalAgentConnectedHere({ dataDir, config: {}, store: store("openclaw") })).toBe(true);
});
