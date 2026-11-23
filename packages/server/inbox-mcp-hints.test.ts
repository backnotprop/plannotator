/**
 * send_message's quiet hints (approval "inbox-quiet-hints"; the PR lines in
 * the owner's words of 2026-11-15): a line per PR the body names that is on
 * no thread's row, or one line when it asks a question with options that
 * carry no pros, cons or prototype. The failures these guard: a line on a
 * message that is right (the PR is on a row, was passed in `pulls`, the
 * number is an issue's or unknown, the link sits in code), a thread told
 * twice about one PR, a thread not told because another thread was, more
 * than three PR lines, two kinds on one send, and a hint on a refused send.
 * The picture-choices advice is not a quiet hint: it is said every time.
 *
 * A real store in a temp dir and send_message's own handler; no Inbox
 * server, no network: the lookup after a send reads a stand-in forge.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_THREAD_PULLS_MAX, parseInboxThreadPullRefs } from "@plannotator/core/inbox-types";
import { inboxToolResultText } from "@plannotator/shared/inbox/connection";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";
import { createInboxPullLookups } from "./inbox-pull-lookups";
import { attachPullText, pullsNamedInBody, pullsToLookUp, QUESTION_OPTIONS_HINT, questionWithBareOptions, quietHint, type InboxKnownPulls } from "./inbox-mcp-hints";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PR = "https://github.com/acme/api/pull/12";
const ask = (kind: string, ...lines: string[]) => [`:::${kind}`, "Which retry policy?", "", ...lines, ":::"].join("\n");
const BARE = ask("question", "- [ ] Fixed delay", "- [ ] Backoff", "- [ ] Backoff with jitter");
const keys = (body: string, known?: InboxKnownPulls) => pullsNamedInBody(body, null, known).map((ref) => ref.key);
/** The approved line, word for word. */
const nudge = (label: string, add: string) => `You named ${label}, which is on no thread's row. If it is this work's PR, attach it: thread_pulls with add ["${add}"].`;
/** What the Inbox knows: the project is acme/api on github.com, and these keys are PRs (any other number is an issue or unknown). */
const knowing = (...pulls: string[]): InboxKnownPulls => ({ repo: { host: "github.com", repo: "acme/api" }, isPull: (key) => pulls.includes(key) });

type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

function world(options: { projectHost?: InboxMcpContext["projectHost"]; known?: InboxKnownPulls } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-hints-")));
  roots.push(root);
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "api", root: join(root, "api") });
  const context = {
    store,
    baseUrl: () => "http://localhost:1/",
    resolveProject: async () => project,
    projectHost: options.projectHost,
    knownPulls: options.known ? (projectId: string) => (projectId === project.id ? options.known! : null) : undefined,
  } as unknown as InboxMcpContext;
  const server = createInboxMcpServer(context) as unknown as { _registeredTools: Record<string, { handler: (input: Record<string, unknown>, ctx: unknown) => Promise<Result> }> };
  const send = async (session: string, input: Record<string, unknown>) => {
    const result = await server._registeredTools.send_message!.handler({ project_path: project.root, agent_session: session, agent_host: "claude-code", ...input }, {});
    const lines = result.content[0]!.text.split("\n");
    return { result, lines, last: lines.at(-1)!, id: result.structuredContent?.message_id as string, thread: String(result.structuredContent?.thread_id) };
  };
  return { store, project, send };
}

test("a #N only in a picture's alt text or caption, or in a URL, names no PR; the same #N in prose does, and the agent reads that line once", async () => {
  const w = world({ known: knowing("github.com/acme/api#411") });
  const quiet = await w.send("ses_a", { body: 'Before and after:\n\n![Header after #411](shots/after.png "the fix for #411")\n\nSee https://example.com/notes#411.', thread: "pictures" });
  expect(quiet.lines).toHaveLength(1);
  const named = await w.send("ses_a", { body: "This lands #411.", thread: "prose" });
  expect(named.last).toBe(nudge("#411", "acme/api#411"));
  expect(inboxToolResultText(named.result).text.split(named.last)).toHaveLength(2);
});

