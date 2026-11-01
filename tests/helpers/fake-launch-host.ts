/**
 * The launch engine's test fake (`LaunchHost`, packages/server/inbox-launch-host.ts): an in-memory agent whose sessions
 * a test connects, works and idles by hand. `start` makes a session that is not connected; the test works and idles it
 * (`poll`), and asks its permission questions (`ask`). `faults` says what goes wrong. Registered through
 * `createInboxLaunch`'s `hosts` option, or `startInboxServer`'s `launchHosts`.
 */
import type { InboxLaunchAgent, InboxMessage } from "@plannotator/core/inbox-types";
import type { LaunchHost, LaunchLive, LaunchTrustOffer } from "../../packages/server/inbox-launch-host";
import { createLaunchQuestions } from "../../packages/server/inbox-launch-permission";

/** Not an agent the product knows (`InboxLaunchAgent` is Claude Code's alone until the next agent widens it). */
export const FAKE = "fake-agent" as InboxLaunchAgent;

export function fakeLaunchHost() {
  const calls: string[] = [];
  /** What the test makes go wrong. `trusted`: the folders it does not trust are the ones `trusted` says no to. */
  const faults: { resumeThrows: boolean; gate: Promise<void> | null; untrusted: boolean; resumeUntrusted: boolean; offer: LaunchTrustOffer | null; trusted: (folder: string) => boolean } = {
    resumeThrows: false,
    gate: null,
    untrusted: false,
    resumeUntrusted: false,
    offer: null,
    trusted: () => true,
  };
  let questions: ReturnType<typeof createLaunchQuestions> | null = null;
  const sessions = new Map<string, { ref: string; live: LaunchLive | null; state: "running" | "stopped" }>();
  const byRef = (ref: string) => [...sessions.values()].find((s) => s.ref === ref);
  const host: LaunchHost = {
    agent: FAKE,
    name: "Fake Agent",
    shellNames: [],
    available: async () => ({ ok: true, version: "1.0.0" }),
    startOf: () => ({ full: false, ownMode: false, bypass: false }),
    trusts: (folder) => faults.trusted(folder),
    trustOffer: () => faults.offer,
    async start(_launch, input) {
      calls.push(`start ${input.name}`);
      if (faults.untrusted) return { ok: false, code: "untrusted", text: "The folder isn't trusted yet." };
      const ref = `f${sessions.size + 1}`;
      sessions.set(`session-${ref}`, { ref, live: null, state: "running" });
      return { ok: true, session: `session-${ref}`, ref };
    },
    sessions: async () => (ref) => {
      const session = byRef(ref);
      return session ? { status: session.live?.busy ? "busy" : "idle", state: session.state, waitingFor: null } : "absent";
    },
    live: (session) => sessions.get(session)?.live ?? null,
    async resume(launch) {
      calls.push(`resume ${launch.session_ref}`);
      if (faults.resumeThrows) throw new Error("the host broke");
      if (faults.resumeUntrusted) return { exitCode: 1, text: "", failure: { code: "untrusted", text: "The folder isn't trusted yet." } };
      byRef(launch.session_ref!)!.state = "running";
      return { exitCode: 0, text: "", failure: null };
    },
    async stop(ref) {
      calls.push(`stop ${ref}`);
      const session = byRef(ref)!;
      // As OpenCode's: not live from the moment the stop begins; the stop itself takes a while (`gate`).
      session.state = "stopped";
      session.live = null;
      await faults.gate;
      return { exitCode: 0, text: "" };
    },
    async remove(ref) {
      calls.push(`remove ${ref}`);
      await faults.gate;
      return { exitCode: 0, text: "" };
    },
    purge: async (folder) => (calls.push(`purge ${folder}`), { exitCode: 0, text: "" }),
    attach: (launch) => (launch.session_ref ? `fake attach ${launch.session_ref}` : null),
    terminal: (launch) => `fake attach ${launch.session_ref}`,
    // Pushed prompts: no hook route; its questions are written by the shared question code.
    permissions(ctx) {
      questions = createLaunchQuestions({ store: ctx.store, name: "Fake Agent", displayFolder: ctx.displayFolder, onChange: ctx.onChange, log: () => {} });
      return {
        sweep() {},
        withdrawAll(root) {
          calls.push(`withdrawAll ${root.launch!.session_ref}`);
          questions!.withdrawAll(root);
        },
      };
    },
  };
  /** The session polls: live, busy or idle; each poll shows new life. */
  const poll = (session: string, busy: boolean, at: number) => {
    const s = sessions.get(session)!;
    s.live = { busy, busySince: busy ? (s.live?.busySince ?? at) : null, polls: (s.live?.polls ?? 0) + 1 };
  };
  /** The session asks to run a command: the question lands in the launch's thread. */
  const ask = (root: InboxMessage, session: string) => {
    const event = { session_id: session, tool_name: "Bash", tool_input: { command: "ls" }, cwd: root.launch!.folder, permission_suggestions: [], permission_mode: null };
    return questions!.ask(root, event, "req-1", questions!.questionFor(root, event, {}))!;
  };
  return { host, calls, poll, ask, faults };
}
