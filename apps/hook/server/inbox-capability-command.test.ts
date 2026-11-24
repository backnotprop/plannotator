/**
 * `plannotator inbox capability` (inbox-capability-command.ts): what it asks the Inbox, and its help. No Inbox runs:
 * a stand-in for the Inbox's route. What regresses: a turn sent the wrong way or as someone else; a typo turning
 * something on; bad usage starting the Inbox; the Inbox's answer (the line it posted) not reaching stdout whole; a
 * `--computer` (gone with the one set: a turn applies on every linked computer) still taken and sent; a refusal
 * printed as a result; an Inbox too old for the command not said so; the help losing the rule that a turn is the
 * person's request, or still offering `--computer`.
 */
import { expect, test } from "bun:test";
import { INBOX_CAPABILITY_USAGE, parseCapabilityCommand, runInboxCapabilityCommand } from "./inbox-capability-command";

test("a turn is the capability and on, with the thread; nothing is a list", () => {
  expect(parseCapabilityCommand(["routines", "on", "--thread", "msg_1"])).toEqual({ ok: true, call: { capability: "routines", on: true, thread_id: "msg_1" }, session: null });
  expect(parseCapabilityCommand(["board", "off", "--session", "ses_1"])).toEqual({ ok: true, call: { capability: "board", on: false }, session: "ses_1" });
  expect(parseCapabilityCommand([])).toEqual({ ok: true, call: {}, session: null });
});

test("a capability it does not know, a state that is not on or off, a lone name, or a `--computer` is bad usage", () => {
  for (const argv of [["routine", "on"], ["routines", "yes"], ["routines"], ["routines", "on", "--computer", "Studio"], ["--computer", "Studio"], ["routines", "on", "--force"]]) {
    expect([argv, parseCapabilityCommand(argv).ok]).toEqual([argv, false]);
  }
});

function inbox(answer: (path: string, body: Record<string, unknown> | null) => { status: number; json: unknown }) {
  const asked: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let started = 0;
  const deps = {
    cwd: "/work/api",
    env: { CODEX_THREAD_ID: "019a2b3c-1111-7222-8333-444455556666" } as Record<string, string | undefined>,
    ensureRunning: async () => {
      started++;
      return {} as never;
    },
    out: async (text: string) => void out.push(text),
    err: (text: string) => void err.push(text),
    fetchRoute: async (path: string, init?: { method?: string; body?: string }) => {
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      asked.push({ method: init?.method ?? "GET", path, body });
      const { status, json } = answer(path, body);
      return Response.json(json, { status });
    },
  };
  return { deps, asked, out, err, started: () => started };
}

test("a turn is a POST as this shell's session, in its folder; the Inbox's answer is stdout, the line it posted included", async () => {
  const text = "Turned on Routines. The person sees it in thread msg_1.";
  const w = inbox(() => ({ status: 200, json: { text, capabilities: { routines: { on: true } } } }));
  expect(await runInboxCapabilityCommand(["routines", "on", "--thread", "msg_1"], w.deps)).toBe(0);
  expect(w.asked).toHaveLength(1);
  expect(w.asked[0]).toMatchObject({ method: "POST", path: "/api/inbox/capability", body: { capability: "routines", on: true, thread_id: "msg_1", project_path: "/work/api" } });
  expect(w.asked[0]!.body!.by).toMatchObject({ session: "019a2b3c-1111-7222-8333-444455556666", host: "codex" });
  expect(JSON.parse(w.out.join(""))).toEqual({ text, capabilities: { routines: { on: true } } });
});

test("a list is a read with nothing after the route; a `--computer` asks the Inbox nothing", async () => {
  const text = "On this computer: board on.";
  const w = inbox(() => ({ status: 200, json: { text, capabilities: { board: { on: true } } } }));
  expect(await runInboxCapabilityCommand([], w.deps)).toBe(0);
  expect(w.asked).toEqual([{ method: "GET", path: "/api/inbox/capability", body: null }]);
  expect(JSON.parse(w.out.join(""))).toEqual({ text, capabilities: { board: { on: true } } });
  const named = inbox(() => ({ status: 200, json: { text } }));
  expect(await runInboxCapabilityCommand(["board", "on", "--computer", "Studio"], named.deps)).toBe(2);
  expect([named.asked, named.started()]).toEqual([[], 0]);
});

test("a refusal is `<code>: <message>` on stderr, exit 1, nothing on stdout", async () => {
  const w = inbox(() => ({ status: 409, json: { code: "not_offered", error: "Routines is not offered on this computer." } }));
  expect(await runInboxCapabilityCommand(["routines", "on"], w.deps)).toBe(1);
  expect([w.out, w.err.join("")]).toEqual([[], "not_offered: Routines is not offered on this computer.\n"]);
});

test("an Inbox from before the command says to update, here (its unknown-route 404) and through the agent door (its route's refusal); a refusal of the new route does not", async () => {
  const run = async (status: number, json: unknown, argv = ["routines", "on"]) => {
    const w = inbox(() => ({ status, json }));
    const code = await runInboxCapabilityCommand(argv, w.deps);
    return [code, w.out.join(""), w.err.join("").split(":")[0]];
  };
  // main's unknown /api/ route on this computer (packages/server/inbox.ts), a read and a turn.
  expect(await run(404, { error: "Not found", code: "not_found" })).toEqual([1, "", "inbox_needs_update"]);
  expect(await run(404, { error: "Not found", code: "not_found" }, [])).toEqual([1, "", "inbox_needs_update"]);
  // Through the agent door (inboxPairedRouteFetch's 502): the older door's `route` names the requests it carries, not this one.
  expect(await run(502, { code: "validation_error", error: "method, path: one of the requests plannotator inbox rows, projects, icon and export-decisions make." })).toEqual([1, "", "inbox_needs_update"]);
  // This Inbox's own refusals are said as they are.
  expect(await run(502, { code: "validation_error", error: "method, path: one of the requests plannotator inbox rows, projects, icon, capability and export-decisions make." })).toEqual([1, "", "validation_error"]);
  expect(await run(409, { code: "not_offered", error: "Routines is not offered on this computer." })).toEqual([1, "", "not_offered"]);
  expect(await run(502, { code: "queued", error: "The person's computer is asleep or offline." })).toEqual([1, "", "queued"]);
});

test("help and bad usage ask the Inbox nothing: help on stdout with exit 0, bad usage exit 2", async () => {
  const w = inbox(() => ({ status: 200, json: { text: "" } }));
  expect(await runInboxCapabilityCommand(["--help"], w.deps)).toBe(0);
  expect(w.out.join("")).toContain("Turn one on or off when the person asks you to; not on your own initiative.");
  // A turn applies on every linked computer: the help names no computer to pick.
  expect(w.out.join("")).not.toContain("--computer");
  expect(await runInboxCapabilityCommand(["routines", "maybe"], w.deps)).toBe(2);
  expect(w.err.join("")).toContain(INBOX_CAPABILITY_USAGE.split("\n")[0]!);
  expect([w.asked, w.started()]).toEqual([[], 0]);
});
