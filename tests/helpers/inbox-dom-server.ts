/**
 * A real Inbox server for the window's DOM tests, run as its own process:
 * under DOM_TESTS=1 happy-dom replaces the test process's Response, which
 * Bun.serve cannot answer with, so the server lives here instead.
 *
 *   bun tests/helpers/inbox-dom-server.ts <data dir> <projects dir> <count> [news | header-files]
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
 * The set-aside note's delay is a minute, so no note is written while a test
 * runs.
 *
 * With a fourth argument `header-files`, each project also gets a thread one
 * session writes three messages in: three files (one changed on disk after it
 * was sent), then none, then one; the world adds `files` (`{ thread, first,
 * middle, last, ids: { <name>: <attachment id> } }`). Without it the seed is
 * exactly as before. With `phones` instead, the Inbox serves phones (see
 * `machine.json` below); the seed is the same.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startInboxServer } from "../../packages/server/inbox";
import { recordInboxAttachments } from "../../packages/shared/inbox/attachments";
import { refuseRealDataDir } from "./real-data-dir";

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
const server = await startInboxServer({
  dataDir,
  setAsideDelayMs: 60_000,
  phones: phonesMode,
  ...(phonesMode ? { tailscale, pairingProbes } : {}),
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
  news: string[];
};
const worlds: World[] = [];
for (let i = 0; i < count; i++) {
  const root = join(projectsDir, `billing-${i}`);
  mkdirSync(root, { recursive: true });
  const project = store.ensureProject({ name: `billing-${i}`, root });
  const author = { kind: "agent" as const, host: "claude-code", session: `ses_a${i}`, name: "Claude Code" };
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
  worlds.push({
    ...(files ? { files } : {}),
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
process.stdout.write(`${JSON.stringify({ port: server.port, worlds })}\n`);
// An agent writing while a test runs.
void (async () => {
  for await (const line of console) {
    const command = JSON.parse(line) as { send?: { project: string; session: string; body: string; reply_to?: string } };
    if (!command.send) continue;
    const { project, session, body, reply_to } = command.send;
    const sent = store.sendMessage({ project_id: project, author: { kind: "agent", host: "claude-code", session, name: "Claude Code" }, body, ...(reply_to ? { reply_to } : {}) });
    process.stdout.write(`${JSON.stringify({ sent: sent.message.id })}\n`);
  }
})();
process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
