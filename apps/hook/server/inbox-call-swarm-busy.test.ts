/**
 * A paired cloud agent's `inbox call swarm` refused for rate (the hosted relay's 429, or the Inbox's), with the paired
 * call's one request stubbed (`CallCommandDeps.pairedTransport`): no relay, no Inbox. The failure this guards: a busy
 * answer that exits 1 as an error, so the agent thinks something broke and retries or stops, when nothing is wrong.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeInboxAgentPairing } from "@plannotator/shared/inbox/agent-pairing";
import type { InboxAgentRelayOutcome } from "@plannotator/shared/inbox/agent-relay-client";
import { INBOX_SWARM_BUSY_TEXT } from "@plannotator/shared/inbox/swarm-words";
import { runInboxCallCommand, type CallCommandDeps } from "./inbox-call-command";

const PAIRING = encodeInboxAgentPairing({
  device_id: "dev_01K7PAIRINGTEST00000000000",
  token: `tok_${"A".repeat(43)}`,
  secret: "B".repeat(43),
  relay: { url: "https://relay.example", mailbox_id: `mbx_${"C".repeat(22)}` },
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cloudMachine(answer: InboxAgentRelayOutcome) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-swarm-busy-")));
  roots.push(cwd);
  const out: string[] = [];
  const err: string[] = [];
  const deps: CallCommandDeps = {
    cwd,
    env: { PLANNOTATOR_PAIRING: PAIRING },
    ensureRunning: () => {
      throw new Error("a paired call must not look for an Inbox on this machine");
    },
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
    pairedTransport: async () => answer,
  };
  return { deps, out, err };
}

const CALL = ["swarm", JSON.stringify({ thread_id: "msg_01K7SWARMROOT000000000000", doing: "Writing tests" })];

describe("a busy swarm call through the pairing", () => {
  test("the relay's 429 (too many waiting) is a plain result with the busy words", async () => {
    const m = cloudMachine({ kind: "refused", code: "too_many_waiting", message: "Too many of your calls are already waiting." });
    expect(await runInboxCallCommand(CALL, m.deps)).toBe(0);
    expect(m.err).toEqual([]);
    expect(JSON.parse(m.out.join(""))).toEqual({ text: INBOX_SWARM_BUSY_TEXT });
  });

  test("the Inbox's own 429 is the same plain result", async () => {
    const m = cloudMachine({ kind: "answer", status: 429, body: JSON.stringify({ code: "rate_limited", error: "Slow down." }) });
    expect(await runInboxCallCommand(CALL, m.deps)).toBe(0);
    expect(JSON.parse(m.out.join(""))).toEqual({ text: INBOX_SWARM_BUSY_TEXT });
  });

  test("another action's 429 stays a refusal", async () => {
    const m = cloudMachine({ kind: "refused", code: "too_many_waiting", message: "Too many of your calls are already waiting." });
    expect(await runInboxCallCommand(["send_message", JSON.stringify({ body: "x" })], m.deps)).toBe(1);
    expect(m.err.join("")).toStartWith("too_many_waiting:");
  });
});
