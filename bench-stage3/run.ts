// Scratch bench (stage 3, PR 3): one fresh process times the store's whole-list read after each of N agent messages.
//   bun run.ts <tree> <data dir> <jsonl | sqlite> <presence: on | off> <writes>
// Prints one JSON line. Each write is an agent's message in an existing thread (a different thread each time);
// the list read after it is `store.listRows()`, what the server's list route and every window read start from.
const [tree, dataDir, logName, presenceMode, writesArg] = process.argv.slice(2) as [string, string, string, string, string];
const writes = Number(writesArg ?? 20);
const { InboxStore } = await import(`${tree}/packages/shared/inbox/store.ts`);
const { jsonlInboxLog } = await import(`${tree}/packages/shared/inbox/store-log/jsonl-log.ts`);
const { sqliteInboxLog } = await import(`${tree}/packages/shared/inbox/store-log/sqlite/sqlite-log.ts`);
const { inboxListSections } = await import(`${tree}/packages/shared/inbox/list.ts`);

const ms = (t: number) => +(performance.now() - t).toFixed(2);
let t = performance.now();
const store = InboxStore.open(dataDir, { log: logName === "sqlite" ? sqliteInboxLog : jsonlInboxLog });
const startMs = ms(t);
if (presenceMode === "on") {
  // The server's live sessions, as a view read on demand: two of the three sessions poll, one is busy.
  const live = new Set(["ses_world_a", "ses_world_b"]);
  store.setDeliveryPresence({
    connection: (session: string) => (live.has(session) ? { busy: session === "ses_world_b", send_now: session === "ses_world_b" } : null),
    askerLive: (session: string) => live.has(session),
    hostOf: (session: string) => (live.has(session) ? "claude-code" : null),
    launchResumes: () => false,
    uncertain: () => false,
    stuck: () => false,
    autoSendAfterMs: 60_000,
    waitOf: (session: string) => (session === "ses_world_b" ? { since: "2026-10-01T09:00:00.000Z", autoSince: null } : null),
  });
}
const threads: string[] = store.threadIds();
t = performance.now();
const coldRows = store.listRows().length;
const coldMs = ms(t);
t = performance.now();
store.listRows();
const unchangedMs = ms(t);

const author = { kind: "agent" as const, host: "claude-code", session: "ses_world_a", name: "Claude Code" };
const after: number[] = [];
const writeMs: number[] = [];
for (let i = 0, k = 0; i < writes && k < writes * 5; k++) {
  const root = threads[(k * 7919 + 13) % threads.length]!;
  const message = store.message(root);
  if (!message) continue;
  t = performance.now();
  try {
    store.sendMessage({ project_id: message.project_id, author, body: `Bench note ${k}: the worker drained the queue.`, reply_to: root });
  } catch {
    continue;
  }
  writeMs.push(ms(t));
  t = performance.now();
  store.listRows();
  after.push(ms(t));
  i++;
}
// What the server's list route still does over every row per read, besides the store (not changed by PR 3): the
// sections (a filter and a sort per section), and each row's JSON (the `since` delta hashes every row).
const sections: number[] = [];
const json: number[] = [];
for (let i = 0; i < 5; i++) {
  const rows = store.listRows();
  t = performance.now();
  inboxListSections(rows);
  sections.push(ms(t));
  t = performance.now();
  for (const row of rows) JSON.stringify(row);
  json.push(ms(t));
}
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const q = (xs: number[], p: number) => sorted(xs)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
console.log(
  JSON.stringify({
    tree: process.env.TREE_NAME ?? tree,
    log: logName,
    presence: presenceMode,
    threads: threads.length,
    rows: coldRows,
    start_ms: startMs,
    list_cold_ms: coldMs,
    list_unchanged_ms: unchangedMs,
    write_median_ms: q(writeMs, 0.5),
    sections_ms: q(sections, 0.5),
    rows_json_ms: q(json, 0.5),
    list_after_write: { n: after.length, median: q(after, 0.5), p10: q(after, 0.1), p90: q(after, 0.9), min: sorted(after)[0], max: sorted(after).at(-1) },
  }),
);
process.exit(0);
