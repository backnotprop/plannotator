/**
 * A session started by hand in Oh My Pi is named "Oh My Pi", not "Pi" (#3443). Oh My Pi loads Plannotator's Pi
 * extension, which polls as host `pi` and says `plugin.host: "oh-my-pi"`. The failures this catches: that session read
 * as Pi in the To picker or the Agents sidebar (no `runtime` on the compose session or the agent), its messages stored
 * under "Pi" (the `/mcp` call's `agent_name` not set from the runtime), a plain Pi session or another agent renamed, a
 * `runtime` some other machine sent taken for a name, and an older extension (no `plugin.host`) shown as anything but Pi.
 *
 * In-process: the live sessions over a temp store and the pure helpers; no Inbox server starts. The same over a real
 * Inbox (the `/mcp` door and the routes) is inbox-oh-my-pi-over-inbox.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxAgentName, inboxHostName } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxAgentsGroup, inboxStartOfDay } from "./inbox-agents-list";
import { withRuntimeAgentName } from "./inbox-runtime-name";
import { createInboxLiveSessions } from "./inbox-sessions";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function liveSessions() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-omp-name-")));
  roots.push(root);
  const clock = { t: new Date(2026, 10, 26, 12, 0, 0).getTime() };
  const live = createInboxLiveSessions({ store: InboxStore.open(join(root, "data")), serverSession: "srv", resolveRoot: async (path) => path, now: () => clock.t });
  const poll = async (session: string, host: string, fields: Record<string, unknown> = {}) => (await live.pollStarted(session, host, { project_path: "/work/harbor", ...fields }))();
  return { live, clock, poll };
}

const OMP_PLUGIN = { version: "0.28.70", on_disk: "0.28.70", host: "oh-my-pi" };
const PI_PLUGIN = { version: "0.28.70", on_disk: "0.28.70", host: "pi" };

describe("the name", () => {
  test("a Pi session in Oh My Pi is Oh My Pi; Pi, an older extension and a runtime that is not one stay as they are", () => {
    expect(inboxHostName("pi", "oh-my-pi")).toBe("Oh My Pi");
    expect(inboxHostName("pi")).toBe("Pi");
    expect(inboxHostName("pi", "pi")).toBe("Pi");
    expect(inboxHostName("pi", "<b>Evil</b>")).toBe("Pi");
    expect(inboxHostName("codex", "oh-my-pi")).toBe("Codex");
    expect(inboxHostName("mystery-agent")).toBe("mystery-agent");
  });
});

describe("the live sessions", () => {
  test("a poll that says plugin.host oh-my-pi carries runtime to compose and the Agents list; a Pi poll and an older one carry none", async () => {
    const { live, clock, poll } = liveSessions();
    await poll("omp-1", "pi", { plugin: OMP_PLUGIN });
    await poll("pi-1", "pi", { plugin: PI_PLUGIN });
    await poll("pi-old", "pi", { plugin: { version: "0.28.10" } });
    await poll("cc-1", "claude-code", { plugin: { version: "0.28.70", host: "oh-my-pi" } });
    const runtimes = Object.fromEntries(live.allLive().map((s) => [s.session, s.runtime ?? null]));
    expect(runtimes).toEqual({ "omp-1": "oh-my-pi", "pi-1": null, "pi-old": null, "cc-1": null });
    const group = inboxAgentsGroup({
      sessions: live.agentSessions(inboxStartOfDay(clock.t)),
      launches: [],
      waits: [],
      archived: new Set(),
      projectOf: () => ({ id: "prj_harbor", name: "harbor" }),
      projectById: (id) => ({ id, name: "harbor" }),
      lastHeardOf: () => null,
      continuedBy: () => null,
      continuesOf: () => [],
      labels: true,
    });
    const agent = (id: string) => group.agents.find((a) => a.id === id)!;
    expect(agent("omp-1")).toMatchObject({ host: "pi", runtime: "oh-my-pi" });
    expect(inboxHostName(agent("omp-1").host!, agent("omp-1").runtime)).toBe("Oh My Pi");
    expect("runtime" in agent("pi-1")).toBe(false);
    expect("runtime" in agent("cc-1")).toBe(false);
    expect(live.runtimeOfSession("omp-1")).toBe("oh-my-pi");
    expect(live.runtimeOfSession("pi-1")).toBeUndefined();
    expect(live.runtimeOfSession("nobody")).toBeUndefined();
  });
});

describe("what its messages are stored under", () => {
  const call = (session: string, host: string, name?: string) => ({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "send_message", arguments: { body: "Done.", agent_session: session, agent_host: host, ...(name === undefined ? {} : { agent_name: name }) } },
  });
  const runtimeOf = (session: string) => (session === "omp-1" ? ("oh-my-pi" as const) : undefined);
  const nameOf = (body: unknown) => (body as ReturnType<typeof call>).params.arguments.agent_name;

  test("the extension's Pi in Oh My Pi becomes Oh My Pi, one call or a batch; the rest of the call is untouched", () => {
    const one = withRuntimeAgentName(call("omp-1", "pi", "Pi"), runtimeOf);
    expect(nameOf(one)).toBe("Oh My Pi");
    expect(one).toMatchObject({ id: 1, params: { name: "send_message", arguments: { body: "Done.", agent_session: "omp-1", agent_host: "pi" } } });
    expect(inboxAgentName({ kind: "agent", host: "pi", name: nameOf(one) })).toBe("Oh My Pi");
    const batch = withRuntimeAgentName([call("pi-1", "pi", "Pi"), call("omp-1", "pi", "Pi")], runtimeOf) as unknown[];
    expect(batch.map(nameOf)).toEqual(["Pi", "Oh My Pi"]);
  });

  test("a plain Pi session, another host, a name the agent chose and a call that is not a tool call are left alone", () => {
    expect(withRuntimeAgentName(call("pi-1", "pi", "Pi"), runtimeOf)).toBeNull();
    expect(withRuntimeAgentName(call("omp-1", "claude-code", "Claude Code"), runtimeOf)).toBeNull();
    expect(withRuntimeAgentName(call("omp-1", "pi", "Reviewer bot"), runtimeOf)).toBeNull();
    expect(withRuntimeAgentName({ jsonrpc: "2.0", id: 2, method: "tools/list" }, runtimeOf)).toBeNull();
    expect(withRuntimeAgentName([call("pi-1", "pi", "Pi")], runtimeOf)).toBeNull();
    expect(withRuntimeAgentName(undefined, runtimeOf)).toBeNull();
  });
});