test("a PR's URL or a GitLab short ref in the agent's words is read; code, quotes, issues and unknown numbers are not", () => {
  expect(keys(`Opened ${PR} for this.`)).toEqual(["github.com/acme/api#12"]);
  expect(keys(`See [the PR](${PR}/files) and acme/web!7.`)).toEqual(["github.com/acme/api#12", "gitlab.com/acme/web#7:pull"]);
  expect(keys(["```sh", `gh pr view ${PR}`, "```", `and \`${PR}\``].join("\n"))).toEqual([]);
  expect(keys(`> you said ${PR}\nYes.`)).toEqual([]);
  expect(keys("Tracked in https://github.com/acme/api/issues/12.")).toEqual([]);
  expect(keys("Opened https://bitbucket.org/acme/api/pull-requests/3/diff and https://bitbucket.org/acme/api/issues/4.")).toEqual(["bitbucket.org/acme/api#3:pull"]);
  // `owner/repo#12` and a bare `#12` may each be an issue: only a number the Inbox knows as a PR counts.
  expect(keys("Follows acme/api#12 and #13. Done!")).toEqual([]);
  expect(keys("Follows acme/web#12, #13 and #14 (an issue).", { ...knowing("github.com/acme/web#12", "github.com/acme/api#13"), repo: { host: "github.com", repo: "acme/api" } })).toEqual([
    "github.com/acme/web#12",
    "github.com/acme/api#13",
  ]);
  // Not a number the agent named: code, a quote, an HTML entity, a link's fragment.
  expect(keys(["`#13`", "> #13", "&#13;", "see page#13", "```", "#13", "```"].join("\n"), knowing("github.com/acme/api#13"))).toEqual([]);
  expect(keys("PR#13 is up.", knowing("github.com/acme/api#13"))).toEqual(["github.com/acme/api#13"]);
});

test("a question counts with three or more choices and no pros, cons, prototype or scenario table anywhere", () => {
  const three = ["- [ ] Fixed delay", "- [ ] Backoff", "- [ ] Backoff with jitter"];
  expect(questionWithBareOptions(BARE)).toBe(true);
  expect(questionWithBareOptions(ask("question-multi", "- [ ] Yes", "- [ ] No", "- [ ] Later"))).toBe(true);
  // Two choices (a yes/no) no longer count (approval "question-scenario-table", 2026-11-23).
  expect(questionWithBareOptions(ask("question", "- [ ] Fixed delay", "- [ ] Backoff"))).toBe(false);
  expect(questionWithBareOptions(ask("question-multi", "- [ ] Yes", "- [ ] No"))).toBe(false);
  expect(questionWithBareOptions(ask("question", three[0]!, "    Pros: simple", three[1]!, three[2]!))).toBe(false);
  expect(questionWithBareOptions(ask("question", three[0]!, "    Cons: thundering herd", three[1]!, three[2]!))).toBe(false);
  expect(questionWithBareOptions(ask("question", three[0]!, "    Prototype: proto/a.html", three[1]!, three[2]!))).toBe(false);
  expect(questionWithBareOptions(ask("question", ...three, "Prototype: proto/both.html"))).toBe(false);
  // A scenario table already compares the options.
  const table = ["", "| Situation | Fixed delay | Backoff | Backoff with jitter |", "| --- | --- | --- | --- |", "| The API is down an hour | Hammers it — every 5 s | Backs off — fewer calls | Backs off — spread out |"];
  expect(questionWithBareOptions(ask("question", ...three, ...table))).toBe(false);
  // A table that names no choice is context: the question still counts.
  expect(questionWithBareOptions(ask("question", ...three, ...table.map((l) => l.replace("Fixed delay", "Something else"))))).toBe(true);
  expect(questionWithBareOptions(ask("question", "- [ ] Only this"))).toBe(false);
  expect(questionWithBareOptions(ask("question-text"))).toBe(false);
  expect(questionWithBareOptions([":::action", "Rotate the key", "- [ ] In the console", "- [ ] With the CLI", "- [ ] Both", ":::"].join("\n"))).toBe(false);
});

