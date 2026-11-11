// Scratch bench (stage 3, PR 3): build one Inbox shape as a JSONL data dir and the same lines as a SQLite data dir.
//   bun make.ts <tree> <shape: 10k | long | wide> <out dir>
// 10k and wide: the budget test's copy method (a generated world copied with fresh ids): about 3.3 messages a thread,
// so wide (100k messages) is ~30,000 threads. long: 300 threads of 33 messages through the store, copied 10 times:
// 3,000 threads, ~100k messages (the live verifier's shape).
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [tree, shape, out] = process.argv.slice(2) as [string, string, string];
const { writeInboxWorld } = await import(`${tree}/packages/shared/inbox/store-log/world.ts`);
const { jsonlInboxLog } = await import(`${tree}/packages/shared/inbox/store-log/jsonl-log.ts`);
const { sqliteInboxLog } = await import(`${tree}/packages/shared/inbox/store-log/sqlite/sqlite-log.ts`);
const { InboxStore } = await import(`${tree}/packages/shared/inbox/store.ts`);

const ID = /\b((?:msg|crd|stp|att|ann)_[0-9A-HJKMNP-TV-Z]{26})\b/g;
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function copiedLines(lines: any[], copies: number): any[] {
  const top = Math.max(...lines.map((l) => l.seq));
  const result: any[] = lines.filter((l) => l.kind === "project" || l.kind === "initiative");
  const rest = lines.filter((l) => l.kind !== "project" && l.kind !== "initiative");
  for (let c = 0; c < copies; c++) {
    const tag = B32[1 + (c >> 5)]! + B32[c & 31]!;
    for (const line of rest) {
      const text = c === 0 ? JSON.stringify(line) : JSON.stringify(line).replace(ID, (id: string) => `${id.slice(0, 4)}${tag}${id.slice(6)}`);
      result.push({ ...JSON.parse(text), seq: line.seq + c * top });
    }
  }
  return result.sort((a, b) => a.seq - b.seq);
}

const seedDir = mkdtempSync(join(tmpdir(), "stage3-seed-"));
let copies: number;
if (shape === "long") {
  let clock = Date.parse("2026-10-01T09:00:00.000Z");
  const store = InboxStore.open(seedDir, { now: () => new Date((clock += 1000)) });
  const projects = ["web", "api", "billing"].map((name) => store.ensureProject({ name, root: `/work/${name}` }));
  const agents = ["ses_world_a", "ses_world_b", "ses_world_c"].map((session, i) => ({ kind: "agent" as const, host: ["claude-code", "codex", "pi"][i]!, session, name: null }));
  for (let t = 0; t < 300; t++) {
    const agent = agents[t % 3]!;
    const project = projects[t % 3]!;
    const root = store.sendMessage({ project_id: project.id, author: agent, body: `## Plan ${t}\n\nThe migration for the billing worker.\n\n:::question\nShip it (${t})?\n- [ ] Yes\n- [ ] No\n:::`, subject: `Thread ${t}`, wakes: t % 3 === 0 });
    let last = root.message.id;
    for (let m = 1; m < 33; m++) {
      if (m % 2 === 1) {
        const q = store.questionsOf(last).find((x: any) => x.state === "open");
        store.sendReply(last, { words: `Reply ${m}`, questions: [], idempotency_key: `r-${t}-${m}` });
        void q;
      } else {
        last = store.sendMessage({ project_id: project.id, author: agent, body: `Step ${m} of thread ${t}: the queue drained.${m === 32 && t % 4 === 0 ? "\n\n:::question\nMerge now?\n- [ ] Yes\n- [ ] Later\n:::" : ""}`, reply_to: root.message.id }).message.id;
      }
    }
    if (t % 5 === 0) store.resolveThread(root.message.id, true, "person");
    else if (t % 3 === 1) store.markSeen(root.message.id);
  }
  copies = 10;
} else {
  const target = shape === "wide" ? 100_000 : 10_000;
  writeInboxWorld({ dataDir: seedDir, seed: 11, steps: Number.POSITIVE_INFINITY, messages: 5_000, growOnly: true });
  const perCopy = new Set(jsonlInboxLog(join(seedDir, "inbox")).read().lines.flatMap((l: any) => (l.kind === "message" ? [l.id] : []))).size;
  copies = Math.ceil(target / perCopy);
}
const lines = copiedLines(jsonlInboxLog(join(seedDir, "inbox")).read().lines, copies);
for (const [name, factory] of [["jsonl", jsonlInboxLog], ["sqlite", sqliteInboxLog]] as const) {
  const dataDir = join(out, name);
  mkdirSync(dataDir, { recursive: true });
  const log = factory(join(dataDir, "inbox"));
  const projects = new Map<string, any>();
  for (const line of lines) {
    if (line.kind === "project") {
      if (!projects.has(line.id)) log.createProject(line.record, line);
      else log.append(line, line.record);
      projects.set(line.id, line.record);
      continue;
    }
    log.append(line, line.kind === "initiative" ? null : projects.get(line.record.project_id));
  }
  (log as { close?: () => void }).close?.();
}
const messages = lines.filter((l) => l.kind === "message").length;
console.log(JSON.stringify({ shape, lines: lines.length, messages, copies }));
