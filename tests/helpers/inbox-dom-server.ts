/**
 * A real Inbox server for the window's DOM tests, run as its own process:
 * under DOM_TESTS=1 happy-dom replaces the test process's Response, which
 * Bun.serve cannot answer with, so the server lives here instead.
 *
 *   bun tests/helpers/inbox-dom-server.ts <data dir> <projects dir> <count> [news | header-files | phones | whats-new]
 *
 * Seeds `count` projects (one per test, since the window keeps the first
 * server session it saw), each with a thread an agent is stopped on (two
 * questions), one waiting on a single question, one two sessions write
 * in (A asks, B posts a later update), two ONE session writes in (it asks,
 * then posts a later update; in the second the person already picked), and
 * one with a file attached, prints one JSON line `{ port, worlds: [{ project,
 * stopped, waiting, mixed, update, same, sameUpdate, picked, pickedUpdate,
 * filed, attachment, news }] }`, and runs until killed. With a fourth argument `news`, each
 * world also has three threads of plain agent news (no question: "New since
 * you looked"), oldest first in `news`. A JSON line on stdin,
 * `{ "send": { project, session, body, reply_to? } }`, is an agent writing
 * while a test runs; the server answers `{ "sent": <message id> }` on stdout.
 * `{ "deliver": { session } }` is that session's connection delivering every
 * reply waiting for it (the bridge's `delivered`); the server answers
 * `{ "delivered": [<reply id>] }`. `{ "wait": { thread, session } }` is that
 * agent calling `wait_for_reply` on the thread through the Inbox's own MCP
 * (`/mcp`, a real MCP client); the server answers `{ "waited": <its
 * structured result> }`. The set-aside note's delay (also the 👍
 * Looks good Undo window) is a minute, so no note is written while a test
 * runs, unless `INBOX_DOM_SET_ASIDE_MS` names a shorter one.
 *
 * With a fourth argument `header-files`, each project also gets a thread one
 * session writes three messages in: three files (one changed on disk after it
 * was sent), then none, then one; the world adds `files` (`{ thread, first,
 * middle, last, ids: { <name>: <attachment id> } }`). Without it the seed is
 * exactly as before. With `phones` instead, the Inbox serves phones (see
 * `machine.json` below); the seed is the same.
 *
 * With a fourth argument `sent-multi`, each project also gets a message
 * holding a pick-any question (with a recommendation) and a pick-one
 * question, where the person sent an answer to the pick-any one only
 * (`Toasts`, not the recommendation) and kept the other open; the world adds
 * `sentMulti` (the message id).
 *
 * With `open-in`, "Open in" launches nothing: a recording launcher (platform
 * `OPEN_IN_PLATFORM`, default mac; apps Finder, VS Code, Cursor, Zed) appends
 * each launch to `<data dir>/launches.jsonl`. Each project also gets a thread
 * with page.html, plan.md, build.zip, shot.png and gone.md (deleted after it
 * was sent: missing); the world adds `openIn` (`{ thread, ids: { <name>: <id> } }`).
 * With `html-links`, each project also gets a thread whose message attaches
 * `site/SHEET.html` and `site/frames/a.png`; the page links to a sibling page
 * that is not attached (`B-cards.html`), both images (`b.png` is not
 * attached), a PDF beside it and another site. The world adds `htmlLinks`
 * (`{ thread, ids: { <name>: <attachment id> } }`).
 *
 * The Inbox is published over the tailnet by a scripted `tailscale`, and the
 * first line adds `tailnet: { listener, host, login }`: a request to that
 * loopback port with that Host and login is one `tailscale serve` hands over.
 *
 * With `tags` (approval "inbox-tag-agents"), the mock's sample threads are
 * seeded too (tests/helpers/inbox-tag-world.ts): live connections that poll
 * as the mod, Pi and OpenCode do (one Pi on an older Plannotator, without
 * the tags capability) and Codex through MCP only; the first line adds
 * `tags: { ids, sessions }`. `{ "deliver": { session } }` then delivers what
 * that session is handed, tagged replies included.
 * With `restart` (the restart warning, owner approval "restart-warning"):
 * this Inbox is 0.28.25, its release check never reaches GitHub, and Claude
 * Code's plugin registry is a scratch `<data dir>/claude/plugins/installed_plugins.json`
 * recording plugin 0.28.25 (CLAUDE_CONFIG_DIR, read through the Inbox's agent
 * environment, never the person's ~/.claude). Each project also gets a
 * thread a waking Claude Code session (`ses_r<i>`) asked in and the person
 * replied to; the world adds `restart: { thread, session, installPath }`. A
 * stdin line `{ "poll": { session, body } }` is that session's connection
 * polling the bridge with `body`'s fields (`plugin`, `busy`, `send_now`...);
 * the server answers `{ "polled": true, commands }` (what the poll handed it). A
 * stdin line `{ "card": { project, session, title, say?, thread? } }` is that
 * agent making a card (in Backlog, linked to its thread); the server answers
 * `{ "carded": <card id> }`.
 * With `reload-hosts` (owner approval "reload-hosts"): the same Inbox 0.28.25
 * and scratch registry as `restart`, and each project also gets three threads
 * a waking Pi (`ses_pi<i>`), Oh My Pi (`ses_omp<i>`, host `pi`) and OpenCode
 * (`ses_oc<i>`) session asked in and the person replied to; the world adds
 * `hosts: { pi, omp, opencode }`, each `{ thread, session }`. A `poll` line's
 * `body.host` names the host the connection polls as.
 *
 * With `guide` (approval "inbox-guide-diff-style"), each project also gets a
 * thread whose agent sent a guided review of two sections (two files each
 * side of a two-section patch) through the Inbox's own MCP (`submit_guide`);
 * the world adds `guide` (`{ thread, message }`).
 *
 * With `artifacts` (approval "inbox-thread-artifacts"), each project also gets a
 * thread of five messages through the Inbox's own MCP and routes: an agent's
 * text showing `design/before.png` that also attaches it with `docs/spec.md`;
 * the person's reply with `sketch.png` pasted in; an agent's `after.png` in the
 * text with `traces.zip` attached; a guided review; and an agent's
 * `flow.sql`. The world adds `artifacts` (`{ thread, ids: { <name>: <id> },
 * guide }`: the inline image's id under `before.png`, the attached copy's under
 * `before.png (attached)`).
 *
 * With `decisions` (decision mode, experimental; approval "inbox-decision-mode"):
 * config.json turns decision mode on, and each project gets only this seed in
 * place of the one above: Claude Code (`ses_da<i>`) asks two questions in one
 * message (a Stopped pick-one of three, recommended, then a two-way), and
 * Codex (`ses_db<i>`) asks one two-way question in the same thread (`reply_to`
 * a: decision mode is thread only, so the thread holds both agents). The
 * world is `{ project, root, decide: { a, b, sessionA, sessionB } }`. A `send`
 * line on stdin may carry `supersedes` (and `host`).
 *
 * With `first-run`, nothing is seeded (no project: the window opens on the
 * first-run screen) and the first line's `worlds` is empty. A stdin line
 * `{ "first": { root, session, body } }` is an agent writing its first
 * message from folder `root` (made if missing); the server answers
 * `{ "sent": <message id>, "project": <project id> }`. Start one server per
 * test: the first message ends the first run for good.
 *
 * With `sent-reply`, each project also gets a thread one Claude Code session
 * (`ses_sr<i>`) asks in twice: message `a` with two questions, then `b` with
 * one; the person sent ONE reply with words ("Go with the dense table.
 * Thanks!") answering a's first and b's question and skipping a's second,
 * plus a comment's feedback text. And a second thread whose one question the
 * person answered with no words. The world adds `sentReply` (`{ thread, a, b,
 * reply, simple, simpleReply }`).
 *
 * With `leaked-subject`, each project also gets a thread whose STORED subject
 * holds an agent's leaked tool-call text, as an Inbox older than the one-line
 * subject check kept it (tests/helpers/inbox-leaked-subject.ts); the world
 * adds `leaked` (that thread's id).
 */
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer } from "../../packages/server/inbox";
import type { InboxOpenInLauncher } from "../../packages/server/inbox-open-in";
import { recordInboxAttachments } from "../../packages/shared/inbox/attachments";
import { writeUpdateState } from "../../packages/shared/update-check";
import { parseInboxBridgeCommands } from "../../packages/shared/inbox/connection";
import { createAgentEnvironmentFor } from "../../packages/server/inbox-agents";
import { isScratchDataDir, refuseRealDataDir } from "./real-data-dir";
import { seedTagWorld, TAG_SESSIONS } from "./inbox-tag-world";
import { seedLeakedSubjects } from "./inbox-leaked-subject";
import { markTourDecided } from "./tour-decided";

