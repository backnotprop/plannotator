/**
 * Post decisions on a real store in a temp folder, through the review app's provider layer, against an in-memory
 * forge behind the fake PR runtime (tests/helpers/fake-pr-runtime.ts): no test runs the real gh or glab.
 *
 * What regresses: a second post adding a second comment instead of editing the first; editing someone else's comment
 * that carries the marker; a deleted comment not posted again; a refusal shown as raw CLI text instead of what to do;
 * a post that pins or reads a head commit (a PR with new commits, or merged, must still take it); a post landing on
 * another of the thread's PRs, or on a PR the thread does not have; GitLab's note not edited in place (PUT); an unsent
 * pick reaching the forge; the description route touching a byte outside its markers, clobbering an edit made between
 * its read and its write, or going past the forge's limit; the description not being the default; a refusal to edit
 * the description (or no room in it) not falling back to a comment; the setting not kept in config.json; the route
 * answering another site.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInboxThreadPullRef } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import type { CommandResult } from "@plannotator/shared/pr-types";
import { createFakePRRuntime, type FakePRCommand } from "../../tests/helpers/fake-pr-runtime";
import { startInboxServer, type InboxServer } from "./inbox";
import { postThreadDecisions } from "./inbox-decision-post";

const roots: string[] = [];
const servers: InboxServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ok = (value: unknown): CommandResult => ({ stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "", exitCode: 0 });
const fail = (stderr: string, stdout = ""): CommandResult => ({ stdout, stderr, exitCode: 1 });

interface Note {
  id: number;
  body: string;
  login: string;
}

/**
 * One forge's state as gh / glab would answer it: comments (notes) per PR, each PR's description, the signed-in login.
 * `refuse(write)` answers a write with a refusal; `onRead` runs after each description read is answered (someone else's edit landing right after it).
 */
