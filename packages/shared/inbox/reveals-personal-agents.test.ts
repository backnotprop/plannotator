/**
 * The personal agents dialog in the line (reveals.ts `personal_agents`; the owner, 2026-11-12: "Only people with no
 * personal agent connected, after a few days of use", "Maybe after 2days of use", and "Tags first" when both ship).
 *
 * What regresses: its place (right after Snooze, so a tags entry added right after Snooze comes before it, and before
 * the Board); its two days of use moving; it being due with a personal agent connected (the server's `open`); a Claude
 * Code routine counting as a personal agent, or a Hermes, OpenClaw, Muse, Grok Bot or "Other" one not counting;
 * Escape (its Not now) not holding the next offer three days.
 */
import { describe, expect, test } from "bun:test";
import { personalAgentConnected } from "@plannotator/core/inbox-personal-agents";
import { INBOX_REVEALS, REVEAL_NOT_NOW_SPACING_MS, revealNext, revealNotNowAllowed, type RevealEntry, type RevealState } from "./reveals";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-12T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const state = (over: Partial<RevealState> = {}): RevealState => ({ release: true, firstUseAt: ago(3 * DAY), threads: 1, open: { personal_agents: true }, waitingSince: {}, ...over });

describe("its place in the line", () => {
  test("right after Snooze and before the Board: Snooze goes first, then personal agents, then the Board", () => {
    const ids = INBOX_REVEALS.map((entry) => entry.id);
    expect(ids.indexOf("personal_agents")).toBe(ids.indexOf("snooze") + 1);
    const day4 = { firstUseAt: ago(4 * DAY), threads: 6 };
    expect(revealNext(state({ ...day4, open: { snooze: true, personal_agents: true, board: true } }), NOW)).toBe("snooze");
    expect(revealNext(state({ ...day4, open: { personal_agents: true, board: true } }), NOW)).toBe("personal_agents");
  });

  test("a tags entry added right after Snooze goes before it (the owner: tags first)", () => {
    const tags = { id: "tags", kind: "offer", tenureMs: 2 * DAY, minThreads: 0, enabled: true } as unknown as RevealEntry;
    const table = [...INBOX_REVEALS];
    table.splice(table.findIndex((entry) => entry.id === "snooze") + 1, 0, tags);
    const open = { personal_agents: true, tags: true } as RevealState["open"];
    expect(revealNext(state({ open }), NOW, table)).toBe("tags" as never);
  });
});

describe("who", () => {
  test("from two days of use, not before", () => {
    expect(revealNext(state({ firstUseAt: ago(2 * DAY - 1) }), NOW)).toBeNull();
    expect(revealNext(state({ firstUseAt: ago(2 * DAY) }), NOW)).toBe("personal_agents");
    expect(revealNext(state({ firstUseAt: null }), NOW)).toBeNull();
  });

  test("never while a personal agent is connected (the server reports it closed), whatever else holds", () => {
    expect(revealNext(state({ firstUseAt: ago(30 * DAY), threads: 50, open: { personal_agents: false } }), NOW)).toBeNull();
  });

  test("Escape is a Not now: the next offer waits three days", () => {
    expect(revealNotNowAllowed("personal_agents")).toBe(true);
    expect(revealNext(state({ open: { board: true }, threads: 6, firstUseAt: ago(4 * DAY), notNowAt: ago(REVEAL_NOT_NOW_SPACING_MS - 1) }), NOW)).toBeNull();
  });
});

describe("a personal agent connected", () => {
  const none = { cloudPresets: [] as string[], toolOn: () => false, threadAuthorHosts: () => [] as string[] };

  test("each personal cloud agent counts; a Claude Code routine does not", () => {
    for (const preset of ["hermes", "openclaw", "muse", "grok-bot", "other"]) expect(personalAgentConnected({ ...none, cloudPresets: [preset] })).toBe(true);
    expect(personalAgentConnected({ ...none, cloudPresets: ["claude-routine"] })).toBe(false);
    expect(personalAgentConnected(none)).toBe(false);
  });

  test("the Inbox tool on for OpenClaw or Hermes Agent counts", () => {
    expect(personalAgentConnected({ ...none, toolOn: (host) => host === "openclaw" })).toBe(true);
    expect(personalAgentConnected({ ...none, toolOn: (host) => host === "hermes" })).toBe(true);
  });

  test("a thread started by one counts; one by a coding agent or a Claude Code routine does not", () => {
    expect(personalAgentConnected({ ...none, threadAuthorHosts: () => ["claude-code", "codex", "cloud-claude", null] })).toBe(false);
    for (const host of ["openclaw", "hermes", "cloud-hermes", "cloud-openclaw", "cloud-muse", "cloud-grok", "cloud"]) expect(personalAgentConnected({ ...none, threadAuthorHosts: () => [host] })).toBe(true);
  });
});
