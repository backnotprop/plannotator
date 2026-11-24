/**
 * The swarm view's rules (inbox-swarm.ts), shared by the window and the `swarm` action. What can regress: a state
 * read from an agent's own words, "idle" said of a host that reports no turns, a permission prompt in the agent's
 * terminal not counted as waiting on the person, a file shown for an agent with no live connection, and the thread
 * line's summary counting the wrong agents. The activity here is fake: the agent activity source fills it later.
 */
import { describe, expect, test } from "bun:test";
import { inboxSwarmMembers, inboxSwarmStateWords, inboxSwarmSummary, type InboxSwarmMemberInput } from "./inbox-swarm";

const time = (iso: string) => iso.slice(11, 16);
const input = (session: string, agent: InboxSwarmMemberInput["agent"], listed = true): InboxSwarmMemberInput => ({ machine: null, host: "claude-code", session, name: session, where: "ledger", agent, listed });
const live = { live: true, last_seen_at: "2026-11-24T14:29:00.000Z" };

describe("inboxSwarmMembers", () => {
  test("state comes from the connection; the line is the agent's own; files shared are flagged both ways", () => {
    const members = inboxSwarmMembers(
      [
        input("a", { ...live, state: "working", activity: { tool: "Edit", file: "refunds/round.ts", at: "2026-11-24T14:29:00.000Z" } }),
        input("b", { ...live, state: "idle", activity: { tool: "Read", file: "refunds/round.ts", at: "2026-11-24T14:28:00.000Z" } }),
        input("c", { ...live, state: "idle", activity: { tool: "Bash", at: "2026-11-24T14:28:00.000Z" } }),
      ],
      { doing: [{ session: "b", text: "Working hard", at: "2026-11-24T14:20:00.000Z" }] },
    );
    expect(members.map((m) => inboxSwarmStateWords(m, time))).toEqual(["working", "idle", "idle"]);
    expect(members[1]!.doing?.text).toBe("Working hard");
    expect(members[0]!.also).toEqual(["b"]);
    expect(members[1]!.also).toEqual(["a"]);
    expect(members[2]!.file).toBeNull();
  });

  test("no activity source yet: no file and no also for anyone", () => {
    const members = inboxSwarmMembers([input("a", { ...live, state: "working" }), input("b", { ...live, state: "idle" })], null);
    expect(members.map((m) => [m.file, m.also])).toEqual([[null, []], [null, []]]);
  });

  test("a permission prompt in its own terminal waits on the person, and says so; a question there waits too", () => {
    const members = inboxSwarmMembers(
      [
        input("a", { ...live, state: "working", status_mark: { state: "blocked", kind: "permission", where: "terminal" } }),
        input("b", { ...live, state: "idle", status_mark: { state: "blocked", kind: "question", where: "terminal" } }),
        input("c", { ...live, state: "working", status_mark: { state: "working" } }),
      ],
      null,
    );
    expect(members.map((m) => inboxSwarmStateWords(m, time))).toEqual(["waiting on you · permission prompt", "waiting on you", "working"]);
    expect(inboxSwarmSummary(members).more).toBe("2 waiting on you");
  });

  test("no live connection: no word since its last word, and no file; a host that reports no turns says nothing", () => {
    const members = inboxSwarmMembers(
      [
        input("a", { live: false, state: "ended", last_seen_at: "2026-11-24T14:16:00.000Z", activity: { tool: "Edit", file: "x.ts", at: "2026-11-24T14:15:00.000Z" } }),
        input("b", { ...live, state: "idle", turns_unknown: true }),
        input("c", null, true),
        input("d", null, false),
      ],
      null,
    );
    expect(members.map((m) => inboxSwarmStateWords(m, time))).toEqual(["no word since 14:16", "", "no word yet", "no word yet"]);
    expect(members[0]!.file).toBeNull();
  });

  test("the summary: who waits on the person first, else who works, else the count alone", () => {
    const of = (...states: ("working" | "idle" | "waiting")[]) => inboxSwarmSummary(inboxSwarmMembers(states.map((state, i) => input(`s${i}`, { ...live, state })), null));
    expect(of("working", "waiting", "idle")).toEqual({ count: "3 agents", more: "1 waiting on you" });
    expect(of("working", "working")).toEqual({ count: "2 agents", more: "2 working" });
    expect(of("idle", "idle")).toEqual({ count: "2 agents", more: null });
  });
});
