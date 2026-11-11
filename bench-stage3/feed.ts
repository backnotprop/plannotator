// Scratch bench (stage 3, PR 5): per agent message, what the server spends and sends for one window.
//   bun feed.ts <tree> <data dir (a copy, used up)> <jsonl | sqlite> <before | after> <events>
// A real Inbox on the data dir (SQLite: the files moved on start, the real path). Per event (an agent message in an
// existing thread): today's list read the window makes after it (`?archived=exclude&snoozed=exclude&machines=1&since=`,
// the delta, #2593) — time and bytes; on `after` also the `list` frame on a `list=1` stream — time from the write to
// the frame, and bytes. Every 5th event also the phone's whole list read. Prints one JSON line.
import { join } from "node:path";

const [tree, dataDir, logName, mode, eventsArg] = process.argv.slice(2) as [string, string, string, string, string];
const events = Number(eventsArg ?? 20);
process.env.PLANNOTATOR_DATA_DIR = dataDir;
// Run with HOME set to a scratch folder (the sandboxed Inbox refuses the real home).
process.env.PLANNOTATOR_TEST_SANDBOX = "1";
process.env.PLANNOTATOR_BROWSER = "";
const { startInboxServer } = await import(join(tree, "packages/server/inbox.ts"));
const t0 = performance.now();
const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: () => ({ status: 1, stdout: "", stderr: "no" }), sqlite: logName === "sqlite" });
const startMs = performance.now() - t0;
const base = `http://127.0.0.1:${server.port}`;
const WINDOW = "/api/inbox/threads?archived=exclude&snoozed=exclude&machines=1";
const get = async (path: string) => {
  const t = performance.now();
  const response = await fetch(`${base}${path}`, { headers: { "Sec-Fetch-Site": "same-origin" } });
  const text = await response.text();
  return { ms: performance.now() - t, bytes: Buffer.byteLength(text), json: JSON.parse(text) };
};
// Warm: the first reads build what later reads keep.
const first = await get(WINDOW);
let version: string = first.json.list_version ?? "";
const firstFull = await get("/api/inbox/threads");
const threads: string[] = server.store.threadIds();

// The feed's reader (after only): frames by thread, with when they came and their size.
const frames: { at: number; bytes: number; ids: string[] }[] = [];
let abort: AbortController | null = null;
if (mode === "after") {
  abort = new AbortController();
  const response = await fetch(`${base}/api/inbox/events?list=1&machines=1`, { headers: { "Sec-Fetch-Site": "same-origin" }, signal: abort.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!block.includes("event: list")) continue;
          const data = block.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
          frames.push({ at: performance.now(), bytes: Buffer.byteLength(block) + 2, ids: (JSON.parse(data).changes as { thread_id: string }[]).map((c) => c.thread_id) });
        }
      }
    } catch {
      // Aborted.
    }
  })();
  await get(`/api/inbox/threads?page=1&machines=1`);
  await Bun.sleep(200);
}

const author = { kind: "agent" as const, host: "claude-code", session: "ses_world_a", name: "Claude Code" };
const out = { frame_ms: [] as number[], frame_bytes: [] as number[], since_ms: [] as number[], since_bytes: [] as number[], full_ms: [] as number[], full_bytes: [] as number[] };
for (let i = 0, k = 0; i < events && k < events * 5; k++) {
  const root = threads[(k * 7919 + 13) % threads.length]!;
  const message = server.store.message(root);
  if (!message) continue;
  const seen = frames.length;
  const t = performance.now();
  try {
    server.store.sendMessage({ project_id: message.project_id, author, body: `Bench note ${k}: the worker drained the queue.`, reply_to: root });
  } catch {
    continue;
  }
  i++;
  if (mode === "after") {
    for (let w = 0; w < 2000 && !frames.slice(seen).some((f) => f.ids.includes(root)); w++) await Bun.sleep(1);
    const frame = frames.slice(seen).find((f) => f.ids.includes(root));
    if (frame) {
      out.frame_ms.push(frame.at - t);
      out.frame_bytes.push(frames.slice(seen).reduce((sum, f) => sum + f.bytes, 0));
    }
  }
  const since = await get(`${WINDOW}&since=${encodeURIComponent(version)}`);
  version = since.json.list_version;
  out.since_ms.push(since.ms);
  out.since_bytes.push(since.bytes);
  if (i % 5 === 0) {
    const full = await get("/api/inbox/threads");
    out.full_ms.push(full.ms);
    out.full_bytes.push(full.bytes);
  }
}
abort?.abort();
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const stat = (xs: number[]) => (xs.length === 0 ? null : { n: xs.length, median: +sorted(xs)[Math.floor(xs.length / 2)]!.toFixed(2), p90: +sorted(xs)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))]!.toFixed(2), max: +sorted(xs).at(-1)!.toFixed(2) });
console.log(
  JSON.stringify({
    tree: process.env.TREE_NAME ?? tree,
    log: logName,
    threads: threads.length,
    start_ms: Math.round(startMs),
    first_window_read: { ms: +first.ms.toFixed(1), bytes: first.bytes },
    first_full_read: { ms: +firstFull.ms.toFixed(1), bytes: firstFull.bytes },
    frame_ms: stat(out.frame_ms),
    frame_bytes: stat(out.frame_bytes),
    since_read_ms: stat(out.since_ms),
    since_read_bytes: stat(out.since_bytes),
    full_read_ms: stat(out.full_ms),
    full_read_bytes: stat(out.full_bytes),
  }),
);
server.stop();
process.exit(0);