const [dataDir, projectsDir, countArg, extra] = process.argv.slice(2);
const withNews = extra === "news";
const count = Number(countArg ?? "1");
if (!dataDir || !projectsDir || !Number.isInteger(count) || count < 1) {
  process.stderr.write("usage: inbox-dom-server.ts <data dir> <projects dir> <count>\n");
  process.exit(2);
}
// A scratch data dir only, never the person's real one.
refuseRealDataDir(dataDir, "inbox-dom-server.ts");
// startInboxServer reads and writes config.json through getPlannotatorDataDir()
// even when it is given dataDir: point the env at the same scratch folder.
process.env.PLANNOTATOR_DATA_DIR = dataDir;
// The composers' skill picker reads the global skill folders under HOME (and
// CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME): only a scratch HOME's,
// never the person's. A test that wants skills writes them under its HOME.
const scratchHome = isScratchDataDir(process.env.HOME?.trim() || "/") ? process.env.HOME!.trim() : join(dataDir, "home");
process.env.HOME = scratchHome;
process.env.CLAUDE_CONFIG_DIR = join(scratchHome, ".claude");
process.env.CODEX_HOME = join(scratchHome, ".codex");
process.env.XDG_CONFIG_HOME = join(scratchHome, ".config");
// OpenCode 2's config (its plugin spec): the scratch one under XDG_CONFIG_HOME, never a real OPENCODE_CONFIG_DIR or OPENCODE_CONFIG.
delete process.env.OPENCODE_CONFIG_DIR;
delete process.env.OPENCODE_CONFIG;

