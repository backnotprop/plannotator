/**
 * A trial Inbox for the live-drawing prototype, run from source beside the
 * person's own Inbox and never touching it: its own scratch data dir, its
 * own port, its own scratch HOME. Start it through the wrapper, which sets
 * that environment before the process starts:
 *
 *   sh scripts/live-drawing-trial.sh
 *
 * It prints the window's address and the command that starts a Claude Code
 * session on this checkout's mod, pointed at this Inbox. Runs until Ctrl-C.
 * Needs the window built once: `bun run --cwd apps/inbox build`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { refuseRealHome } from "../tests/helpers/inbox-process";
import { refuseRealDataDir } from "../tests/helpers/real-data-dir";

const dataDir = refuseRealDataDir(process.env.PLANNOTATOR_DATA_DIR, "live-drawing-trial");
refuseRealHome(process.env.HOME, "live-drawing-trial");
// The Inbox reads config.json through the env even when given dataDir.
process.env.PLANNOTATOR_DATA_DIR = dataDir;

const root = resolve(import.meta.dir, "..");
const page = join(root, "apps/inbox/dist/index.html");
if (!existsSync(page)) {
  console.error("The window is not built yet. Run: bun run --cwd apps/inbox build");
  process.exit(1);
}

const { startInboxServer } = await import("../packages/server/inbox");
const server = await startInboxServer({ dataDir, htmlContent: readFileSync(page, "utf8") });

console.log(`
Trial Inbox: http://127.0.0.1:${server.port}/

In another terminal, in any project folder, start Claude Code on this build:

  PLANNOTATOR_DATA_DIR=${dataDir} CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1 claude --plugin-dir ${join(root, "apps/hook")}

Then ask it, for example:

  Send me a short hello in the Plannotator Inbox. Then reply in that same thread with an SVG diagram of how a web request travels from a browser to a database and back.

Open the first message's thread in the trial Inbox window and watch the reply being drawn.
Ctrl-C stops this Inbox. Your own Inbox is not involved.
`);

const stop = () => {
  server.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
