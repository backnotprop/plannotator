/**
 * send_message's quiet hints (approval "inbox-quiet-hints"): one extra line
 * when the body names a PR that is not on the thread, or asks a question
 * with options that carry no pros, cons or prototype. The failures these
 * guard: a hint on a message that is right (the PR is on the thread, the
 * link is an issue or sits in code, the question has trade-offs), a session
 * told twice, two hints on one send, and a hint on a refused send. The
 * picture-choices advice is not a quiet hint: it is said every time.
 *
 * A real store in a temp dir and send_message's own handler; no Inbox
 * server, no network.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInboxThreadPullRefs } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";
import { attachPullText, pullsNamedInBody, QUESTION_OPTIONS_HINT, questionWithBareOptions, quietHint } from "./inbox-mcp-hints";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PR = "https://github.com/acme/api/pull/12";
const ask = (kind: string, ...lines: string[]) => [`:::${kind}`, "Which retry policy?", "", ...lines, ":::"].join("\n");
const BARE = ask("question", "- [ ] Fixed delay", "- [ ] Backoff");
const keys = (body: string) => pullsNamedInBody(body).map((ref) => ref.key);

type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

function world(projectHost?: InboxMcpContext["projectHost"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-hints-")));
  roots.push(root);
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "api", root: join(root, "api") });
  const context = { store, baseUrl: () => "http://localhost:1/", resolveProject: async () => project, projectHost } as unknown as InboxMcpContext;
  const server = createInboxMcpServer(context) as unknown as { _registeredTools: Record<string, { handler: (input: Record<string, unknown>, ctx: unknown) => Promise<Result> }> };
  const send = async (session: string, input: Record<string, unknown>) => {
    const result = await server._registeredTools.send_message!.handler({ project_path: project.root, agent_session: session, agent_host: "claude-code", ...input }, {});
    const lines = result.content[0]!.text.split("\n");
    return { result, lines, last: lines.at(-1)! };
  };
  return { store, project, send };
}

test("a PR's URL or a GitLab short ref in the agent's words is read; code, quotes, issues and ambiguous refs are not", () => {
  expect(keys(`Opened ${PR} for this.`)).toEqual(["github.com/acme/api#12"]);
  expect(keys(`See [the PR](${PR}/files) and acme/web!7.`)).toEqual(["github.com/acme/api#12", "gitlab.com/acme/web#7:pull"]);
  expect(keys(["```sh", `gh pr view ${PR}`, "```", `and \`${PR}\``].join("\n"))).toEqual([]);
  expect(keys(`> you said ${PR}\nYes.`)).toEqual([]);
  expect(keys("Tracked in https://github.com/acme/api/issues/12.")).toEqual([]);
  expect(keys("Opened https://bitbucket.org/acme/api/pull-requests/3/diff and https://bitbucket.org/acme/api/issues/4.")).toEqual(["bitbucket.org/acme/api#3:pull"]);
  // `owner/repo#12` and a bare `#12` may each be an issue.
  expect(keys("Follows acme/api#12 and #13. Done!")).toEqual([]);
});

test("a question counts with two or more choices and no pros, cons or prototype anywhere", () => {
  expect(questionWithBareOptions(BARE)).toBe(true);
  expect(questionWithBareOptions(ask("question-multi", "- [ ] Yes", "- [ ] No"))).toBe(true);
  expect(questionWithBareOptions(ask("question", "- [ ] Fixed delay", "    Pros: simple", "- [ ] Backoff"))).toBe(false);
  expect(questionWithBareOptions(ask("question", "- [ ] Fixed delay", "    Cons: thundering herd", "- [ ] Backoff"))).toBe(false);
  expect(questionWithBareOptions(ask("question", "- [ ] Fixed delay", "    Prototype: proto/a.html", "- [ ] Backoff"))).toBe(false);
  expect(questionWithBareOptions(ask("question", "- [ ] Fixed delay", "- [ ] Backoff", "Prototype: proto/both.html"))).toBe(false);
  expect(questionWithBareOptions(ask("question", "- [ ] Only this"))).toBe(false);
  expect(questionWithBareOptions(ask("question-text"))).toBe(false);
  expect(questionWithBareOptions([":::action", "Rotate the key", "- [ ] In the console", "- [ ] With the CLI", ":::"].join("\n"))).toBe(false);
});

test("the PR line is the answer's last line, names the ref, and is said once to a session; another session hears it once too", async () => {
  const w = world();
  const first = await w.send("ses_a", { body: `Opened ${PR}.` });
  expect(first.result.isError).toBeUndefined();
  expect(first.lines[0]).toStartWith("Sent to the Plannotator Inbox");
  expect(first.last).toBe(attachPullText(parseInboxThreadPullRefs([PR], "pulls").refs!));
  expect(first.last).toContain('add ["acme/api#12"]');
  expect(first.result.structuredContent!.hint).toBe(first.last);
  // The same fact again, in a new thread: quiet.
  const again = await w.send("ses_a", { body: `Also https://github.com/acme/api/pull/13.`, thread: "other" });
  expect(again.lines).toHaveLength(1);
  expect(again.result.structuredContent!.hint).toBeUndefined();
  const other = await w.send("ses_b", { body: `Opened ${PR}.`, thread: "b" });
  expect(other.last).toStartWith("You can attach that PR");
});

test("no PR line when the PR is passed in pulls now, is already on the thread, or was taken off it", async () => {
  const w = world();
  const now = await w.send("ses_a", { body: `Opened ${PR}.`, pulls: [PR] });
  expect(now.lines).toHaveLength(1);
  expect(now.lines[0]).toContain("PRs: Added acme/api#12.");
  const later = await w.send("ses_a", { body: `${PR} is green.`, reply_to: now.result.structuredContent!.message_id });
  expect(later.lines).toHaveLength(1);
  // The person took it off: never asked back.
  const threadId = String(now.result.structuredContent!.thread_id);
  w.store.changeThreadPulls({ thread_id: threadId, add: [], remove: parseInboxThreadPullRefs([PR], "remove").refs!, by: { kind: "person" } });
  expect(quietHint(w.store, { session: "ses_a", threadId, body: `${PR} again`, replayed: false, now: Date.now() })).toBeNull();
  // Still unsaid for this session: a PR on no thread gets it.
  expect((await w.send("ses_a", { body: "And https://github.com/acme/api/pull/99.", thread: "new" })).last).toContain("acme/api#99");
});

test("in a project on a self-hosted GitLab, send_message's short group/project!n lands on that host, and the same words in the body ask nothing", async () => {
  const w = world(async (projectId) => (projectId === w.project.id ? "gitlab.acme.dev" : null));
  const sent = await w.send("ses_a", { body: "Opened acme/web!7.", pulls: ["acme/web!7"] });
  expect(sent.lines).toHaveLength(1);
  expect(sent.lines[0]).toContain("PRs: Added https://gitlab.acme.dev/acme/web/-/merge_requests/7.");
  const threadId = String(sent.result.structuredContent!.thread_id);
  expect(w.store.threadPulls(threadId).map((p) => p.url)).toEqual(["https://gitlab.acme.dev/acme/web/-/merge_requests/7"]);
  expect(keys("acme/web!7")).toEqual(["gitlab.com/acme/web#7:pull"]);
  expect(pullsNamedInBody("acme/web!7", "gitlab.acme.dev").map((ref) => ref.key)).toEqual(["gitlab.acme.dev/acme/web#7:pull"]);
});

test("one hint a send: the PR line first, the question line on a later send that still qualifies, each once", async () => {
  const w = world();
  const both = await w.send("ses_a", { body: `Opened ${PR}.\n\n${BARE}` });
  expect(both.last).toStartWith("You can attach that PR");
  expect(both.result.content[0]!.text).not.toContain(QUESTION_OPTIONS_HINT);
  const next = await w.send("ses_a", { body: `${PR}\n\n${BARE.replace("Which", "And which")}`, thread: "two" });
  expect(next.last).toBe(QUESTION_OPTIONS_HINT);
  const third = await w.send("ses_a", { body: `${PR}\n\n${BARE.replace("Which", "Then which")}`, thread: "three" });
  expect(third.lines).toHaveLength(1);
});

test("no hint on a refused send, a replay, or a send with no session; a refused send does not use the session's one time", async () => {
  const w = world();
  const refused = await w.send("ses_a", { body: `Opened ${PR}.`, pulls: ["#12"] });
  expect(refused.result.isError).toBe(true);
  expect(refused.result.content[0]!.text).not.toContain("You can attach");
  const sent = await w.send("ses_a", { body: `Opened ${PR}.`, idempotency_key: "k1" });
  expect(sent.last).toStartWith("You can attach that PR");
  const replay = await w.send("ses_c", { body: `Opened ${PR}.`, idempotency_key: "k1" });
  expect(replay.lines[0]).toStartWith("Already sent");
  expect(replay.lines).toHaveLength(1);
  expect((await w.send("", { body: BARE, thread: "anon" })).lines).toHaveLength(1);
});

test("the picture-choices advice is said on every send it holds for, in any session", async () => {
  const w = world();
  const pictured = (prompt: string) => ["- A: ![a](designs/a.png)", "- B: ![b](designs/b.png)", "", ":::question", prompt, "", "- [ ] A", "    Pros: calm", "- [ ] B", ":::"].join("\n");
  expect((await w.send("ses_a", { body: pictured("Which theme?") })).result.content[0]!.text).toContain("choices have no pictures");
  expect((await w.send("ses_a", { body: pictured("Which icon set?"), thread: "icons" })).result.content[0]!.text).toContain("choices have no pictures");
  expect((await w.send("ses_b", { body: pictured("Which font?"), thread: "fonts" })).result.content[0]!.text).toContain("choices have no pictures");
  expect((await w.send("", { body: pictured("Which grid?"), thread: "grids" })).result.content[0]!.text).toContain("choices have no pictures");
});