test("a bare #N the Inbox knows as the project's PR is named once per thread; the same thread again is quiet, another thread hears it; an issue's number never", async () => {
  const w = world({ known: knowing("github.com/acme/api#3405") });
  const first = await w.send("ses_a", { body: "Opened #3405; it is like issue #7.", thread: "one" });
  expect(first.result.isError).toBeUndefined();
  expect(first.lines[0]).toStartWith("Sent to the Plannotator Inbox");
  expect(first.lines).toHaveLength(2);
  expect(first.last).toBe(nudge("#3405", "acme/api#3405"));
  expect(first.result.structuredContent!.hint).toBe(first.last);
  // The same thread, any session: told already.
  expect((await w.send("ses_a", { body: "#3405 is green.", reply_to: first.id })).lines).toHaveLength(1);
  // (Its one extra line is the "not read this thread" one.)
  expect((await w.send("ses_b", { body: "Reviewing #3405.", reply_to: first.id })).result.content[0]!.text).not.toContain("You named");
  // Another thread, the same session: still on no row, so said there too.
  expect((await w.send("ses_a", { body: "Follow-up to #3405.", thread: "two" })).last).toBe(nudge("#3405", "acme/api#3405"));
  // An issue's number (not a PR the Inbox knows): nothing.
  expect((await w.send("ses_a", { body: "Fixes #7.", thread: "three" })).lines).toHaveLength(1);
});

test("owner/repo#N and a URL count; the line names the ref an agent passes back", async () => {
  const w = world({ known: knowing("github.com/acme/web#12") });
  const sent = await w.send("ses_a", { body: "Opened acme/web#12 and https://github.com/acme/api/pull/13; #99 is unknown here." });
  expect(sent.lines.slice(1)).toEqual([nudge("#12", "acme/web#12"), nudge("#13", "acme/api#13")]);
});

test("no PR line when the PR is on any thread's row, passed in this send's pulls (even refused), or taken off this thread", async () => {
  const w = world({ known: knowing("github.com/acme/api#3405", "github.com/acme/api#3406") });
  const now = await w.send("ses_a", { body: "Opened #3405.", pulls: ["acme/api#3405"], thread: "one" });
  expect(now.lines).toHaveLength(1);
  expect(now.lines[0]).toContain("PRs: Added acme/api#3405.");
  // On another thread's row: a roll-up that lists it is quiet.
  expect((await w.send("ses_b", { body: "Release notes: #3405.", thread: "release" })).lines).toHaveLength(1);
  // This send's own `pulls`, refused because the thread holds its 20: no line telling it to add what it just tried.
  const full = await w.send("ses_a", { body: "Busy thread.", thread: "full" });
  const twenty = parseInboxThreadPullRefs(Array.from({ length: INBOX_THREAD_PULLS_MAX }, (_, i) => `acme/other#${i + 1}`), "add").refs!;
  w.store.changeThreadPulls({ thread_id: full.thread, add: twenty, by: { kind: "person" } });
  const refused = await w.send("ses_a", { body: "Opened #3406.", pulls: ["acme/api#3406"], reply_to: full.id });
  expect(refused.result.content[0]!.text).toContain("PRs not added");
  expect(refused.result.content[0]!.text).not.toContain("You named");
  // The person took it off this thread: never asked back here.
  const threadId = now.thread;
  w.store.changeThreadPulls({ thread_id: threadId, add: [], remove: parseInboxThreadPullRefs(["acme/api#3405"], "remove").refs!, by: { kind: "person" } });
  const known = knowing("github.com/acme/api#3405");
  expect(quietHint(w.store, { session: "ses_a", threadId, body: "#3405 again", replayed: false, known })).toBeNull();
  // Off this thread is not off every thread: another thread naming it hears the line.
  expect(quietHint(w.store, { session: "ses_a", threadId: refused.thread, body: "#3405 again", replayed: false, known })?.line).toBe(nudge("#3405", "acme/api#3405"));
});

