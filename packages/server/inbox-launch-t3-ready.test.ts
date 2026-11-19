/**
 * Starting an agent in T3 Code in a folder T3 doesn't know yet, or while T3 Code isn't running (issue #3590). A folder
 * T3 doesn't know ("No T3 Code project matches '.'", seen on a real T3 0.1.9 on 2026-11-18) is added with T3's own
 * `t3 project add`, with no step for the person; a project T3 just added has no default model, so the start names
 * one. T3 Code not running is never "fixed" by opening its app: the agent starts in the background and its line
 * says so, as for Rex.
 *
 * The launch engine and the real T3 runner against the T3 stand-in (tests/helpers/fake-t3.ts), the agents' own hosts
 * standing in. No Inbox server, no app opened, no T3 run.
 */
import { afterEach, expect, test } from "bun:test";
import { t3LastLine, T3_NO_PROJECT, T3_NOT_RUNNING, t3ProjectAdded } from "./inbox-launch-t3-ready";
import { CAPABILITIES, t3LaunchSetup, until } from "../../tests/helpers/t3-launch";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

test("a folder T3 doesn't know, just added, with no default model: added once with `project add`, then one thread on T3's first model for the agent", async () => {
  const t = t3LaunchSetup(cleanup, { known: false, capabilities: CAPABILITIES });
  const root = await t.send("Tighten the checkout copy.");
  const session = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
  expect(t.t3!.added()).toEqual([t.shop]);
  expect(t.t3!.starts()).toEqual([expect.objectContaining({ id: session, provider: "claudeAgent", model: "opus" })]);
  const verbs = t.t3!.calls().map((args) => args.slice(0, args[0] === "auth" ? 3 : 2).join(" "));
  // The revoke runs beside the start (not waited on), so it may be logged either side of it.
  expect(verbs.filter((v) => v !== "auth session revoke")).toEqual(["project add", "thread list", "auth session issue", "thread start"]);
  await until("revoked", () => t.t3!.revoked().length === 1);
});

test("T3 Code closed: nothing tries to open it; the agent starts in the background and its record says why", async () => {
  const t = t3LaunchSetup(cleanup, { capabilities: CAPABILITIES });
  t.t3!.setState("down");
  const root = await t.send("Tighten the checkout copy.");
  await until("started in the background", () => t.store.message(root.id)!.launch!.session_ref);
  expect(t.store.message(root.id)!.launch!.t3).toEqual({ unavailable: true });
  expect(t.t3!.calls()).toEqual([]);
});

test("T3's words: a folder in no project, T3 not running, and what counts as added", () => {
  expect(T3_NOT_RUNNING.test(t3LastLine("No running T3 Code server uses /Users/someone/.t3. Start T3 Code, then retry."))).toBe(true);
  expect(T3_NOT_RUNNING.test(t3LastLine("noise\nCould not reach the T3 Code server at http://127.0.0.1:9. connect ECONNREFUSED\n"))).toBe(true);
  expect(T3_NO_PROJECT.test(t3LastLine("No T3 Code project matches '.'. Pass a project id or a path inside a project."))).toBe(true);
  expect(T3_NOT_RUNNING.test(t3LastLine("Model 'retired' is not available for provider instance 'codex'."))).toBe(false);
  expect(t3ProjectAdded({ exitCode: 0, stdout: "Added project p (shop) at /x/shop.", stderr: "" })).toBe(true);
  expect(t3ProjectAdded({ exitCode: 1, stdout: "", stderr: "An active project already exists for '/x/shop'." })).toBe(true);
  expect(t3ProjectAdded({ exitCode: 1, stdout: "", stderr: "Something went wrong." })).toBe(false);
  expect(t3ProjectAdded({ exitCode: null, timedOut: true, stdout: "", stderr: "" })).toBe(false);
});