function fakeForge(platform: "github" | "gitlab", me = "mona") {
  let next = 100;
  const comments = new Map<string, Note[]>();
  const descriptions = new Map<string, string>();
  const hooks: { refuse?: (command: FakePRCommand) => CommandResult | undefined; onRead?: (pr: string, count: number) => void } = {};
  const reads = new Map<string, number>();
  const list = (pr: string) => comments.get(pr) ?? (comments.set(pr, []), comments.get(pr)!);
  const fake = createFakePRRuntime((command) => {
    if (command.cmd !== (platform === "github" ? "gh" : "glab") || command.args[0] !== "api") return undefined;
    const endpoint = command.args[1]!;
    const method = command.args.includes("--method") ? command.args[command.args.indexOf("--method") + 1] : "GET";
    if (method !== "GET") {
      const refused = hooks.refuse?.(command);
      if (refused) return refused;
    }
    const input = command.input ? (JSON.parse(command.input) as { body?: string; description?: string }) : {};
    if (platform === "github") {
      if (endpoint === "user") return ok(`${me}\n`);
      let m = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments(?:\?.*)?$/.exec(endpoint);
      if (m && method === "GET") return ok(list(`${m[1]}#${m[2]}`).map((c) => ({ id: c.id, body: c.body, user: { login: c.login }, html_url: `https://github.com/${m![1]}/pull/${m![2]}#issuecomment-${c.id}` })));
      if (m && method === "POST") {
        const note = { id: next++, body: input.body!, login: me };
        list(`${m[1]}#${m[2]}`).push(note);
        return ok({ id: note.id, html_url: `https://github.com/${m[1]}/pull/${m[2]}#issuecomment-${note.id}` });
      }
      m = /^repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/.exec(endpoint);
      if (m && method === "PATCH") {
        for (const [pr, notes] of comments) {
          const note = notes.find((c) => c.id === Number(m![2]));
          if (!note) continue;
          if (note.login !== me) return fail("gh: Forbidden (HTTP 403)", JSON.stringify({ message: "Forbidden" }));
          note.body = input.body!;
          return ok({ id: note.id, html_url: `https://github.com/${pr.replace("#", "/pull/")}#issuecomment-${note.id}` });
        }
        return fail("gh: Not Found (HTTP 404)", JSON.stringify({ message: "Not Found" }));
      }
      m = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(endpoint);
      if (m) {
        const pr = `${m[1]}#${m[2]}`;
        if (method === "PATCH") {
          descriptions.set(pr, input.body!);
          return ok({ number: Number(m[2]) });
        }
        const count = (reads.get(pr) ?? 0) + 1;
        reads.set(pr, count);
        const answer = ok({ body: descriptions.get(pr) ?? null, html_url: `https://github.com/${m[1]}/pull/${m[2]}` });
        hooks.onRead?.(pr, count);
        return answer;
      }
      return undefined;
    }
    if (endpoint === "/user") return ok({ username: me });
    let m = /^projects\/([^/]+)\/merge_requests\/(\d+)\/notes(?:\/(\d+))?(?:\?.*)?$/.exec(endpoint);
    if (m) {
      const pr = `${decodeURIComponent(m[1]!)}!${m[2]}`;
      if (method === "GET") return ok(list(pr).map((c) => ({ id: c.id, body: c.body, system: false, author: { username: c.login } })));
      if (method === "POST") {
        const note = { id: next++, body: input.body!, login: me };
        list(pr).push(note);
        return ok({ id: note.id, body: note.body });
      }
      const note = list(pr).find((c) => c.id === Number(m![3]));
      if (!note) return fail("glab: 404 Not Found");
      note.body = input.body!;
      return ok({ id: note.id });
    }
    m = /^projects\/([^/]+)\/merge_requests\/(\d+)$/.exec(endpoint);
    if (m) {
      const pr = `${decodeURIComponent(m[1]!)}!${m[2]}`;
      if (method === "PUT") {
        descriptions.set(pr, input.description!);
        return ok({ iid: Number(m[2]) });
      }
      const count = (reads.get(pr) ?? 0) + 1;
      reads.set(pr, count);
      const answer = ok({ description: descriptions.get(pr) ?? "", web_url: `https://gitlab.com/${decodeURIComponent(m[1]!)}/-/merge_requests/${m[2]}` });
      hooks.onRead?.(pr, count);
      return answer;
    }
    return undefined;
  });
  return { ...fake, comments: list, descriptions, hooks };
}

/** A thread with one sent decision and one pick saved and not sent, and the PRs given linked to it. */
function seed(pulls: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-decision-post-")));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(root, "acme-notes"), { recursive: true });
  let clock = Date.parse("2026-11-10T07:30:00Z");
  const store = InboxStore.open(data, { now: () => new Date((clock += 60_000)) });
  const p = store.ensureProject({ name: "acme-notes", root: join(root, "acme-notes") });
  const author = { kind: "agent" as const, host: "claude-code", session: "ses-a", name: null };
  const body = [
    ":::question",
    "Where should the losing version be kept?",
    "",
    "- [ ] Local only — cheap",
    "- [ ] Server-side",
    "",
    "Recommended: Local only",
    ":::",
    "",
    ":::question",
    "Show who made the losing edit?",
    "",
    "- [ ] Name and time",
    "- [ ] Nothing",
    ":::",
  ].join("\n");
  const sent = store.sendMessage({ project_id: p.id, author, body, thread: "t", idempotency_key: "k1", subject: "Offline sync: conflicts" }).message;
  const [q1, q2] = store.questionsOf(sent.id);
  store.savePicks(sent.id, [
    { key: q1!.key, revision: q1!.revision, answer: { v: 1, key: q1!.key, kind: "single", prompt: q1!.prompt, selected: ["Local only"] } },
    { key: q2!.key, revision: q2!.revision, answer: { v: 1, key: q2!.key, kind: "single", prompt: q2!.prompt, selected: ["Name and time"], note: "Draft note: name only, no time" } },
  ]);
  const after = store.questionsOf(sent.id)[0]!;
  store.sendReply(sent.id, { questions: [{ key: after.key, revision: after.revision }], idempotency_key: "r1" });
  if (pulls.length > 0) {
    store.changeThreadPulls({ thread_id: sent.thread_id, add: pulls.map((ref) => parseInboxThreadPullRef(ref) as Exclude<ReturnType<typeof parseInboxThreadPullRef>, { error: string }>), by: { kind: "person" } });
  }
  return { data, store, thread: sent.thread_id };
}