test("the store shows a PR too: its URL in an earlier message, the agent's or the person's, of this project", async () => {
  // The Inbox has read no list and no card: only the store can say these numbers are PRs.
  const w = world({ known: knowing() });
  const first = await w.send("ses_a", { body: "Opened https://github.com/acme/api/pull/3405; tracking https://github.com/acme/api/issues/3399.", thread: "one" });
  expect(first.last).toBe(nudge("#3405", "acme/api#3405"));
  expect((await w.send("ses_b", { body: "Reviewing #3405; it closes #3399.", thread: "two" })).last).toBe(nudge("#3405", "acme/api#3405"));
  // The person's words count the same way; a PR of another repository does not make this one's number a PR.
  w.store.sendReply(first.id, { words: "Also see https://github.com/acme/api/pull/3410 and https://github.com/acme/web/pull/3411.", idempotency_key: "p1" });
  const later = await w.send("ses_a", { body: "Next: #3410 and #3411.", thread: "three" });
  expect(later.lines.slice(1)).toEqual([nudge("#3410", "acme/api#3410")]);
});

test("a PR taken off a thread's row is known: quiet in that thread, still named in another", async () => {
  const w = world({ known: knowing() });
  const one = await w.send("ses_a", { body: "Working on the retry fix.", pulls: ["acme/api#3405"], thread: "one" });
  w.store.changeThreadPulls({ thread_id: one.thread, add: [], remove: parseInboxThreadPullRefs(["acme/api#3405"], "remove").refs!, by: { kind: "person" } });
  // Removed on purpose here: never asked back in this thread.
  expect((await w.send("ses_a", { body: "#3405 is green.", reply_to: one.id })).result.content[0]!.text).not.toContain("You named");
  expect((await w.send("ses_a", { body: "Shipping #3405.", thread: "two" })).last).toBe(nudge("#3405", "acme/api#3405"));
});

test("five PRs in one message: three lines in text order and nothing more; a later message there names the other two", async () => {
  const numbers = [3401, 3402, 3403, 3404, 3405];
  const w = world({ known: knowing(...numbers.map((n) => `github.com/acme/api#${n}`)) });
  const body = `Merged ${numbers.map((n) => `#${n}`).join(", ")}.`;
  const sent = await w.send("ses_a", { body, thread: "roll-up" });
  expect(sent.lines.slice(1)).toEqual(numbers.slice(0, 3).map((n) => nudge(`#${n}`, `acme/api#${n}`)));
  const again = await w.send("ses_a", { body, reply_to: sent.id });
  expect(again.lines.slice(1)).toEqual(numbers.slice(3).map((n) => nudge(`#${n}`, `acme/api#${n}`)));
  expect(attachPullText(parseInboxThreadPullRefs(numbers.map((n) => `acme/api#${n}`), "pulls").refs!).split("\n")).toHaveLength(3);
});

test("in a project on a self-hosted GitLab, send_message's short group/project!n lands on that host, and the same words in the body ask nothing", async () => {
  const w = world({ projectHost: async (projectId) => (projectId === w.project.id ? "gitlab.acme.dev" : null) });
  const sent = await w.send("ses_a", { body: "Opened acme/web!7.", pulls: ["acme/web!7"] });
  expect(sent.lines).toHaveLength(1);
  expect(sent.lines[0]).toContain("PRs: Added https://gitlab.acme.dev/acme/web/-/merge_requests/7.");
  expect(w.store.threadPulls(sent.thread).map((p) => p.url)).toEqual(["https://gitlab.acme.dev/acme/web/-/merge_requests/7"]);
  expect(keys("acme/web!7")).toEqual(["gitlab.com/acme/web#7:pull"]);
  expect(pullsNamedInBody("acme/web!7", "gitlab.acme.dev").map((ref) => ref.key)).toEqual(["gitlab.acme.dev/acme/web#7:pull"]);
});

test("one kind a send: the PR line first, the question line on a later send that still qualifies, once a session", async () => {
  const w = world();
  const both = await w.send("ses_a", { body: `Opened ${PR}.\n\n${BARE}` });
  expect(both.last).toBe(nudge("#12", "acme/api#12"));
  expect(both.result.content[0]!.text).not.toContain(QUESTION_OPTIONS_HINT);
  const next = await w.send("ses_a", { body: `${PR}\n\n${BARE.replace("Which", "And which")}`, reply_to: both.id });
  expect(next.last).toBe(QUESTION_OPTIONS_HINT);
  const third = await w.send("ses_a", { body: `${PR}\n\n${BARE.replace("Which", "Then which")}`, reply_to: next.id });
  expect(third.lines).toHaveLength(2);
  expect(third.last).toStartWith(`- ${third.id}/q-`);
});

