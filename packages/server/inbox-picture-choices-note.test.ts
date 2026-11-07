/**
 * send_message on a question about pictures written with bare text choices:
 * the pictures sit above the question (a rundown, one per option) and the
 * choices are plain text, so the person cannot pick by picture. The result
 * then tells the agent to send the question again as picture choices,
 * replacing this one. Advice only: the message is sent as written.
 *
 * What regresses if this fails: the agent never hears it and the person
 * keeps picking from bare radio buttons under big screenshots (the clean
 * room: Claude 2/6 without the line, 6/6 with it), or the line fires on a
 * question that is right, or it names ids the resend is refused with.
 *
 * A real store in a temp data dir, driven through sendAgentMessage (the
 * send path send_message runs); no Inbox server, no network.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { choicesWithoutPicturesText, questionsWithoutPictureChoices, sendAgentMessage, type InboxMcpContext } from "./inbox-mcp";

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

const rundown = (...pictures: string[]) => ["Four themes came in:", "", ...pictures.map((p) => `- ${p}: ![${p}](designs/${p}.png)`), ""];
const ask = (kind: string, ...choices: string[]) => [`:::${kind}`, "Which theme do we ship?", "", ...choices, ":::"];
const body = (...parts: string[][]) => parts.flat().join("\n");

const BARE = ["- [ ] Forest — calm greens", "- [ ] Sunset — warm oranges", "- [ ] Ocean — deep blues"];
const PICTURED = [
  "- [ ] Forest — ![Forest](designs/forest.png) calm greens",
  "- [ ] Sunset — ![Sunset](designs/sunset.png) warm oranges",
  "- [ ] Ocean — ![Ocean](designs/ocean.png) deep blues",
];

test("bare choices under two or more pictures: the question is named, with the pictures counted", () => {
  for (const kind of ["question", "question-multi"]) {
    const found = questionsWithoutPictureChoices(body(rundown("forest", "sunset", "ocean"), ask(kind, ...BARE)));
    expect(found.pictures).toBe(3);
    expect(found.keys).toHaveLength(1);
  }
});

test("no advice with one picture above, picture choices, some picture choices, or no question", () => {
  expect(questionsWithoutPictureChoices(body(rundown("current"), ask("question", ...BARE))).keys).toEqual([]);
  expect(questionsWithoutPictureChoices(body(rundown("forest", "sunset", "ocean"), ask("question", ...PICTURED))).keys).toEqual([]);
  expect(questionsWithoutPictureChoices(body(rundown("forest", "sunset"), ask("question", PICTURED[0]!, BARE[1]!, BARE[2]!))).keys).toEqual([]);
  expect(questionsWithoutPictureChoices(body(rundown("forest", "sunset", "ocean"))).keys).toEqual([]);
  // A free-text question has no choices to carry pictures.
  expect(questionsWithoutPictureChoices(body(rundown("forest", "sunset"), [":::question-text", "Which theme, and why?", ":::"])).keys).toEqual([]);
});

test("only pictures outside question blocks and outside code count", () => {
  // Two pictures, but inside other questions' picture choices: none sits above the bare question.
  const twoAsked = body(ask("question", ...PICTURED), ["", "Then:", ""], ask("question-multi", "- [ ] Light mode", "- [ ] Dark mode"));
  expect(questionsWithoutPictureChoices(twoAsked).keys).toEqual([]);
  // One real picture and one inside a code fence (drawn as code, not a picture).
  const fenced = body(rundown("forest"), ["```md", "![Sunset](designs/sunset.png)", "```", ""], ask("question", ...BARE));
  expect(questionsWithoutPictureChoices(fenced).keys).toEqual([]);
  // The same picture twice is one picture.
  const twice = body(rundown("forest", "forest"), ask("question", ...BARE));
  expect(questionsWithoutPictureChoices(twice).keys).toEqual([]);
});

test("the sent result names this message and the question's key, and the resend it asks for is taken", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-picture-note-")));
  roots.push(root);
  process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "app", root: join(root, "app") });
  const context = { store, baseUrl: () => "http://localhost:1/" } as unknown as InboxMcpContext;

  const first = await sendAgentMessage(context, project, { body: body(rundown("forest", "sunset", "ocean"), ask("question", ...BARE)), agent_host: "claude-code", agent_session: "ses_a" });
  const messageId = String(first.structured.message_id);
  const key = (first.structured.questions as { key: string }[])[0]!.key;
  expect(first.choicesWithoutPictures).toEqual({ keys: [key], pictures: 3 });
  const text = choicesWithoutPicturesText(messageId, first.choicesWithoutPictures);
  expect(text).toContain(`but 3 pictures sit above it`);
  expect(text).toContain(`reply_to "${messageId}" and supersedes "${messageId}/${key}"`);

  // Doing what it says: the resend lands in the same thread, replaces the question, and gets no advice.
  const again = await sendAgentMessage(context, project, {
    body: body(ask("question", ...PICTURED)),
    reply_to: messageId,
    supersedes: [`${messageId}/${key}`],
    agent_host: "claude-code",
    agent_session: "ses_a",
  });
  expect(again.structured.thread_id).toBe(first.structured.thread_id);
  expect(again.structured.superseded).toEqual([`${messageId}/${key}`]);
  expect(again.choicesWithoutPictures.keys).toEqual([]);
  expect(choicesWithoutPicturesText(String(again.structured.message_id), again.choicesWithoutPictures)).toBe("");
});