const writes = (calls: FakePRCommand[]) => calls.filter((c) => c.args.includes("--method"));

test("GitHub: the first post creates one comment starting with the marker; the next edits that same comment", async () => {
  const world = seed(["acme/notes#12"]);
  const forge = fakeForge("github");
  const first = await postThreadDecisions(world.store, world.thread, { pull: "acme/notes#12", tz: "UTC" }, { runtime: forge.runtime, version: "test", destination: "comment" });
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ ok: true, action: "created", destination: "comment", ref: "acme/notes#12" });
  expect(first.body).not.toHaveProperty("fallback");
  expect((first.body as { url: string }).url).toStartWith("https://github.com/acme/notes/pull/12#issuecomment-");
  const [comment] = forge.comments("acme/notes#12");
  expect(comment!.body.split("\n")[0]).toBe(`<!-- plannotator-decisions v1 thread=${world.thread} -->`);
  expect(comment!.body).toContain('<picture><source media="(prefers-color-scheme: dark)" srcset="https://plannotator.ai/assets/decisions/v1/banner-dark.png">');
  // No task-list items (GitHub would make them clickable and count them as tasks).
  expect(comment!.body).not.toMatch(/^\s*[-*+]\s+\[[ xX]\]/m);

  const second = await postThreadDecisions(world.store, world.thread, { pull: "https://github.com/acme/notes/pull/12", tz: "UTC" }, { runtime: forge.runtime, version: "test", destination: "comment" });
  expect(second.body).toMatchObject({ action: "updated", url: (first.body as { url: string }).url });
  expect(forge.comments("acme/notes#12")).toHaveLength(1);
  expect(writes(forge.calls).map((c) => [c.args[1], c.args[c.args.indexOf("--method") + 1]])).toEqual([
    ["repos/acme/notes/issues/12/comments", "POST"],
    [`repos/acme/notes/issues/comments/${comment!.id}`, "PATCH"],
  ]);
});

test("a pick saved and not sent is posted as a draft, not sent to the agent (the owner, 2026-11-10)", async () => {
  const world = seed(["acme/notes#12"]);
  const forge = fakeForge("github");
  await postThreadDecisions(world.store, world.thread, { pull: "acme/notes#12" }, { runtime: forge.runtime, version: "test", destination: "comment" });
  const body = forge.comments("acme/notes#12")[0]!.body;
  expect(body).toContain("1 decided, 1 draft");
  expect(body).toContain("| D2 | Show who made the losing edit? | Name and time · _draft, not sent to the agent_ | |");
  expect(body).toContain("- **Name and time** · _draft, not sent to the agent_");
  // A draft's note is posted, inside the draft's own fold.
  const draftFold = body.slice(body.indexOf("<details><summary><h3>D2"));
  expect(draftFold.slice(0, draftFold.indexOf("</details>"))).toContain("> Draft note: name only, no time");
  expect(body).not.toContain("#### Still open");
});

