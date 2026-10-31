/**
 * A fixed Inbox and a fixed set of searches, for proving that search answers
 * do not move (search-parity.test.ts): the same seeded store, the same
 * queries with filters, "Show all" pages and the recent view, every answer
 * reduced to what the window draws and in what order (ids become stable
 * labels, `took_ms` is dropped).
 *
 * `author.host` (additive, approval "inbox-search-contrast") is left out, so
 * the recording made from main before it existed still compares. Re-record
 * only on purpose, when a change is meant to move results, from the commit
 * whose answers are the reference:
 *
 *   bun packages/shared/inbox/search-parity-world.ts --write packages/shared/inbox/search-parity.recorded.json
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import type { InboxSearchAnswer, InboxSearchQuery, InboxSearchRow } from "@plannotator/core/inbox-search";
import { InboxSearchIndex } from "./search";
import { InboxStore } from "./store";

type Agent = Extract<InboxAuthor, { kind: "agent" }>;
const CLAUDE: Agent = { kind: "agent", host: "claude-code", session: "ses_parity_c", name: null };
const CODEX: Agent = { kind: "agent", host: "codex", session: "ses_parity_x", name: null };
const PI: Agent = { kind: "agent", host: "pi", session: "ses_parity_p", name: null };
const OPENCODE: Agent = { kind: "agent", host: "opencode", session: "ses_parity_o", name: "OpenCode" };
const ask = (prompt: string, choices: string[]) => ["", ":::question", prompt, "", ...choices.map((c) => `- [ ] ${c}`), ":::"].join("\n");

/** The searches: words, prefixes and phrases, every filter, a tie broken by the open project, a "Show all" page, and none at all. */
function queries(projects: Record<string, string>): Record<string, InboxSearchQuery> {
  return {
    "bookma (prefix)": { q: "bookma" },
    "bookmarked post (two terms)": { q: "bookmarked post" },
    deploy: { q: "deploy" },
    "deploy, open in web (tie)": { q: "deploy", current: projects.web },
    "deploy, project api": { q: "deploy", project: projects.api },
    "deploy, waiting": { q: "deploy", status: "waiting" },
    "deploy, new": { q: "deploy", status: "new" },
    "deploy, sent": { q: "deploy", status: "sent" },
    "deploy, quiet": { q: "deploy", status: "quiet" },
    "deploy, archived": { q: "deploy", status: "archived" },
    "deploy, from me": { q: "deploy", from: "me" },
    "deploy, from agents, project web": { q: "deploy", from: "agent", project: projects.web },
    "rate lim (phrase and prefix)": { q: "rate lim" },
    "jitter yes (an answer)": { q: "jitter yes" },
    "saved posts, Show all messages from 2": { q: "saved", group: "messages", offset: 2, limit: 3 },
    "plannotator (projects)": { q: "plannotator" },
    "Russian": { q: "отчёт" },
    "Japanese": { q: "請求" },
    "no words, waiting": { q: "", status: "waiting" },
    "no words, project studio": { q: "", project: projects.studio },
    "nothing (recent)": { q: "" },
    "no match": { q: "zebra" },
  };
}