const STOPPED = [
  "Before I build the invoice list:",
  "",
  ":::question",
  "Which layout should the invoice list use?",
  "",
  "Stopped: the list cannot be built without this.",
  "",
  "- [ ] Cards",
  "- [ ] A dense table",
  ":::",
  "",
  ":::question",
  "Should overdue invoices sort to the top?",
  "",
  "- [ ] Yes",
  "- [ ] No",
  ":::",
].join("\n");

const WAITING = ["The docs site needs a search index.", "", ":::question", "Which search index should the docs use?", "", "- [ ] Pagefind", "- [ ] Orama", ":::"].join("\n");

/**
 * With a fourth argument `phones`: the Inbox serves phones, with Tailscale and
 * step 1's checks scripted from `<data dir>/machine.json`, read on every call
 * (`{ backend, tsMissing, serveFails, noAddress, noOpenssl, noBonjour, firewall }`), so a
 * test sets what this computer looks like and never runs the real
 * `tailscale`, `openssl` or system tools. The serve mappings it records are
 * real loopback ports: the tailnet's door listener answers on them.
 */
const machine = (): Record<string, any> => {
  try {
    return JSON.parse(readFileSync(join(dataDir, "machine.json"), "utf8"));
  } catch {
    return {};
  }
};
const serve = new Map<number, string>();
const phonesMode = extra === "phones";
const tailscale = (args: string[]) => {
  const m = machine();
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  if (m.tsMissing) return { error: Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" }), status: null, stdout: "", stderr: "" };
  if (args[0] === "status") {
    return ok(JSON.stringify({ BackendState: m.backend ?? "Running", Self: { DNSName: "macbook.tail0000.ts.net.", UserID: 1 }, User: { "1": { LoginName: "ramos@example.com" } }, CertDomains: ["macbook.tail0000.ts.net"] }));
  }
  if (args[1] === "status") {
    if (serve.size === 0) return ok("{}");
    const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
    const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`macbook.tail0000.ts.net:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
    return ok(JSON.stringify({ TCP, Web }));
  }
  const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
  if (args.includes("off")) {
    serve.delete(httpsPort);
    return ok();
  }
  if (m.serveFails) return { status: 1, stdout: "", stderr: "Tailscale is stopped." };
  serve.set(httpsPort, args.at(-1)!);
  return ok(`Available within your tailnet:\n\nhttps://macbook.tail0000.ts.net:${httpsPort}/\n`);
};
const pairingProbes = {
  lanAddress: () => (machine().noAddress ? null : "192.168.1.42"),
  network: () => (machine().noAddress ? null : "Ramos Home"),
  which: (command: string) =>
    (command === "openssl" && machine().noOpenssl) || (command !== "openssl" && machine().noBonjour) ? null : `/usr/bin/${command}`,
  firewall: () => (machine().firewall ?? "off") as "off" | "on" | "block_all" | "unknown",
};
/**
 * With a fourth argument `whats-new`: this Inbox is 0.28.19 and the one before
 * it ran 0.28.18 (the install script run by hand: no notes saved), and the
 * release API is a fake on loopback here (PLANNOTATOR_UPDATE_API_URL), never
 * GitHub. PLANNOTATOR_UPDATE_CHECK from the test's env still applies.
 */
const whatsNewMode = extra === "whats-new";
if (whatsNewMode) {
  writeUpdateState({ inboxVersion: "0.28.18" }, dataDir);
  const releaseApi = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/releases/latest")) return Response.json({ tag_name: "v0.28.19", body: "" });
      const m = /\/releases\/tags\/v(\d+\.\d+\.\d+)$/.exec(path);
      if (!m) return new Response("not found", { status: 404 });
      return Response.json({ tag_name: `v${m[1]}`, body: `## What's New in v${m[1]}\n\nWhat ${m[1]} brings to the Inbox.\n\n## Install / Update\n` });
    },
  });
  process.env.PLANNOTATOR_UPDATE_API_URL = `http://127.0.0.1:${releaseApi.port}/releases/latest`;
}
const openInMode = extra === "open-in";
const decisionsMode = extra === "decisions";
// Decision mode is experimental and off by default: this mode turns it on in the scratch config.json.
if (decisionsMode) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ experimental: { decisionMode: true } }));
}
const reloadHostsMode = extra === "reload-hosts";
const restartMode = extra === "restart" || reloadHostsMode;
const claudeDir = join(dataDir, "claude");
const pluginFolder = (version: string) => join(claudeDir, "plugins", "cache", "plannotator", "plannotator", version);
if (restartMode) {
  mkdirSync(join(claudeDir, "plugins"), { recursive: true });
  writeFileSync(
    join(claudeDir, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "plannotator@plannotator": [
          { scope: "user", installPath: pluginFolder("0.28.25"), version: "0.28.25", installedAt: "2026-10-04T22:07:24.658Z", lastUpdated: "2026-10-17T05:27:07.299Z" },
        ],
      },
    }),
  );
}
/** Records each launch instead of starting an app. */
const recordLaunch = (app: string, path: string) => {
  appendFileSync(join(dataDir, "launches.jsonl"), `${JSON.stringify({ app, path })}\n`);
  return Promise.resolve({ ok: true as const });
};
const openInLauncher: InboxOpenInLauncher = {
  platform: (process.env.OPEN_IN_PLATFORM ?? "mac") as "mac" | "win" | "linux",
  apps: () => [
    { id: "reveal", label: "Finder", kind: "file-manager", icon: "finder" },
    { id: "vscode", label: "VS Code", kind: "editor", icon: "vscode" },
    { id: "cursor", label: "Cursor", kind: "editor", icon: "cursor" },
    { id: "zed", label: "Zed", kind: "editor", icon: "zed" },
  ],
  reveal: (path) => recordLaunch("reveal", path),
  openWithApp: (app, path) => recordLaunch(app.id, path),
  openWithSystemDefault: (path) => recordLaunch("default", path),
};
// Written before the Inbox opens the store: it reads the raw lines at start.
const leakedIds =
  extra === "leaked-subject"
    ? seedLeakedSubjects(
        dataDir,
        Array.from({ length: count }, (_, i) => {
          const root = join(projectsDir, `billing-${i}`);
          mkdirSync(root, { recursive: true });
          return { name: `billing-${i}`, root };
        }),
      )
    : [];