test("someone else's comment with the same marker is never edited; a comment deleted meanwhile is posted again", async () => {
  const world = seed(["acme/notes#12"]);
  const forge = fakeForge("github");
  forge.comments("acme/notes#12").push({ id: 7, body: `<!-- plannotator-decisions v1 thread=${world.thread} -->\nquoted by a teammate`, login: "hubot" });
  const first = await postThreadDecisions(world.store, world.thread, { pull: "acme/notes#12" }, { runtime: forge.runtime, version: "test", destination: "comment" });
  expect(first.body).toMatchObject({ action: "created" });
  expect(forge.comments("acme/notes#12")[0]!.body).toEndWith("quoted by a teammate");
  // Deleted between the list and the edit: GitHub answers 404 to the PATCH, and a new one is posted.
  forge.hooks.refuse = (c) => (c.args[1]!.startsWith("repos/acme/notes/issues/comments/") ? fail("gh: Not Found (HTTP 404)") : undefined);
  const again = await postThreadDecisions(world.store, world.thread, { pull: "acme/notes#12" }, { runtime: forge.runtime, version: "test", destination: "comment" });
  expect(again.body).toMatchObject({ action: "created" });
});

test("refusals say what to do: not signed in, no access (403), a private repo the account can't see (404), a locked PR", async () => {
  const world = seed(["acme/notes#12"]);
  const cases: [CommandResult, string][] = [
    [fail("gh: Forbidden (HTTP 403)", JSON.stringify({ message: "Resource not accessible by integration" })), "Couldn't post on acme/notes#12: your GitHub account isn't allowed to comment there. Ask for access, then try again."],
    [fail("gh: Not Found (HTTP 404)", JSON.stringify({ message: "Not Found" })), "Couldn't post on acme/notes#12: your GitHub account can't see it. Sign in to gh with an account that can, then try again."],
    [fail("gh: Unprocessable Entity (HTTP 422)", JSON.stringify({ message: "Unable to create comment because issue is locked." })), "Couldn't post on acme/notes#12: its conversation is locked. Ask a maintainer to unlock it, then try again."],
  ];
  for (const [answer, words] of cases) {
    const forge = fakeForge("github");
    forge.hooks.refuse = () => answer;
    const result = await postThreadDecisions(world.store, world.thread, { pull: "acme/notes#12" }, { runtime: forge.runtime, version: "test", destination: "comment" });
    expect(result).toEqual({ status: 502, body: { code: "post_failed", error: words } });
  }
  // gh signed out: every call fails as the fake runtime's default does, with gh's own words.
  const signedOut = createFakePRRuntime(() => fail("To get started with GitHub CLI, please run:  gh auth login"));
  const result = await postThreadDecisions(world.store, world.thread, { pull: "acme/notes#12" }, { runtime: signedOut.runtime, version: "test", destination: "comment" });
  expect((result.body as { error: string }).error).toBe("Couldn't post on acme/notes#12: gh isn't signed in. Run `gh auth login`, then try again.");
});

test("a merged PR or one with new commits still takes it: nothing reads or pins a head commit", async () => {
  const world = seed(["acme/notes#12"]);
  const pull = world.store.threadPulls(world.thread)[0]!;
  expect(world.store.setThreadPullState(world.thread, pull.pull, { state: "merged", title: "Sync", base: "main", head: "sync" })).not.toBeNull();
  const forge = fakeForge("github");
  const result = await postThreadDecisions(world.store, world.thread, { pull: "acme/notes#12" }, { runtime: forge.runtime, version: "test", destination: "comment" });
  expect(result.status).toBe(200);
  expect(forge.calls.some((c) => /commits|pulls\/12$/.test(c.args[1] ?? "") || (c.input ?? "").includes("commit_id"))).toBe(false);
});

