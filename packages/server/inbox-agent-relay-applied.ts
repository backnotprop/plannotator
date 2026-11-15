import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_AGENT_RELAY_APPLIED_FILE = "agent-relay-applied.jsonl";
export const INBOX_AGENT_RELAY_APPLIED_KEPT_MS = 24 * 60 * 60 * 1000;
const ANSWER_KEPT_MAX_BYTES = 256 * 1024;

interface AppliedLine {
  v: 1;
  at: number;
  device_id: string;
  id: string;
  status: number;
  body: string | null;
}

export interface InboxAgentRelayApplied {
  answerOf: (deviceId: string, id: string) => Response | null;
  record: (deviceId: string, id: string, status: number, body: string) => void;
}

export function createInboxAgentRelayApplied(dataDir: string, now: () => number = Date.now): InboxAgentRelayApplied {
  const dir = inboxDir(dataDir);
  const path = join(dir, INBOX_AGENT_RELAY_APPLIED_FILE);
  const seen = new Map<string, AppliedLine>();
  const slot = (deviceId: string, id: string) => `${deviceId}\n${id}`;
  const fresh = (line: AppliedLine) => now() - line.at < INBOX_AGENT_RELAY_APPLIED_KEPT_MS;

  try {
    for (const text of readFileSync(path, "utf8").split("\n")) {
      if (!text) continue;
      try {
        const line = JSON.parse(text) as AppliedLine;
        if (line?.v === 1 && typeof line.device_id === "string" && typeof line.id === "string" && typeof line.at === "number" && fresh(line)) seen.set(slot(line.device_id, line.id), line);
      } catch {
        continue;
      }
    }
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, [...seen.values()].map((line) => `${JSON.stringify(line)}\n`).join(""), { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    seen.clear();
  }

  return {
    answerOf: (deviceId, id) => {
      const line = seen.get(slot(deviceId, id));
      if (!line || !fresh(line)) return null;
      const body = line.body ?? JSON.stringify({ error: "This command was already applied.", code: "command_already_applied" });
      return new Response(body, { status: line.body === null ? 409 : line.status, headers: { "Content-Type": "application/json; charset=utf-8" } });
    },
    record: (deviceId, id, status, body) => {
      const line: AppliedLine = { v: 1, at: now(), device_id: deviceId, id, status, body: Buffer.byteLength(body) <= ANSWER_KEPT_MAX_BYTES ? body : null };
      seen.set(slot(deviceId, id), line);
      for (const [key, old] of seen) if (!fresh(old)) seen.delete(key);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      try {
        chmodSync(path, 0o600);
      } catch {
        return;
      }
    },
  };
}
