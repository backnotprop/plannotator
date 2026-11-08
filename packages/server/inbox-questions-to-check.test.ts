/**
 * send_message on a question that likely does not ask what the agent meant:
 * its first line reads as a `key: value` field (an agent whose history was
 * compacted put `id: sd-approach` first, so the person saw that as the
 * question), or a pick-one block has no choices. The result says so and how
 * to send it again in place of this one. Advice only: the message is sent.
 *
 * What regresses if this fails: the agent never hears it and the person
 * gets a question titled "id: sd-approach"; or the line nags a real
 * question that starts with a word and a colon; or it names ids the resend
 * is refused with.
 *
 * A real store in a temp data dir, driven through sendAgentMessage (the
 * send path send_message runs); no Inbox server, no network.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxQuestionsToCheck, parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { questionsToCheckText } from "@plannotator/shared/inbox/questions-to-check";
import { sendAgentMessage, type InboxMcpContext } from "./inbox-mcp";

const roots: string[] = [];
let savedDataDir: string | undefined;

beforeEach(() => {
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

const CHOICES = ["", "- [ ] Rewrite the sync layer", "- [ ] Patch the conflict path", "", "Recommended: Patch the conflict path"];
const block = (kind: string, ...lines: string[]) => [`:::${kind}`, ...lines, ":::"].join("\n");

test("a question line that reads as `key: value` is named with what it reads as", () => {
  for (const first of ["id: sd-approach", "key: approach-1", "question_id:sd_approach", "ref: #42"]) {
    const found = inboxQuestionsToCheck(block("question", first, "Which approach do we take?", ...CHOICES));
    expect(found).toEqual([{ key: expect.stringMatching(/^q-/), position: 1, reads_as: first }]);
  }
});

test("a real question is never named: words after the colon, capitals, a link, or an id line after the question", () => {
  for (const first of ["Deploy: should we wait for the fix?", "Approach: rewrite or patch?", "ID: sd-approach", "Which approach: rewrite or patch?", "https://example.com/pr/42", "Rewrite or patch?"]) {
    expect(inboxQuestionsToCheck(block("question", first, ...CHOICES))).toEqual([]);
  }
  // A later `id:` line is no no-op the parser drops: the card shows it as context, under the real question.
  const later = block("question", "Which approach do we take?", "id: sd-approach", ...CHOICES);
  expect(inboxQuestionsToCheck(later)).toEqual([]);
  const [parsed] = parseInboxQuestionBlocks(later);
  expect(parsed!.prompt).toBe("Which approach do we take?");
  expect(parsed!.parsed.context).toContain("id: sd-approach");
});

test("a pick-one or pick-several block with no choices is named; free text and plain-bullet choices are not", () => {
  expect(inboxQuestionsToCheck(block("question", "Which approach do we take?", "", "Rewrite or patch, your call."))).toEqual([
    { key: expect.stringMatching(/^q-/), position: 1, no_choices: ":::question" },
  ]);
  expect(inboxQuestionsToCheck(block("question-multi", "Which platforms?"))).toEqual([{ key: expect.stringMatching(/^q-/), position: 1, no_choices: ":::question-multi" }]);
  expect(inboxQuestionsToCheck(block("question-text", "What should the empty state say?"))).toEqual([]);
  expect(inboxQuestionsToCheck(block("question", "Which approach?", "", "- Rewrite", "- Patch"))).toEqual([]);
  // The position counts the questions as written.
  const two = [block("question", "Which approach do we take?", ...CHOICES), "", block("question", "id: sd-db", "Which database?", ...CHOICES)].join("\n");
  expect(inboxQuestionsToCheck(two).map((q) => q.position)).toEqual([2]);
});

test("the sent result names the question and this message, and the resend it asks for is taken with no advice", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-questions-to-check-")));
  roots.push(root);
  process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "app", root: join(root, "app") });
  const context = { store, baseUrl: () => "http://localhost:1/" } as unknown as InboxMcpContext;

  const first = await sendAgentMessage(context, project, { body: block("question", "id: sd-approach", "Which approach do we take?", ...CHOICES), agent_host: "claude-code", agent_session: "ses_a" });
  const messageId = String(first.structured.message_id);
  const key = (first.structured.questions as { key: string }[])[0]!.key;
  expect(first.structured.questions_to_check).toEqual([{ key, position: 1, reads_as: "id: sd-approach" }]);
  const text = questionsToCheckText(messageId, first.questionsToCheck);
  expect(text).toContain('Question 1 reads as "id: sd-approach"');
  expect(text).toContain(`reply_to "${messageId}" and supersedes "${messageId}/${key}"`);

  const again = await sendAgentMessage(context, project, {
    body: block("question", "Which approach do we take?", ...CHOICES),
    reply_to: messageId,
    supersedes: [`${messageId}/${key}`],
    agent_host: "claude-code",
    agent_session: "ses_a",
  });
  expect(again.structured.thread_id).toBe(first.structured.thread_id);
  expect(again.structured.superseded).toEqual([`${messageId}/${key}`]);
  expect(again.structured.questions_to_check).toBeUndefined();
  expect(questionsToCheckText(String(again.structured.message_id), again.questionsToCheck)).toBe("");
});