export async function searchParityAnswers(): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-search-parity-"));
  try {
    let clock = Date.parse("2026-10-20T09:00:00Z");
    const store = InboxStore.open(dir, { now: () => new Date((clock += 60_000)) });
    const api = store.ensureProject({ name: "api", root: "/w/api" });
    const web = store.ensureProject({ name: "web", root: "/w/web" });
    const exp = store.ensureProject({ name: "experiments", root: "/w/experiments" });
    const studio = store.ensureProject({ name: "content-studio", root: "/w/content-studio" });
    const pn = store.ensureProject({ name: "plannotator", root: "/src/plannotator" });
    const labels = new Map<string, string>();
    const send = (label: string, input: Parameters<InboxStore["sendMessage"]>[0]) => {
      const message = store.sendMessage(input).message;
      labels.set(message.id, label);
      return message;
    };

    // Bookmarks: a stream of saved posts in one named thread, a thread waiting on a question, a file.
    for (const [who, words] of [
      ["@jsnnsa", "stop applying old human-centric patterns to agent tools"],
      ["@mitchellh", "the search overlay landed and it is fast"],
      ["@rauchg", "the best command menus feel like a text field"],
      ["@karpathy", "most of my coding is now reviewing diffs"],
      ["@dflieb", "the most insane demo I have seen"],
    ] as const) {
      send(`bookmark ${who}`, { project_id: exp.id, author: CODEX, thread: "bookmarks", body: `You bookmarked a post by ${who}: "${words}". Saved to the reading list.` });
    }
    const thorsten = send("thorsten", { project_id: exp.id, author: CLAUDE, subject: "Bookmark: @thorstenball", thread: "thorsten", body: `A long post on agent-first editors.${ask("Add it to the weekly digest?", ["Add it", "Skip"])}` });
    const videos = send("videos 1", { project_id: studio.id, author: PI, subject: "Lab launch videos", thread: "videos", body: 'The cut runs on your real saves. A bookmark from last night opens the video.' });
    send("videos 2", { project_id: studio.id, author: PI, thread: "videos", body: 'The hero: your "delete all your wikis" bookmark came back in 56 s.' });
    send("import plan", {
      project_id: pn.id,
      author: CLAUDE,
      subject: "Bookmarks import plan",
      thread: "bookmarks-import",
      body: "Import X bookmarks as Inbox threads. Two open choices at the end.",
      attachments: [{ id: "att_parity_plan", path: "/src/plannotator/docs/plans/bookmarks-import-plan.md", named_path: null, name: "bookmarks-import-plan.md", kind: "markdown", sent_sha256: "0".repeat(64), size: 10, sent_at: new Date(clock).toISOString(), sent_mtime: new Date(clock).toISOString() }],
    });
    send("sidebar", { project_id: web.id, author: OPENCODE, subject: "Bookmarks sidebar syncs", thread: "bookmarks-sidebar", body: "The bookmarks sidebar syncs from the same store." });

    // Deploys across every section, a reply from the person, an archived thread.
    const waiting = send("deploy order", { project_id: api.id, author: CLAUDE, subject: "Deploy order", thread: "deploy-order", body: `Deploy order for tonight?${ask("Relay first?", ["Yes", "No"])}` });
    const preview = send("deploy preview", { project_id: web.id, author: PI, subject: "Deploy preview", thread: "deploy-preview", body: "The deploy preview is up." });
    labels.set(store.sendReply(preview.id, { idempotency_key: "parity-1", words: "Thanks, deploy it to production." }).reply.id, "reply deploy it");
    const log = send("deploy log", { project_id: api.id, author: CLAUDE, subject: "Deploy log", thread: "deploy-log", body: "The deploy log is attached." });
    store.markSeen(log.id);
    send("deploy finished web", { project_id: web.id, author: CLAUDE, subject: "Deploy finished", thread: "deploy-web", body: "The deploy finished on web." });
    send("deploy finished api", { project_id: api.id, author: CLAUDE, subject: "Deploy finished", thread: "deploy-api", body: "The deploy finished on api." });
    const rollback = send("deploy rollback", { project_id: api.id, author: CODEX, subject: "Deploy rollback", thread: "deploy-rollback", body: "We rolled the deploy back." });
    store.resolveThread(rollback.id, true);
    void waiting;

    // A question answered and a reply that names the answer; prefixes and phrases.
    const storm = send("retry storm", { project_id: api.id, author: CLAUDE, subject: "Retry storm", thread: "retry", body: `Phones reconnect at once.${ask("Add jitter?", ["Yes", "No"])}` });
    const q = store.questionsOf(storm.id)[0]!;
    store.savePicks(storm.id, [{ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Yes"] } as never }]);
    labels.set(store.sendReply(storm.id, { idempotency_key: "parity-2", words: "Spread the first retry over five seconds.", questions: [{ key: q.key, revision: 1 }] }).reply.id, "reply spread");
    const rateLimit = send("rate limit", { project_id: pn.id, author: CLAUDE, subject: "Relay: rate limit on mailbox creation", thread: "relay", body: "The relay rate limits mailbox creation to 20 a minute." });
    send("rate limiter", { project_id: api.id, author: PI, subject: "Limiter", thread: "limiter", body: "The rate limiter now counts per key." });

    // Other scripts.
    send("russian", { project_id: api.id, author: CODEX, subject: "Отчёт о миграции", thread: "ru", body: "Отчёт готов: миграция прошла без ошибок." });
    send("japanese", { project_id: api.id, author: PI, subject: "請求サービスの更新", thread: "ja", body: "請求サービスを更新しました。" });

    // Three more threads looked at, so the recent view holds four (with the deploy log) and its order, newest
    // message looked at first (`person_seen_seq`), is guarded: rate limit, deploy log, videos, thorsten.
    store.markSeen(rateLimit.id);
    store.markSeen(thorsten.id);
    store.markSeen(videos.id);

    const index = new InboxSearchIndex(store);
    await index.ensureBuilt();
    const projectNames = new Map([api, web, exp, studio, pn].map((p) => [p.id, p.name]));
    const label = (id: string) => labels.get(id) ?? projectNames.get(id) ?? `?${id.slice(0, 4)}`;
    const row = (r: InboxSearchRow) => {
      const { id, project, at, ...rest } = r as InboxSearchRow & { thread_id?: string; message_id?: string; author?: { host?: unknown } };
      const out: Record<string, unknown> = { ...rest, id: label(id), project: project.name, at };
      if ("thread_id" in rest && rest.thread_id) out.thread_id = label(rest.thread_id);
      if ("message_id" in rest && rest.message_id) out.message_id = label(rest.message_id);
      if (r.type === "message") {
        const { host: _host, ...author } = r.author;
        out.author = author;
      }
      if (r.type === "file" || r.type === "guide") out.id = r.type === "file" ? r.name : label(r.id);
      return out;
    };
    const reduce = (answer: InboxSearchAnswer) => {
      const { took_ms: _took, groups, recent, ...rest } = answer;
      return {
        ...rest,
        groups: groups ? Object.fromEntries(Object.entries(groups).map(([g, rows]) => [g, (rows ?? []).map(row)])) : null,
        recent: recent ? recent.map(row) : null,
      };
    };
    const ids = { api: api.id, web: web.id, studio: studio.id };
    return Object.fromEntries(Object.entries(queries(ids)).map(([name, query]) => [name, reduce(index.search(query))]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const at = process.argv.indexOf("--write");
  const answers = await searchParityAnswers();
  const json = `${JSON.stringify(answers, null, 2)}\n`;
  if (at > 0 && process.argv[at + 1]) writeFileSync(process.argv[at + 1]!, json);
  else process.stdout.write(json);
}