test("no hint on a refused send or a replay; a refused send does not use up the thread's line", async () => {
  const w = world();
  const refused = await w.send("ses_a", { body: `Opened ${PR}.`, pulls: ["#12"] });
  expect(refused.result.isError).toBe(true);
  expect(refused.result.content[0]!.text).not.toContain("You named");
  const sent = await w.send("ses_a", { body: `Opened ${PR}.`, idempotency_key: "k1" });
  expect(sent.last).toBe(nudge("#12", "acme/api#12"));
  const replay = await w.send("ses_c", { body: `Opened ${PR}.`, idempotency_key: "k1" });
  expect(replay.lines[0]).toStartWith("Already sent");
  expect(replay.lines).toHaveLength(1);
  const anon = await w.send("", { body: BARE, thread: "anon" });
  expect(anon.lines).toHaveLength(2);
  expect(anon.last).toStartWith(`- ${anon.id}/q-`);
});

test("the picture-choices advice is said on every send it holds for, in any session", async () => {
  const w = world();
  const pictured = (prompt: string) => ["- A: ![a](designs/a.png)", "- B: ![b](designs/b.png)", "", ":::question", prompt, "", "- [ ] A", "    Pros: calm", "- [ ] B", ":::"].join("\n");
  expect((await w.send("ses_a", { body: pictured("Which theme?") })).result.content[0]!.text).toContain("choices have no pictures");
  expect((await w.send("ses_a", { body: pictured("Which icon set?"), thread: "icons" })).result.content[0]!.text).toContain("choices have no pictures");
  expect((await w.send("ses_b", { body: pictured("Which font?"), thread: "fonts" })).result.content[0]!.text).toContain("choices have no pictures");
  expect((await w.send("", { body: pictured("Which grid?"), thread: "grids" })).result.content[0]!.text).toContain("choices have no pictures");
});

/**
 * The lookup after a send (inbox-pull-lookups.ts) on a stand-in forge: `kinds` answers each number; `usable` is Code
 * review on and gh signed in; `reads` is every number the forge was asked.
 */
function lookingUp(kinds: Record<number, "pull" | "issue" | "missing" | null>, usable: () => boolean = () => true) {
  const reads: number[] = [];
  const lookups = createInboxPullLookups({
    usable: async () => usable(),
    read: async (ref) => {
      reads.push(ref.number);
      return kinds[ref.number] === undefined ? "missing" : kinds[ref.number]!;
    },
  });
  const known: InboxKnownPulls = {
    repo: { host: "github.com", repo: "acme/api" },
    isPull: (key) => lookups.answer(key)?.kind === "pull",
    settled: (key) => !!lookups.answer(key),
    lookUp: (refs, found) => lookups.lookUp(refs, found),
  };
  // The lookup starts after the send's answer (a timer), then runs on its own.
  const settled = async () => {
    await Bun.sleep(1);
    await lookups.idle();
  };
  return { known, reads, settled };
}

test("an unknown number: no line on this send, looked up after it, the line on that agent's next send in the thread", async () => {
  const forge = lookingUp({ 3405: "pull", 3399: "issue" });
  const w = world({ known: forge.known });
  const first = await w.send("ses_a", { body: "Opened #3405 for the retry fix; it closes #3399.", thread: "one" });
  expect(first.result.content[0]!.text).not.toContain("You named");
  expect(forge.reads).toEqual([]);
  await forge.settled();
  expect(forge.reads).toEqual([3405, 3399]);
  // Another agent in the thread is not the one who named it.
  expect((await w.send("ses_b", { body: "Watching.", reply_to: first.id })).result.content[0]!.text).not.toContain("You named");
  const next = await w.send("ses_a", { body: "Tests are green.", reply_to: first.id });
  expect(next.last).toBe(nudge("#3405", "acme/api#3405"));
  // Said once in this thread; the issue never; and neither is asked of the forge again.
  expect((await w.send("ses_a", { body: "#3405 and #3399 again.", reply_to: first.id })).result.content[0]!.text).not.toContain("You named");
  await forge.settled();
  expect(forge.reads).toEqual([3405, 3399]);
  // Another thread naming it hears it at once now: the answer is kept.
  expect((await w.send("ses_c", { body: "Reviewing #3405.", thread: "two" })).last).toBe(nudge("#3405", "acme/api#3405"));
});

