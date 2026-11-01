/**
 * A real Inbox for the voice dictation spec, run from source as its own process, serving the built window. The
 * compiled binary can't be pointed at fake endpoints, on purpose: no environment variable moves them. So this script
 * passes the server's test option, with a fake `codex` on a scratch PATH (tests/helpers/fake-codex-app-server.ts) and a
 * fake of both OpenAI endpoints on loopback. No real Codex, no real `~/.codex`, no call to OpenAI.
 *
 *   bun tests/e2e/voice-inbox.ts <root> <JSON options>
 *
 * Prints one line `{ url, threads, filed, upstream }` and runs until told to stop. A JSON line on stdin is a command:
 *  - `{ "upstream": [{ status?, text?, html?, hold? }] }`: the next answers, the last repeating. `hold` waits for
 *    `{ "release": true }`.
 *  - `{ "codex": { ... } }`: the fake Codex's new state.
 *  - `{ "stop": true }`: stop the Inbox and exit.
 * Each post upstream adds a line to `<root>/upstream.jsonl`: its size, whether it is a WAV, its User-Agent. Each fake
 * Codex start is in `<root>/bin/calls.jsonl`.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentEnvironmentFor } from "../../packages/server/inbox-agents";
import { startInboxServer } from "../../packages/server/inbox";
import { recordInboxAttachments } from "../../packages/shared/inbox/attachments";
import { installFakeCodex, type FakeCodexState } from "../helpers/fake-codex-app-server";
import { refuseRealDataDir } from "../helpers/real-data-dir";

interface Answer {
  status?: number;
  text?: string;
  html?: boolean;
  hold?: boolean;
}

const [root, raw] = process.argv.slice(2);
if (!root || !raw) throw new Error("usage: voice-inbox.ts <root> <JSON options>");
const options = JSON.parse(raw) as { version?: string; codex?: FakeCodexState | null; html: string };
const dataDir = join(root, "data");
refuseRealDataDir(dataDir, "tests/e2e/voice-inbox.ts");
process.env.PLANNOTATOR_DATA_DIR = dataDir;

const home = join(root, "home");
mkdirSync(home, { recursive: true });

let answers: Answer[] = [{ text: "Rename the build step." }];
let release: (() => void) | null = null;
/** A release that came before the clip did: the spec can't see the post arrive. */
let released = false;
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const form = await req.formData();
    const file = form.get("file");
    const bytes = file instanceof File ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
    const riff = String.fromCharCode(...bytes.subarray(0, 4));
    const rate = bytes.length > 28 ? new DataView(bytes.buffer, bytes.byteOffset).getUint32(24, true) : 0;
    appendFileSync(join(root, "upstream.jsonl"), `${JSON.stringify({ path: new URL(req.url).pathname, bytes: bytes.length, riff, rate, model: form.get("model"), userAgent: req.headers.get("user-agent") })}\n`);
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (answer.hold && !released) await new Promise<void>((resolve) => (release = resolve));
    released = false;
    if (answer.html) return new Response("<html>Just a moment</html>", { status: answer.status ?? 403, headers: { "Content-Type": "text/html" } });
    return Response.json({ text: answer.text ?? "" }, { status: answer.status ?? 200 });
  },
});

const codex = options.codex === null ? null : installFakeCodex(root, options.codex ?? { account: { type: "chatgpt", email: "someone@example.com", planType: "pro" }, authMethod: "chatgpt", token: "fake-token", refreshedToken: "fake-token-2" });
const server = await startInboxServer({
  dataDir,
  version: options.version ?? "dev",
  binaryPath: null,
  phones: false,
  htmlContent: readFileSync(options.html, "utf8"),
  agentEnvironment: createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env: { HOME: home, PATH: codex ? `${codex.bin}:/usr/bin:/bin` : "/nowhere" } }),
  voice: { chatgptUrl: `http://127.0.0.1:${upstream.port}/backend-api/transcribe`, openaiUrl: `http://127.0.0.1:${upstream.port}/v1/audio/transcriptions`, extraClis: [] },
});

const store = server.store;
const project = store.ensureProject({ name: "billing", root: join(root, "billing") });
const threads: string[] = [];
for (let i = 0; i < 8; i++) {
  const author = { kind: "agent" as const, host: "claude-code", session: `ses_v${i}`, name: "Claude Code" };
  const sent = store.sendMessage({ project_id: project.id, author, subject: `Voice thread ${i}`, body: `Cards or a table for the invoices, take ${i}?` });
  threads.push(sent.message.thread_id);
}
writeFileSync(join(root, "shot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
const attachments = await recordInboxAttachments(store.dir, ["shot.png"], { base: root, at: new Date().toISOString() });
const filed = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: "ses_vf", name: "Claude Code" }, subject: "The screenshot", body: "The checkout, attached.", attachments }).message;

console.log(JSON.stringify({ url: server.url, threads, filed: { thread: filed.thread_id, attachment: filed.attachments?.[0]?.id ?? null } }));

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line) as { upstream?: Answer[]; release?: boolean; codex?: FakeCodexState; stop?: boolean };
    if (command.upstream) {
      answers = command.upstream;
      released = false;
    }
    if (command.release) {
      released = release === null;
      release?.();
      release = null;
    }
    if (command.codex) codex?.set(command.codex);
    if (command.stop) finish();
  }
});
process.stdin.on("end", finish);

function finish() {
  release?.();
  server.stop();
  upstream.stop(true);
  process.exit(0);
}
