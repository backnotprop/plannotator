import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxQuestionsToCheck } from "@plannotator/core/inbox-questions";
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

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-questions-to-check-")));
  roots.push(root);
  process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "app", root: join(root, "app") });
  const context = { store, baseUrl: () => "http://localhost:1/" } as unknown as InboxMcpContext;
  return { store, project, context };
}

test("a pick-one or pick-several block with no choices is named; free text, plain-bullet choices and an id label are not", () => {
  expect(inboxQuestionsToCheck(block("question", "Which approach do we take?", "", "Rewrite or patch, your call."))).toEqual([
    { key: expect.stringMatching(/^q-/), position: 1, no_choices: ":::question" },
  ]);
  expect(inboxQuestionsToCheck(block("question-multi", "Which platforms?"))).toEqual([{ key: expect.stringMatching(/^q-/), position: 1, no_choices: ":::question-multi" }]);
  expect(inboxQuestionsToCheck(block("question-text", "What should the empty state say?"))).toEqual([]);
  expect(inboxQuestionsToCheck(block("question", "Which approach?", "", "- Rewrite", "- Patch"))).toEqual([]);
  expect(inboxQuestionsToCheck(block("question", "id: sd-approach", "Which approach do we take?", ...CHOICES))).toEqual([]);
  const two = [block("question", "Which approach do we take?", ...CHOICES), "", block("question", "Which database?")].join("\n");
  expect(inboxQuestionsToCheck(two).map((q) => q.position)).toEqual([2]);
});

test("sent with an id label first: the stored question is the real one, keyed as before, and no advice", async () => {
  const { context, project } = world();
  const labelled = await sendAgentMessage(context, project, { body: block("question", "id: sd-approach", "Which approach do we take?", ...CHOICES), agent_host: "claude-code", agent_session: "ses_a" });
  const [question] = labelled.structured.questions as { key: string; prompt: string }[];
  expect(question!.prompt).toBe("Which approach do we take?");
  expect(question!.key).toBe("q-41d641f8");
  expect(labelled.structured.questions_to_check).toBeUndefined();
  expect(questionsToCheckText(String(labelled.structured.message_id), labelled.questionsToCheck)).toBe("");
});

test("no choices: the sent result names the question and this message, and the resend it asks for is taken with no advice", async () => {
  const { context, project } = world();
  const first = await sendAgentMessage(context, project, { body: block("question", "Which approach do we take?", "", "Rewrite or patch, your call."), agent_host: "claude-code", agent_session: "ses_a" });
  const messageId = String(first.structured.message_id);
  const key = (first.structured.questions as { key: string }[])[0]!.key;
  expect(first.structured.questions_to_check).toEqual([{ key, position: 1, no_choices: ":::question" }]);
  expect(questionsToCheckText(messageId, first.questionsToCheck)).toContain(`reply_to "${messageId}" and supersedes "${messageId}/${key}"`);

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
});
