/**
 * A very long Inbox thread written straight through the store, for
 * read_thread size checks: `rounds` agent messages, each answered by the
 * person, then three agent messages whose nine questions stay open. Every
 * tenth agent message asks two questions with choices, every fiftieth carries
 * an html block, some replies carry a 6 KB skills block, and some rounds are
 * a Re-ask note. The store must be one the caller opened in a scratch dir.
 */
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export const BIG_THREAD_AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_big", name: null };

const PROSE =
  "I went through the retry worker again. The queue drains in order, the dead-letter path is wired, and the metrics land in the dashboard. " +
  "Everything else in this step is done and pushed to the branch.";

const BIG_THREAD_SKILL_LINE = "Write every release note as one plain sentence a person reads in five seconds.";

export function bigThreadSkillsBlock(name: string): string {
  return [
    "**Skills referenced** (the person is asking you to invoke these skills when acting on this reply):",
    `- \`${name}\` (cannot be invoked by a model; its instructions are included below at the person's request)`,
    "",
    `--- BEGIN SKILL INSTRUCTIONS: ${name} ---`,
    "This skill cannot be invoked by a model, so its instructions are included here at the person's request. Follow them when acting on this reply.",
    `Skill directory: /work/skills/${name}`,
    "",
    ...Array.from({ length: 75 }, () => BIG_THREAD_SKILL_LINE),
    `--- END SKILL INSTRUCTIONS: ${name} ---`,
  ].join("\n");
}

const questionBlock = (round: number, n: number, replaces?: string) =>
  [":::question", `Round ${round}, ${n}: which backoff should the worker use for this queue?`, ...(replaces ? ["", `Replaces: ${replaces}`] : []), "", "- [ ] Exponential, capped at 30 s", "- [ ] Fixed 5 s", "- [ ] No retry at all", ":::"].join("\n");

const html = (round: number) => ["```html", `<section><h2>Round ${round}</h2>`, ...Array.from({ length: 40 }, (_, i) => `<p class="row">Row ${i}: the queue drained in order.</p>`), "</section>", "```"].join("\n");

export function seedBigThread(store: InboxStore, rounds = 247, root = "/work/api"): { threadId: string; ids: string[]; skillReplies: string[]; reaskNotes: string[] } {
  const project = store.ensureProject({ name: "api", root });
  const ids: string[] = [];
  const skillReplies: string[] = [];
  const reaskNotes: string[] = [];
  let last: string | null = null;
  let threadId = "";
  const send = (body: string) => {
    const sent = store.sendMessage({ project_id: project.id, author: BIG_THREAD_AGENT, body, ...(last ? { reply_to: last } : { subject: "The retry worker" }) });
    threadId = sent.message.thread_id;
    last = sent.message.id;
    ids.push(last);
    return { id: last!, questions: store.questionsOf(last!) ?? [] };
  };
  for (let round = 1; round <= rounds; round++) {
    const asks = round % 10 === 0;
    const sent = send([`Step ${round}: ${PROSE}`, ...(round % 50 === 0 ? ["", html(round)] : []), ...(asks ? ["", questionBlock(round, 1), "", questionBlock(round, 2)] : [])].join("\n"));
    if (asks && round % 30 === 0) {
      const note = store.sendReask(sent.id, { idempotency_key: `reask-${round}` }).reply;
      ids.push(note.id);
      reaskNotes.push(note.id);
      last = note.id;
      send([`Asked again: ${PROSE}`, "", ...sent.questions.flatMap((q, i) => [questionBlock(round, i + 1, `${sent.id}/${q.key}`), ""])].join("\n"));
      const again = store.questionsOf(last!) ?? [];
      const reply = store.sendReply(last!, { idempotency_key: `r-${round}`, words: `Round ${round}: go ahead.`, questions: again.map((q) => ({ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Fixed 5 s"] } })) }).reply;
      ids.push(reply.id);
      last = reply.id;
      continue;
    }
    const skills = round % 20 === 5;
    const reply = store.sendReply(last!, {
      idempotency_key: `r-${round}`,
      words: `Round ${round}: go ahead, and keep the dashboard as it is.`,
      questions: sent.questions.map((q) => ({ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Exponential, capped at 30 s"] } })),
      ...(skills ? { feedback: bigThreadSkillsBlock(`release-notes-${round}`) } : {}),
    }).reply;
    ids.push(reply.id);
    if (skills) skillReplies.push(reply.id);
    last = reply.id;
  }
  for (let i = 0; i < 3; i++) send([`Open step ${i}: ${PROSE}`, "", questionBlock(900 + i, 1), "", questionBlock(900 + i, 2), "", questionBlock(900 + i, 3)].join("\n"));
  return { threadId, ids, skillReplies, reaskNotes };
}
