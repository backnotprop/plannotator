import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInboxThreadPullRef } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { startInboxServer, type InboxServer } from "../../../packages/server/inbox";
import { createFakePRRuntime } from "../../../tests/helpers/fake-pr-runtime";
import { parseExportDecisionsCommand, runInboxExportDecisionsCommand } from "./inbox-export-decisions-command";

const roots: string[] = [];
const servers: InboxServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-export-decisions-cli-")));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(join(root, "acme-notes"), { recursive: true });
  mkdirSync(data, { recursive: true });
  const store = InboxStore.open(data);
  const p = store.ensureProject({ name: "acme-notes", root: join(root, "acme-notes") });
  const sent = store.sendMessage({ project_id: p.id, author: { kind: "agent", host: "claude-code", session: "ses-a", name: null }, body: ":::question\nKeep it?\n\n- [ ] Yes\n- [ ] No\n:::", thread: "t", idempotency_key: "k", subject: "Keep" }).message;
  const q = store.questionsOf(sent.id)[0]!;
  store.savePicks(sent.id, [{ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: "single", prompt: q.prompt, selected: ["Yes"] } }]);
  store.sendReply(sent.id, { questions: [{ key: q.key, revision: store.questionsOf(sent.id)[0]!.revision }], idempotency_key: "r" });
  store.changeThreadPulls({ thread_id: sent.thread_id, add: [parseInboxThreadPullRef("acme/notes#12") as never], by: { kind: "person" } });
  const comments: { id: number; body: string }[] = [];
  const description = { text: "PR body.", locked: false };
  const fake = createFakePRRuntime((c) => {
    const endpoint = c.args[1] ?? "";
    if (endpoint === "user") return { stdout: "mona\n", stderr: "", exitCode: 0 };
    if (endpoint.startsWith("repos/acme/notes/issues/12/comments?")) return { stdout: JSON.stringify(comments.map((x) => ({ ...x, user: { login: "mona" } }))), stderr: "", exitCode: 0 };
    if (endpoint === "repos/acme/notes/issues/12/comments") {
      comments.push({ id: 5, body: JSON.parse(c.input!).body });
      return { stdout: JSON.stringify({ id: 5, html_url: "https://github.com/acme/notes/pull/12#issuecomment-5" }), stderr: "", exitCode: 0 };
    }
    if (endpoint === "repos/acme/notes/pulls/12") {
      if (!c.args.includes("PATCH")) return { stdout: JSON.stringify({ body: description.text, html_url: "https://github.com/acme/notes/pull/12" }), stderr: "", exitCode: 0 };
      if (description.locked) return { stdout: JSON.stringify({ message: "Not Found" }), stderr: "gh: Not Found (HTTP 404)", exitCode: 1 };
      description.text = JSON.parse(c.input!).body;
      return { stdout: "{}", stderr: "", exitCode: 0 };
    }
    if (endpoint === "repos/acme/notes/issues/comments/5") {
      comments[0]!.body = JSON.parse(c.input!).body;
      return { stdout: JSON.stringify({ id: 5, html_url: "https://github.com/acme/notes/pull/12#issuecomment-5" }), stderr: "", exitCode: 0 };
    }
    return undefined;
  });
  const server = await startInboxServer({ dataDir: data, binaryPath: null, phones: false, prRuntime: fake.runtime });
  servers.push(server);
  const outs: string[] = [];
  const errs: string[] = [];
  const run = (argv: string[]) =>
    runInboxExportDecisionsCommand(argv, { cwd: root, ensureRunning: async () => ({ port: server.port }) as InboxRegistryEntry, out: (t) => void outs.push(t), err: (t) => void errs.push(t) });
  return { root, thread: sent.thread_id, comments, description, run, outs, errs };
}

test("a file to --out (nothing on stdout), Markdown on stdout, --pr in the description then updated, and a comment when it can't be edited", async () => {
  const w = await world();
  expect(await w.run(["--thread", w.thread, "--format", "html", "--out", "d.html"])).toBe(0);
  expect(readFileSync(join(w.root, "d.html"), "utf8")).toStartWith("<!doctype html>");
  expect(w.outs).toEqual([]);
  expect(await w.run(["--thread", w.thread])).toBe(0);
  expect(w.outs[0]!.split("\n")[0]).toBe(`<!-- plannotator-decisions v1 thread=${w.thread} -->`);
  expect(await w.run(["--thread", w.thread, "--pr", "acme/notes#12"])).toBe(0);
  expect(await w.run(["--thread", w.thread, "--pr", "acme/notes#12"])).toBe(0);
  expect(w.description.text).toStartWith("PR body.\n\n<!-- plannotator-decisions:start");
  w.description.locked = true;
  expect(await w.run(["--thread", w.thread, "--pr", "acme/notes#12"])).toBe(0);
  expect(w.outs.slice(1)).toEqual([
    "Decisions posted on acme/notes#12: https://github.com/acme/notes/pull/12\n",
    "Decisions updated on acme/notes#12: https://github.com/acme/notes/pull/12\n",
    "Decisions posted on acme/notes#12 as a comment instead (you can't edit its description): https://github.com/acme/notes/pull/12#issuecomment-5\n",
  ]);
  expect(w.comments).toHaveLength(1);
});

test("refusals exit 1 with the Inbox's code; bad usage exits 2", async () => {
  const w = await world();
  expect(await w.run(["--thread", w.thread, "--pr", "acme/other#3"])).toBe(1);
  expect(w.errs.at(-1)).toBe("pull_not_on_thread: That pull request is not on this thread. Add it to the thread first, then post.\n");
  expect(await w.run(["--thread", "msg_01M62DTT05NJ59ZR4AJCDJ70XK"])).toBe(1);
  expect(w.errs.at(-1)).toStartWith("thread_not_found:");
  expect(await w.run(["--pr", "acme/notes#12"])).toBe(2);
  expect(w.outs).toEqual([]);
});

test("the parser takes what the usage says, and refuses a flag it would ignore", () => {
  expect(parseExportDecisionsCommand(["--thread", "msg_1", "--format", "html", "--out", "x.html"])).toEqual({ ok: true, thread: "msg_1", format: "html", out: "x.html", pr: null });
  expect(parseExportDecisionsCommand(["--thread", "msg_1", "--pr", "a/b#1"])).toEqual({ ok: true, thread: "msg_1", format: "md", out: null, pr: "a/b#1" });
  for (const argv of [["--thread", "msg_1", "--pr", "a/b#1", "--out", "x"], ["--thread", "msg_1", "--format", "pdf"], ["msg_1"], ["--thread"], ["--thread", "a", "--thread", "b"]]) {
    expect(parseExportDecisionsCommand(argv).ok).toBe(false);
  }
});