test("several linked PRs: the post goes to the one chosen only; a PR the thread does not have is refused, nothing runs", async () => {
  const world = seed(["acme/notes#12", "acme/api#7"]);
  const forge = fakeForge("github");
  const result = await postThreadDecisions(world.store, world.thread, { pull: "acme/api#7" }, { runtime: forge.runtime, version: "test", destination: "comment" });
  expect(result.body).toMatchObject({ ref: "acme/api#7" });
  expect(writes(forge.calls).every((c) => c.args[1]!.startsWith("repos/acme/api/issues/7/"))).toBe(true);
  expect(forge.comments("acme/notes#12")).toHaveLength(0);

  const none = seed([]);
  const idle = fakeForge("github");
  const refused = await postThreadDecisions(none.store, none.thread, { pull: "acme/notes#12" }, { runtime: idle.runtime, version: "test", destination: "comment" });
  expect(refused).toEqual({ status: 409, body: { code: "pull_not_on_thread", error: "That pull request is not on this thread. Add it to the thread first, then post." } });
  expect(idle.calls).toHaveLength(0);
});

test("GitLab: a note on the merge request, edited in place with PUT; the banner is its words as a link (no <picture> there)", async () => {
  const world = seed(["group/sub/app!45"]);
  const forge = fakeForge("gitlab");
  const first = await postThreadDecisions(world.store, world.thread, { pull: "group/sub/app!45" }, { runtime: forge.runtime, version: "test", destination: "comment" });
  expect(first.body).toMatchObject({ action: "created", ref: "group/sub/app!45" });
  const [note] = forge.comments("group/sub/app!45");
  expect((first.body as { url: string }).url).toBe(`https://gitlab.com/group/sub/app/-/merge_requests/45#note_${note!.id}`);
  expect(note!.body).not.toContain("<picture>");
  expect(note!.body).toContain("[**Decisions**, from Plannotator](https://plannotator.ai/inbox/)");
  const second = await postThreadDecisions(world.store, world.thread, { pull: "group/sub/app!45" }, { runtime: forge.runtime, version: "test", destination: "comment" });
  expect(second.body).toMatchObject({ action: "updated" });
  expect(forge.comments("group/sub/app!45")).toHaveLength(1);
  expect(writes(forge.calls).map((c) => [c.args[1], c.args[c.args.indexOf("--method") + 1]])).toEqual([
    ["projects/group%2Fsub%2Fapp/merge_requests/45/notes", "POST"],
    [`projects/group%2Fsub%2Fapp/merge_requests/45/notes/${note!.id}`, "PUT"],
  ]);
});

for (const platform of ["github", "gitlab"] as const) {
  const ref = platform === "github" ? "acme/notes#12" : "group/app!45";
  test(`${platform}: the description section keeps every byte outside its markers, and a re-post replaces only the section`, async () => {
    const world = seed([ref]);
    const forge = fakeForge(platform);
    const before = "## Summary\r\n\nKeeps the losing edit.  \n\n<!-- the author's own comment -->\ntrailing words without a newline";
    forge.descriptions.set(ref, before);
    const first = await postThreadDecisions(world.store, world.thread, { pull: ref }, { runtime: forge.runtime, version: "test", destination: "description" });
    expect(first.body).toMatchObject({ action: "created", destination: "description" });
    const once = forge.descriptions.get(ref)!;
    expect(once.startsWith(`${before}\n\n<!-- plannotator-decisions:start v1 thread=${world.thread} -->\n`)).toBe(true);
    expect(once.endsWith("<!-- plannotator-decisions:end -->")).toBe(true);
    // Someone adds a line after the section; the re-post replaces only what is between the markers.
    forge.descriptions.set(ref, `${once}\n\nAdded later by the author.`);
    const second = await postThreadDecisions(world.store, world.thread, { pull: ref }, { runtime: forge.runtime, version: "test", destination: "description", now: () => new Date("2026-11-11T09:00:00Z") });
    expect(second.body).toMatchObject({ action: "updated" });
    const twice = forge.descriptions.get(ref)!;
    expect(twice.startsWith(`${before}\n\n<!-- plannotator-decisions:start`)).toBe(true);
    expect(twice.endsWith("<!-- plannotator-decisions:end -->\n\nAdded later by the author.")).toBe(true);
    expect(twice.match(/plannotator-decisions:start/g)).toHaveLength(1);
  });
}