test("a PR found later that is on a row by the next send says nothing; Code review off or a failing forge, nothing at all", async () => {
  const forge = lookingUp({ 3405: "pull" });
  const w = world({ known: forge.known });
  const first = await w.send("ses_a", { body: "Opened #3405.", thread: "one" });
  await forge.settled();
  const attached = await w.send("ses_a", { body: "Attached it.", reply_to: first.id, pulls: ["acme/api#3405"] });
  expect(attached.result.content[0]!.text).not.toContain("You named");

  let on = false;
  const off = lookingUp({ 3405: "pull" }, () => on);
  const w2 = world({ known: off.known });
  const sent = await w2.send("ses_a", { body: "Opened #3405.", thread: "one" });
  await off.settled();
  expect(off.reads).toEqual([]);
  expect((await w2.send("ses_a", { body: "Done.", reply_to: sent.id })).result.content[0]!.text).not.toContain("You named");

  const failing = lookingUp({ 3405: null });
  const w3 = world({ known: failing.known });
  const tried = await w3.send("ses_a", { body: "Opened #3405.", thread: "one" });
  await failing.settled();
  expect(failing.reads).toEqual([3405]);
  const after = await w3.send("ses_a", { body: "Done.", reply_to: tried.id });
  expect(after.result.isError).toBeFalsy();
  expect(after.result.content[0]!.text).not.toContain("You named");
});

test("a message listing forty numbers asks the forge about three", async () => {
  const forge = lookingUp({});
  const w = world({ known: forge.known });
  await w.send("ses_a", { body: Array.from({ length: 40 }, (_, i) => `#${i + 1}`).join(" "), thread: "one" });
  await forge.settled();
  expect(forge.reads).toEqual([1, 2, 3]);
});

test("a body naming 50,000 numbers: the send's lines and the lookup's pick stay fast, and three are queued", async () => {
  const body = Array.from({ length: 50_000 }, (_, i) => `#${i + 1}`).join(" ");
  const forge = lookingUp({});
  const w = world({ known: forge.known });
  const started = performance.now();
  const sent = await w.send("ses_a", { body, thread: "one" });
  const scan = performance.now();
  const picked = pullsToLookUp(w.store, { threadId: sent.thread, body, known: forge.known });
  const done = performance.now();
  expect(scan - started).toBeLessThan(200);
  expect(done - scan).toBeLessThan(200);
  expect(picked.map((ref) => ref.number)).toEqual([1, 2, 3]);
  await forge.settled();
  expect(forge.reads).toEqual([1, 2, 3]);
});

test("an unknown number only in a picture's alt text or a URL is never looked up", async () => {
  const forge = lookingUp({});
  const w = world({ known: forge.known });
  await w.send("ses_a", { body: "Before and after:\n\n![Header after #411](shots/after.png)\n\nSee https://example.com/notes#412.", thread: "one" });
  await forge.settled();
  expect(forge.reads).toEqual([]);
});

test("a number past GitHub's 32 bits is never a PR: never named, never looked up", async () => {
  const forge = lookingUp({});
  const w = world({ known: { ...forge.known, isPull: () => true } });
  const sent = await w.send("ses_a", { body: "See #2147483648 and #9999999999.", thread: "one" });
  expect(sent.result.content[0]!.text).not.toContain("You named");
  expect(pullsToLookUp(w.store, { threadId: sent.thread, body: "#2147483648 #2147483647", known: forge.known }).map((ref) => ref.number)).toEqual([2147483647]);
  await forge.settled();
  expect(forge.reads).toEqual([]);
});