const server = await startInboxServer({
  dataDir,
  setAsideDelayMs: Number(process.env.INBOX_DOM_SET_ASIDE_MS) > 0 ? Number(process.env.INBOX_DOM_SET_ASIDE_MS) : 60_000,
  phones: phonesMode,
  ...(phonesMode ? { tailscale, pairingProbes } : {}),
  ...(openInMode ? { openInLauncher, tailscale, publishTailnet: true } : {}),
  ...(whatsNewMode ? { version: "0.28.19", binaryPath: null } : {}),
  ...(restartMode
    ? {
        version: "0.28.25",
        binaryPath: null,
        agentEnvironment: createAgentEnvironmentFor({ platform: process.platform, homeDir: scratchHome, env: { HOME: scratchHome, CLAUDE_CONFIG_DIR: claudeDir, PATH: "" } }),
        updates: { fetchRelease: async () => ({ ok: false as const, error: "offline in tests" }), isManaged: () => false, listSessions: () => [] },
      }
    : {}),
});
const store = server.store;
type World = {
  project: string;
  stopped: string;
  waiting: string;
  mixed: string;
  update: string;
  same: string;
  sameUpdate: string;
  picked: string;
  pickedUpdate: string;
  filed: string;
  attachment: string;
  files?: { thread: string; first: string; middle: string; last: string; ids: Record<string, string> };
  sentMulti?: string;
  openIn?: { thread: string; ids: Record<string, string> };
  htmlLinks?: { thread: string; ids: Record<string, string> };
  restart?: { thread: string; session: string; project: string; installPath: string; oldPath: string };
  hosts?: Record<"pi" | "omp" | "opencode", { thread: string; session: string }>;
  leaked?: string;
  guide?: { thread: string; message: string };
  artifacts?: { thread: string; ids: Record<string, string>; guide: string };
  sentReply?: { thread: string; a: string; b: string; reply: string; simple: string; simpleReply: string };
  news: string[];
};
/** The guided review the `guide` mode sends: two sections, one file each, so the first card and the second differ. */
const DOM_GUIDE = {
  body: "I wrote a guided review of the token refresh change.",
  guide: {
    title: "Token refresh",
    intent: "Refresh tokens before they expire.",
    sections: [
      { title: "The guard", overview: "Where the refresh happens.", diffs: [{ file: "src/auth.ts", summary: "Adds the refresh guard." }] },
      { title: "The session", overview: "What the session remembers.", diffs: [{ file: "src/session.ts", summary: "Keeps the expiry." }] },
    ],
    review: { gitRef: "origin/main...HEAD", base: "origin/main" },
    generator: { engine: "claude-code", model: "claude-opus-5" },
  },
  patch:
    "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,3 @@\n export function refresh() {\n-  return old();\n+  return early();\n }\n" +
    "diff --git a/src/session.ts b/src/session.ts\n--- a/src/session.ts\n+++ b/src/session.ts\n@@ -1,2 +1,3 @@\n export interface Session {\n+  expiresAt: number;\n }\n",
};
const SENT_MULTI = [
  "Two things before the release:",
  "",
  ":::question-multi",
  "Which indicators ship?",
  "",
  "- [ ] Dot",
  "- [ ] Banner",
  "- [ ] Toasts",
  "",
  "Recommended: Dot, Banner",
  ":::",
  "",
  ":::question",
  "Which channel announces it?",
  "",
  "- [ ] Blog",
  "- [ ] Changelog",
  "",
  "Recommended: Changelog",
  ":::",
].join("\n");
const worlds: World[] = [];
// `first-run-tour`: a first run whose window opens on the tour's entry screen (packages/inbox/tour.test.tsx).
const firstRunMode = extra === "first-run" || extra === "first-run-tour";
// Every other first run opens on the connect screen, as before the tour: the tour is marked skipped.
if (extra === "first-run") markTourDecided(dataDir);
for (let i = 0; i < (firstRunMode ? 0 : count); i++) {
  const root = join(projectsDir, `billing-${i}`);
  mkdirSync(root, { recursive: true });
  const project = store.ensureProject({ name: `billing-${i}`, root });
  const author = { kind: "agent" as const, host: "claude-code", session: `ses_a${i}`, name: "Claude Code" };
  if (decisionsMode) {
    const sessionA = `ses_da${i}`;
    const sessionB = `ses_db${i}`;
    const a = store.sendMessage({
      project_id: project.id,
      author: { ...author, session: sessionA },
      body: [
        "Two calls before the refund worker ships.",
        "",
        ":::question",
        "Which way should the worker go on a Stripe 409?",
        "",
        "Stopped: the refund worker cannot ship without this.",
        "",
        "- [ ] Retry with the same key — Stripe charges once per key",
        "- [ ] Fail to the dead-letter queue — today's behavior",
        "- [ ] Retry with a new key — fastest, can refund twice",
        "",
        "Recommended: Retry with the same key",
        ":::",
        "",
        ":::question",
        "Page on-call after 5 tries?",
        "",
        "- [ ] Yes, page on-call",
        "- [ ] No, a daily digest",
        ":::",
      ].join("\n"),
    }).message;
    const b = store.sendMessage({
      project_id: project.id,
      author: { kind: "agent", host: "codex", session: sessionB, name: "Codex" },
      body: [":::question", "Ship the new flag off by default?", "", "- [ ] Yes", "- [ ] No", ":::"].join("\n"),
      // In Claude Code's thread: decision mode is thread only, so one thread holds two agents' decisions.
      reply_to: a.id,
    }).message;
    worlds.push({ project: project.id, root, decide: { a: a.id, b: b.id, sessionA, sessionB } } as unknown as World);
    continue;
  }
  const stopped = store.sendMessage({ project_id: project.id, author, body: STOPPED }).message;
  const waiting = store.sendMessage({ project_id: project.id, author: { ...author, session: `ses_b${i}` }, body: WAITING }).message;
  // One thread two sessions write in: A asks, then B posts a later update in it.
  const asking = store.sendMessage({ project_id: project.id, author: { ...author, session: `ses_m${i}` }, body: WAITING.replace("docs site", "admin site") }).message;
  const update = store.sendMessage({ project_id: project.id, author: { ...author, session: `ses_n${i}`, name: "Codex", host: "codex" }, body: "Update: the admin index builds now.", reply_to: asking.id }).message;
  // One thread one session writes in: it asks, then posts a later update in it.
  const sameAuthor = { ...author, session: `ses_s${i}` };
  const same = store.sendMessage({ project_id: project.id, author: sameAuthor, body: WAITING.replace("docs site", "status page") }).message;
  const sameUpdate = store.sendMessage({ project_id: project.id, author: sameAuthor, body: "Update: the status page builds now.", reply_to: same.id }).message;
  // The same shape with a pick saved and not sent.
  const pickedAuthor = { ...author, session: `ses_p${i}` };
  const picked = store.sendMessage({ project_id: project.id, author: pickedAuthor, body: WAITING.replace("docs site", "help center") }).message;
  const pickedUpdate = store.sendMessage({ project_id: project.id, author: pickedAuthor, body: "Update: the help center builds now.", reply_to: picked.id }).message;
  const question = store.questionsOf(picked.id)[0]!;
  store.savePicks(picked.id, [
    { key: question.key, revision: question.revision, answer: { v: 1, key: question.key, kind: question.kind, prompt: question.prompt, selected: ["Pagefind"] } },
  ]);
  // A thread with a file attached, for the keys that stand down in the file viewer.
  writeFileSync(join(root, "notes.md"), "# Notes\n\nThe plan, in short.\n");
  const attachments = await recordInboxAttachments(store.dir, ["notes.md"], { base: root, at: new Date().toISOString() });
  const filed = store.sendMessage({ project_id: project.id, author: { ...author, session: `ses_f${i}` }, body: WAITING.replace("docs site", "notes"), attachments }).message;
  let files: World["files"];
  if (extra === "header-files") {
    // One session writes three messages: three files (one edited after it was sent), none, then one.
    const headerAuthor = { ...author, session: `ses_h${i}` };
    writeFileSync(join(root, "spec.md"), "# Spec\n\nWhat ships first.\n");
    writeFileSync(join(root, "plan.html"), "<!doctype html><title>plan</title><h1>Plan</h1>\n");
    writeFileSync(join(root, "run.sh"), "#!/bin/sh\necho run\n");
    writeFileSync(join(root, "listing.md"), "# Store listing\n\nA first pass.\n");
    const at = new Date().toISOString();
    const three = await recordInboxAttachments(store.dir, ["spec.md", "plan.html", "run.sh"], { base: root, at });
    const first = store.sendMessage({ project_id: project.id, author: headerAuthor, body: "Here is the scope.\n\nThe files are attached.", attachments: three }).message;
    writeFileSync(join(root, "plan.html"), "<!doctype html><title>plan</title><h1>Plan, revised</h1>\n");
    const middle = store.sendMessage({ project_id: project.id, author: headerAuthor, body: "Update: nothing attached this time.", reply_to: first.id }).message;
    const one = await recordInboxAttachments(store.dir, ["listing.md"], { base: root, at });
    const last = store.sendMessage({ project_id: project.id, author: headerAuthor, body: "The listing draft is attached.", reply_to: first.id, attachments: one }).message;
    files = { thread: first.id, first: first.id, middle: middle.id, last: last.id, ids: Object.fromEntries([...three, ...one].map((a) => [a.name, a.id])) };
  }
  let sentMulti: string | undefined;
  if (extra === "sent-multi") {
    const sentAuthor = { ...author, session: `ses_sm${i}` };
    const message = store.sendMessage({ project_id: project.id, author: sentAuthor, body: SENT_MULTI }).message;
    const multi = store.questionsOf(message.id).find((q) => q.kind === "multi")!;
    store.sendReply(message.id, {
      idempotency_key: `sent-multi-${i}`,
      skip_unanswered: false,
      questions: [{ key: multi.key, revision: multi.revision, answer: { v: 1, key: multi.key, kind: multi.kind, prompt: multi.prompt, selected: ["Toasts"] } }],
    });
    sentMulti = message.id;
  }
  let sentReply: World["sentReply"];
  if (extra === "sent-reply") {
    const replyAuthor = { ...author, session: `ses_sr${i}` };
    const a = store.sendMessage({
      project_id: project.id,
      author: replyAuthor,
      body: [
        "Two calls on the invoice export:",
        "",
        ":::question",
        "Which layout should the **export** use?",
        "",
        "- [ ] Cards",
        "- [ ] A dense table",
        ":::",
        "",
        ":::question",
        "Should the export include voided invoices?",
        "",
        "- [ ] Yes",
        "- [ ] No",
        ":::",
      ].join("\n"),
    }).message;
    const b = store.sendMessage({
      project_id: project.id,
      author: replyAuthor,
      reply_to: a.id,
      body: [":::question", "Ship it behind a flag?", "", "- [ ] Yes, behind a flag", "- [ ] No", ":::"].join("\n"),
    }).message;
    const [layout, voided] = store.questionsOf(a.id);
    const [flag] = store.questionsOf(b.id);
    const answer = (q: typeof layout, selected: string[]) => ({ v: 1 as const, key: q!.key, kind: q!.kind, prompt: q!.prompt, selected });
    const reply = store.sendReply(b.id, {
      idempotency_key: `sent-reply-${i}`,
      words: "Go with the dense table. Thanks!",
      questions: [
        { message_id: a.id, key: layout!.key, revision: layout!.revision, answer: answer(layout, ["A dense table"]) },
        { key: flag!.key, revision: flag!.revision, answer: answer(flag, ["Yes, behind a flag"]) },
      ],
      skip: [{ message_id: a.id, key: voided!.key }],
      feedback: "# Feedback on the attached files\n\n## notes.md\n\n### 1. Feedback on: \"The plan\"\n> Say which plan.",
    }).reply!;
    const simple = store.sendMessage({ project_id: project.id, author: { ...author, session: `ses_sq${i}` }, body: WAITING.replace("docs site", "export page") }).message;
    const [only] = store.questionsOf(simple.id);
    const simpleReply = store.sendReply(simple.id, { idempotency_key: `sent-simple-${i}`, questions: [{ key: only!.key, revision: only!.revision, answer: answer(only, ["Pagefind"]) }] }).reply!;
    sentReply = { thread: a.thread_id, a: a.id, b: b.id, reply: reply.id, simple: simple.thread_id, simpleReply: simpleReply.id };
  }
  let openIn: World["openIn"];
  if (openInMode) {
    const names = ["page.html", "plan.md", "build.zip", "shot.png", "gone.md"];
    writeFileSync(join(root, "page.html"), "<!doctype html><title>Checkout</title><h1>Checkout</h1>\n");
    writeFileSync(join(root, "plan.md"), "# Rollout plan\n\nShip it.\n");
    writeFileSync(join(root, "build.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0xff, 0xfe]));
    writeFileSync(join(root, "shot.png"), Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex"));
    writeFileSync(join(root, "gone.md"), "# Gone\n");
    const sentFiles = await recordInboxAttachments(store.dir, names, { base: root, at: new Date().toISOString() });
    const thread = store.sendMessage({ project_id: project.id, author: { ...author, session: `ses_o${i}` }, body: "The page, the plan and the build are attached.", attachments: sentFiles }).message;
    unlinkSync(join(root, "gone.md"));
    openIn = { thread: thread.id, ids: Object.fromEntries(sentFiles.map((a, n) => [names[n]!, a.id])) };
  }
  let htmlLinks: World["htmlLinks"];
  if (extra === "html-links") {
    const site = join(root, "site");
    mkdirSync(join(site, "frames"), { recursive: true });
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f0005fe02fe0dd8a2c90000000049454e44ae426082",
      "hex",
    );
    writeFileSync(
      join(site, "SHEET.html"),
      '<!doctype html><title>Sheet</title><h1>Sheet</h1><a href="B-cards.html#pr1">B</a> <a href="frames/a.png">a</a> <a href="frames/b.png">b</a> <a href="report.pdf">pdf</a> <a href="https://example.com/x">site</a>\n',
    );
    writeFileSync(join(site, "B-cards.html"), '<!doctype html><title>Cards</title><h1 id="pr1">Cards</h1><a href="SHEET.html">home</a> <a href="C-between.html">C</a>\n');
    writeFileSync(join(site, "C-between.html"), "<!doctype html><title>Between</title><h1>Between</h1>\n");
    writeFileSync(join(site, "frames", "a.png"), png);
    writeFileSync(join(site, "frames", "b.png"), png);
    writeFileSync(join(site, "report.pdf"), "%PDF-1.4\n");
    const linkFiles = await recordInboxAttachments(store.dir, ["site/SHEET.html", "site/frames/a.png"], { base: root, at: new Date().toISOString() });
    const thread = store.sendMessage({ project_id: project.id, author: { ...author, session: `ses_l${i}` }, body: "The contact sheet and one frame.", attachments: linkFiles }).message;
    htmlLinks = { thread: thread.id, ids: Object.fromEntries(linkFiles.map((a) => [a.name, a.id])) };
  }
  let restart: World["restart"];
  if (restartMode) {
    const session = `ses_r${i}`;
    const asked = store.sendMessage({
      project_id: project.id,
      author: { ...author, session },
      body: "Retry policy for the Stripe webhook: shipped the queue. Anything else?",
      wakes: true,
    }).message;
    store.sendReply(asked.id, { idempotency_key: `restart-${i}`, words: "Queue it. Cap retries at 5 and dead-letter after." });
    restart = { thread: asked.id, session, project: root, installPath: pluginFolder("0.28.25"), oldPath: pluginFolder("0.28.23") };
  }
  let hosts: World["hosts"];
  if (reloadHostsMode) {
    const ask = (key: string, host: string, name: string) => {
      const session = `ses_${key}${i}`;
      const asked = store.sendMessage({ project_id: project.id, author: { kind: "agent", host, session, name }, body: `${name}: the export runs nightly now. Anything else?`, wakes: true }).message;
      store.sendReply(asked.id, { idempotency_key: `reload-${key}-${i}`, words: "Add a dry run flag." });
      return { thread: asked.id, session };
    };
    hosts = { pi: ask("pi", "pi", "Pi"), omp: ask("omp", "pi", "Oh My Pi"), opencode: ask("oc", "opencode", "OpenCode") };
  }
  let guide: World["guide"];
  if (extra === "guide") {
    const client = new Client({ name: "inbox-dom-server", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
    const result = (await client.callTool({
      name: "submit_guide",
      arguments: { project_path: root, ...DOM_GUIDE, agent_session: `ses_g${i}`, agent_name: "Claude Code", agent_host: "claude-code" },
    })) as { isError?: boolean; content: { text: string }[]; structuredContent: { message_id: string; thread_id: string } };
    await client.close();
    if (result.isError) throw new Error(result.content[0]!.text);
    guide = { thread: result.structuredContent.thread_id, message: result.structuredContent.message_id };
  }
  let artifacts: World["artifacts"];
  if (extra === "artifacts") {
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f0005fe02fe0dd8a2c90000000049454e44ae426082",
      "hex",
    );
    mkdirSync(join(root, "design"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "design", "before.png"), png);
    writeFileSync(join(root, "design", "after.png"), png);
    writeFileSync(join(root, "docs", "spec.md"), "# Spec\n\nOne drawer.\n");
    writeFileSync(join(root, "traces.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0xff, 0xfe]));
    writeFileSync(join(root, "flow.sql"), "CREATE TABLE checkout_sessions (id uuid);\n");
    const client = new Client({ name: "inbox-dom-server", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
    const agentArgs = { project_path: root, agent_session: `ses_art${i}`, agent_name: "Claude Code", agent_host: "claude-code" };
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: { ...agentArgs, ...args } })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
      if (result.isError) throw new Error(result.content[0]!.text);
      return result.structuredContent;
    };
    const first = await call("send_message", { subject: "Checkout drawer", body: "Today:\n\n![Today](design/before.png)\n\nThe spec is attached.", attachments: ["docs/spec.md", "design/before.png"] });
    const firstId = (first.message?.id ?? first.message_id) as string;
    const base = `http://127.0.0.1:${server.port}`;
    const ss = server.serverSession;
    const upload = (await (await fetch(`${base}/api/inbox/uploads?name=sketch.png&serverSession=${ss}`, { method: "POST", body: png })).json()) as { upload: { upload_id: string } };
    const replied = await fetch(`${base}/api/inbox/messages/${firstId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: ss, idempotency_key: `art-${i}`, words: "Sketch attached.", uploads: [upload.upload.upload_id] }),
    });
    if (!replied.ok) throw new Error(`reply ${replied.status} ${await replied.text()}`);
    await call("send_message", { reply_to: firstId, body: "Built it:\n\n![After](design/after.png)", attachments: ["traces.zip"] });
    const guideSent = await call("submit_guide", { ...DOM_GUIDE, reply_to: firstId });
    await call("send_message", { reply_to: firstId, body: "The migration.", attachments: ["flow.sql"] });
    await client.close();
    const thread = store.thread(first.thread_id as string)!;
    const ids: Record<string, string> = {};
    for (const message of thread.messages) {
      for (const image of message.inline_images ?? []) ids[image.name] = image.id;
      for (const a of message.attachments ?? []) ids[ids[a.name] ? `${a.name} (attached)` : a.name] = a.id;
    }
    artifacts = { thread: first.thread_id as string, ids, guide: (guideSent.message?.id ?? guideSent.message_id) as string };
  }
  worlds.push({
    ...(artifacts ? { artifacts } : {}),
    ...(guide ? { guide } : {}),
    ...(htmlLinks ? { htmlLinks } : {}),
    ...(restart ? { restart } : {}),
    ...(hosts ? { hosts } : {}),
    ...(leakedIds[i] ? { leaked: leakedIds[i] } : {}),
    ...(openIn ? { openIn } : {}),
    ...(files ? { files } : {}),
    ...(sentMulti ? { sentMulti } : {}),
    ...(sentReply ? { sentReply } : {}),
    project: project.id,
    stopped: stopped.id,
    waiting: waiting.id,
    mixed: asking.id,
    update: update.id,
    same: same.id,
    sameUpdate: sameUpdate.id,
    picked: picked.id,
    pickedUpdate: pickedUpdate.id,
    filed: filed.id,
    attachment: attachments[0]!.id,
    news: withNews
      ? ["Search index built", "Install page links fixed", "Changelog drafted"].map(
          (body, n) => store.sendMessage({ project_id: project.id, author: { ...author, session: `ses_news${i}_${n}` }, body }).message.id,
        )
      : [],
  });
}
const tailnet = openInMode ? { listener: server.tailscale.listenerPort(), host: `macbook.tail0000.ts.net:${server.port}`, login: "ramos@example.com" } : undefined;
const tagWorld = extra === "tags" ? await seedTagWorld(`http://127.0.0.1:${server.port}`, server.token, join(projectsDir, "tags")) : null;
const tags = tagWorld ? { ids: tagWorld.ids, sessions: TAG_SESSIONS } : undefined;
process.stdout.write(`${JSON.stringify({ port: server.port, worlds, ...(tailnet ? { tailnet } : {}), ...(tags ? { tags } : {}) })}\n`);
/** The host a delivery is recorded under: the tag world's own sessions are not all Claude Code. */
function tagHost(session: string): string {
  if (session === TAG_SESSIONS.pi || session === TAG_SESSIONS.oldPi) return "pi";
  if (session === TAG_SESSIONS.opencode) return "opencode";
  return "claude-code";
}
// An agent writing while a test runs.
void (async () => {
  for await (const line of console) {
    const command = JSON.parse(line) as {
      send?: { project: string; session: string; body: string; reply_to?: string; supersedes?: string[]; host?: string };
      deliver?: { session: string };
      wait?: { thread: string; session: string };
      poll?: { session: string; body: Record<string, unknown> };
      first?: { root: string; session: string; body: string };
      card?: { project: string; session: string; title: string; say?: string; thread?: string };
    };
    if (command.first) {
      // An agent's first message: its folder becomes the Inbox's first project.
      mkdirSync(command.first.root, { recursive: true });
      const project = store.ensureProject({ name: command.first.root.split("/").pop()!, root: command.first.root });
      const sent = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: command.first.session, name: "Claude Code" }, body: command.first.body });
      process.stdout.write(`${JSON.stringify({ sent: sent.message.id, project: project.id })}\n`);
      continue;
    }
    if (command.poll) {
      // That session's connection polling now: it is live, with what it loaded. `commands` is what
      // the poll handed it (its wake: replies and messages the person sent it), never delivered here.
      const polled = await fetch(`http://127.0.0.1:${server.port}/api/inbox/bridge/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ session: command.poll.session, host: "claude-code", waitMs: 0, ...command.poll.body }),
      });
      process.stdout.write(`${JSON.stringify({ polled: true, commands: parseInboxBridgeCommands(await polled.text()) })}\n`);
      continue;
    }
    if (command.card) {
      // An agent making a card through the store (the card action's rules), linked to its thread.
      const made = store.createCard({
        project_id: command.card.project,
        by: { kind: "agent", host: "claude-code", session: command.card.session, name: "Claude Code" },
        title: command.card.title,
        say: command.card.say,
        threads: command.card.thread ? [command.card.thread] : [],
      });
      process.stdout.write(`${JSON.stringify({ carded: made.card.id })}\n`);
      continue;
    }
    if (command.wait) {
      const client = new Client({ name: "inbox-dom-server", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
      const result = (await client.callTool({ name: "wait_for_reply", arguments: { thread_id: command.wait.thread, agent_session: command.wait.session, timeout_seconds: 5 } })) as {
        structuredContent?: unknown;
      };
      await client.close();
      process.stdout.write(`${JSON.stringify({ waited: result.structuredContent ?? null })}\n`);
      continue;
    }
    if (command.deliver) {
      const ids = store.pendingReplies(command.deliver.session).map((reply) => store.recordDelivery(reply.id, { host: tagHost(command.deliver!.session), session: command.deliver!.session }).id);
      process.stdout.write(`${JSON.stringify({ delivered: ids })}\n`);
      continue;
    }
    if (!command.send) continue;
    const { project, session, body, reply_to, supersedes, host } = command.send;
    const sent = store.sendMessage({
      project_id: project,
      author: { kind: "agent", host: host ?? "claude-code", session, name: host === "codex" ? "Codex" : "Claude Code" },
      body,
      ...(reply_to ? { reply_to } : {}),
      ...(supersedes ? { supersedes } : {}),
    });
    process.stdout.write(`${JSON.stringify({ sent: sent.message.id })}\n`);
  }
})();
process.on("SIGTERM", () => {
  void tagWorld?.stop();
  server.stop();
  process.exit(0);
});
