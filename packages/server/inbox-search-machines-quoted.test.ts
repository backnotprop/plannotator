/**
 * A quoted phrase across linked machines (inbox-search-machines.ts), without a running Inbox: this machine's answer
 * and each linked machine's come from real indexes over temp stores, the forward stubbed. The quoted query travels
 * as typed; a machine that knows quotes applies the phrase; an older one, which reads a quote mark as punctuation,
 * still answers its word matches and nothing fails.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxSearchIndex, type InboxSearchAnswer } from "@plannotator/shared/inbox/search";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { searchAcrossMachines, type InboxSearchMachines } from "./inbox-search-machines";

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_q", name: null };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

let clock = Date.parse("2026-10-01T10:00:00Z");
async function machine(name: string, bodies: string[]) {
  const dir = mkdtempSync(join(tmpdir(), `plannotator-search-quoted-${name}-`));
  roots.push(dir);
  const store = InboxStore.open(dir, { now: () => new Date((clock += 60_000)) });
  const project = store.ensureProject({ name, root: `/w/${name}` });
  const ids = bodies.map((body, i) => store.sendMessage({ project_id: project.id, author: AGENT, subject: "Notes", thread: `t${i}`, body }).message.id);
  const index = new InboxSearchIndex(store);
  await index.ensureBuilt();
  const answer = (url: URL, older = false) => {
    const q = url.searchParams.get("q") ?? "";
    // An Inbox from before quotes: a quote mark was punctuation, so the same words with none.
    const answer = index.search({ q: older ? q.replace(/["“”]/g, "") : q, sort: (url.searchParams.get("sort") as "newest" | null) ?? null });
    return { serverSession: name, ...answer };
  };
  return { ids, answer };
}

const BODIES = ["Open the file viewer now.", "The file is big; the viewer is slow."];

test("a quoted query travels as typed; a machine that knows quotes applies the phrase, an older one answers its word matches", async () => {
  const here = await machine("harbor", BODIES);
  const newer = await machine("fern-api", BODIES);
  const older = await machine("ledger", BODIES);
  const asked: string[] = [];
  const machines: InboxSearchMachines = {
    linked: () => [
      { id: "newer", name: "Newer", online: true },
      { id: "older", name: "Older", online: true },
    ],
    projectOwner: () => null,
    forward: async (_req, url) => {
      asked.push(url.searchParams.get("q") ?? "");
      const body: InboxSearchAnswer = url.pathname.includes("/m/newer/") ? newer.answer(url) : older.answer(url, true);
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    },
  };
  for (const sort of ["best", "newest"]) {
    asked.length = 0;
    const url = new URL(`http://127.0.0.1/api/inbox/search?machines=1&sort=${sort}&q=${encodeURIComponent('"file viewer"')}`);
    const answer = await searchAcrossMachines({ req: new Request(url), url, machines, serverSession: "here", waitMs: 2_000, hasProject: () => true, answerOf: async (u) => here.answer(u) });
    expect(asked).toEqual(['"file viewer"', '"file viewer"']);
    expect(answer.unanswered).toBeUndefined();
    const ids = (answer.groups?.messages ?? []).map((row) => row.id).sort();
    // Here and the newer machine: the phrase only. The older machine: both of its messages, as it always answered.
    expect(ids).toEqual([here.ids[0]!, newer.ids[0]!, older.ids[0]!, older.ids[1]!].sort());
    expect(answer.totals?.messages).toBe(4);
    expect(answer.terms).toEqual(['"file viewer"']);
  }
});