test("description: an edit landing between the read and the write is not clobbered; past the limit, a comment instead", async () => {
  const world = seed(["acme/notes#12"]);
  const forge = fakeForge("github");
  forge.descriptions.set("acme/notes#12", "Original.");
  forge.hooks.onRead = (pr, count) => {
    if (count === 1) forge.descriptions.set(pr, "Original, edited by a teammate meanwhile.");
  };
  const raced = await postThreadDecisions(world.store, world.thread, { pull: "acme/notes#12" }, { runtime: forge.runtime, version: "test", destination: "description" });
  expect(raced).toEqual({ status: 409, body: { code: "description_changed", error: "The description changed while posting. Try again." } });
  expect(forge.descriptions.get("acme/notes#12")).toBe("Original, edited by a teammate meanwhile.");
  expect(writes(forge.calls)).toHaveLength(0);

  forge.hooks.onRead = undefined;
  // No room at all: nothing written in the description; the same decisions go as a comment, and the answer says why.
  const full = "y".repeat(65_530);
  forge.descriptions.set("acme/notes#12", full);
  const moved = await postThreadDecisions(world.store, world.thread, { pull: "acme/notes#12" }, { runtime: forge.runtime, version: "test", destination: "description" });
  expect(moved.body).toMatchObject({ ok: true, action: "created", destination: "comment", fallback: "too_long" });
  expect(forge.descriptions.get("acme/notes#12")).toBe(full);
  expect(forge.comments("acme/notes#12")).toHaveLength(1);
});

test("both: the full comment, and a short section in the description that links to it", async () => {
  const world = seed(["acme/notes#12"]);
  const forge = fakeForge("github");
  const result = await postThreadDecisions(world.store, world.thread, { pull: "acme/notes#12" }, { runtime: forge.runtime, version: "test", destination: "both" });
  const url = (result.body as { url: string }).url;
  expect(url).toStartWith("https://github.com/acme/notes/pull/12#issuecomment-");
  const section = forge.descriptions.get("acme/notes#12")!;
  // The banner and one line linking to the comment; no fold in the description.
  expect(section).toContain(`**[Decisions: Offline sync: conflicts](${url})** · 1 decided, 1 draft`);
  expect(section).toContain("<picture>");
  expect(section).not.toMatch(/<(?:details|dl)/);
});

test("by default the decisions go in the description: the banner, then one collapsed details whose summary names them", async () => {
  const world = seed(["acme/notes#12"]);
  const forge = fakeForge("github");
  forge.descriptions.set("acme/notes#12", "Adds offline sync.");
  const result = await postThreadDecisions(world.store, world.thread, { pull: "acme/notes#12", tz: "UTC" }, { runtime: forge.runtime, version: "test" });
  expect(result.body).toMatchObject({ ok: true, action: "created", destination: "description", url: "https://github.com/acme/notes/pull/12" });
  expect(forge.comments("acme/notes#12")).toHaveLength(0);
  const text = forge.descriptions.get("acme/notes#12")!;
  const lines = text.split("\n");
  expect(lines.slice(0, 3)).toEqual(["Adds offline sync.", "", `<!-- plannotator-decisions:start v1 thread=${world.thread} -->`]);
  expect(lines[3]).toStartWith('<a href="https://plannotator.ai/inbox/"><picture>');
  expect(lines[5]).toBe("<details><summary><b>Decisions: Offline sync: conflicts</b> · 1 decided, 1 draft</summary>");
  expect(lines.slice(-2)).toEqual(["</details>", "<!-- plannotator-decisions:end -->"]);
  // No task-list items: in a description GitHub counts them as the PR's tasks ("N of M tasks") and makes them clickable.
  expect(text).not.toMatch(/^\s*[-*+]\s+\[[ xX]\]/m);
  expect(text).toContain("- ✓ **Local only**");
});

