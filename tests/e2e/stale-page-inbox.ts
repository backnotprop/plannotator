/**
 * A real Inbox for the stale page spec (inbox-stale-page-webkit.spec.ts), run from source as its own process. It
 * serves the built window (apps/hook/dist/inbox.html) and says it runs this repo's release (package.json), as a
 * release binary serves its own page: the compiled e2e binary is a `0.0.0-dev` build, which the notice skips.
 *
 *   bun tests/e2e/stale-page-inbox.ts <root>
 *
 * Prints one line `{ url, thread, version }` and runs until `{ "stop": true }` arrives on stdin (or stdin closes).
 * No agent, no update check, no phones: one project with one agent thread to reply to. The spec gives this process
 * PLANNOTATOR_TEST_SANDBOX, so the Inbox looks for no agent CLI.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startInboxServer } from "../../packages/server/inbox";
import { refuseRealDataDir } from "../helpers/real-data-dir";

const [root] = process.argv.slice(2);
if (!root) throw new Error("usage: stale-page-inbox.ts <root>");
const repo = resolve(import.meta.dir, "../..");
const dataDir = join(root, "data");
refuseRealDataDir(dataDir, "tests/e2e/stale-page-inbox.ts");
process.env.PLANNOTATOR_DATA_DIR = dataDir;
const home = join(root, "home");
mkdirSync(dataDir, { recursive: true });
mkdirSync(home, { recursive: true });

const version = (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }).version;
// Someone who used this release here already: no tour, no first-run asks, no What's new, no intro dialogs.
writeFileSync(join(dataDir, "update-state.json"), JSON.stringify({ inboxVersion: version }));
writeFileSync(
  join(dataDir, "config.json"),
  JSON.stringify({
    inboxTour: { version: 2, seen_at: "2026-10-01T10:00:00.000Z", skipped_at: "2026-10-01T10:00:00.000Z" },
    inboxNotifications: { dismissed: true },
    inboxAgentNotes: { offered: true },
    inboxSound: { dialogShownFor: version },
    inboxListIntro: { shownAt: "2026-10-01T10:00:00.000Z", version: 2 },
  }),
);

const server = await startInboxServer({
  dataDir,
  version,
  binaryPath: null,
  phones: false,
  htmlContent: readFileSync(join(repo, "apps/hook/dist/inbox.html"), "utf8"),
});

const store = server.store;
const project = store.ensureProject({ name: "billing", root: join(root, "billing") });
const author = { kind: "agent" as const, host: "claude-code", session: "ses_stale", name: "Claude Code" };
const sent = store.sendMessage({ project_id: project.id, author, subject: "Retry worker", body: "The retry worker is done. What next?" });

console.log(JSON.stringify({ url: server.url, thread: sent.message.thread_id, version }));

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.trim() && (JSON.parse(line) as { stop?: boolean }).stop) finish();
  }
});
process.stdin.on("end", finish);

function finish() {
  server.stop();
  process.exit(0);
}
