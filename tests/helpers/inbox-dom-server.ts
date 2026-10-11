/**
 * A real Inbox server for the window's DOM tests, run as its own process:
 * under DOM_TESTS=1 happy-dom replaces the test process's Response, which
 * Bun.serve cannot answer with, so the server lives here instead.
 *
 *   bun tests/helpers/inbox-dom-server.ts <data dir> <projects dir> <count>
 *
 * Seeds `count` projects (one per test, since the window keeps the first
 * server session it saw), each with a thread an agent is stopped on (two
 * questions), one waiting on a single question, and one two sessions write
 * in (A asks, B posts a later update), and one with a file attached, prints one JSON line
 * `{ port, worlds: [{ project, stopped, waiting, mixed, update, filed, attachment }] }`, and runs until killed.
 * The set-aside note's delay is a minute, so no note is written while a test
 * runs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startInboxServer } from "../../packages/server/inbox";
import { recordInboxAttachments } from "../../packages/shared/inbox/attachments";

const [dataDir, projectsDir, countArg] = process.argv.slice(2);
const count = Number(countArg ?? "1");
if (!dataDir || !projectsDir || !Number.isInteger(count) || count < 1) {
  process.stderr.write("usage: inbox-dom-server.ts <data dir> <projects dir> <count>\n");
  process.exit(2);
}

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

const server = await startInboxServer({ dataDir, setAsideDelayMs: 60_000, phones: false });
const store = server.store;
const worlds: { project: string; stopped: string; waiting: string; mixed: string; update: string; filed: string; attachment: string }[] = [];
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
  // A thread with a file attached, for the keys that stand down in the file viewer.
  writeFileSync(join(root, "notes.md"), "# Notes\n\nThe plan, in short.\n");
  const attachments = await recordInboxAttachments(store.dir, ["notes.md"], { base: root, at: new Date().toISOString() });
  const filed = store.sendMessage({ project_id: project.id, author: { ...author, session: `ses_f${i}` }, body: WAITING.replace("docs site", "notes"), attachments }).message;
  worlds.push({ project: project.id, stopped: stopped.id, waiting: waiting.id, mixed: asking.id, update: update.id, filed: filed.id, attachment: attachments[0]!.id });
}
process.stdout.write(`${JSON.stringify({ port: server.port, worlds })}\n`);
process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