for (const platform of ["github", "gitlab"] as const) {
  const ref = platform === "github" ? "acme/notes#12" : "group/app!45";
  test(`${platform}: not allowed to edit the description (not the author, no write access): a comment instead, and the answer says so`, async () => {
    const world = seed([ref]);
    const forge = fakeForge(platform);
    forge.descriptions.set(ref, "Someone else's PR.");
    forge.hooks.refuse = (c) =>
      /merge_requests\/45$|pulls\/12$/.test(c.args[1]!) ? fail(platform === "github" ? "gh: Not Found (HTTP 404)" : "glab: 403 Forbidden", JSON.stringify({ message: platform === "github" ? "Not Found" : "403 Forbidden" })) : undefined;
    const result = await postThreadDecisions(world.store, world.thread, { pull: ref }, { runtime: forge.runtime, version: "test" });
    expect(result.body).toMatchObject({ ok: true, action: "created", destination: "comment", fallback: "no_permission" });
    expect(forge.descriptions.get(ref)).toBe("Someone else's PR.");
    expect(forge.comments(ref)).toHaveLength(1);
    expect(forge.comments(ref)[0]!.body.split("\n")[0]).toBe(`<!-- plannotator-decisions v1 thread=${world.thread} -->`);
  });
}

test("both, with a description the person may not edit: the comment stays and the answer says it is the comment alone", async () => {
  const world = seed(["acme/notes#12"]);
  const forge = fakeForge("github");
  forge.hooks.refuse = (c) => (c.args[1] === "repos/acme/notes/pulls/12" ? fail("gh: Forbidden (HTTP 403)") : undefined);
  const result = await postThreadDecisions(world.store, world.thread, { pull: "acme/notes#12" }, { runtime: forge.runtime, version: "test", destination: "both" });
  expect(result.body).toMatchObject({ ok: true, destination: "comment", fallback: "no_permission" });
  expect(forge.comments("acme/notes#12")).toHaveLength(1);
});

test("the route posts where the setting says (the description until changed); the setting is kept in config.json; another site is refused", async () => {
  const world = seed(["acme/notes#12"]);
  // config.json lives in the data dir the process names: a temp one, put back after.
  const before = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = world.data;
  try {
    const forge = fakeForge("github");
    const server = await startInboxServer({ dataDir: world.data, binaryPath: null, phones: false, prRuntime: forge.runtime });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}/api/inbox`;
    const send = (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ ...body, serverSession: server.serverSession }) });
    expect(await (await fetch(`${base}/settings/decisions-post`)).json()).toMatchObject({ post_to: "description" });
    const first = await send(`/threads/${world.thread}/decisions/post`, { pull: "acme/notes#12", tz: "UTC" });
    expect(await first.json()).toMatchObject({ ok: true, action: "created", destination: "description", ref: "acme/notes#12" });
    expect(forge.descriptions.get("acme/notes#12")).toContain("<!-- plannotator-decisions:start");

    expect((await send("/settings/decisions-post", { post_to: "nowhere" })).status).toBe(422);
    expect(await (await send("/settings/decisions-post", { post_to: "comment" })).json()).toMatchObject({ post_to: "comment" });
    expect(JSON.parse(readFileSync(join(world.data, "config.json"), "utf8")).inboxDecisionsPostTo).toBe("comment");
    const second = await send(`/threads/${world.thread}/decisions/post`, { pull: "acme/notes#12", tz: "UTC" });
    expect(await second.json()).toMatchObject({ destination: "comment", action: "created" });
    expect(forge.comments("acme/notes#12")).toHaveLength(1);

    const cross = await send(`/threads/${world.thread}/decisions/post`, { pull: "acme/notes#12" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    expect(cross.status).toBe(403);
    expect((await send("/settings/decisions-post", { post_to: "both" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await fetch(`${base}/threads/${world.thread}/decisions/post`)).status).toBe(405);
  } finally {
    if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = before;
  }
});
