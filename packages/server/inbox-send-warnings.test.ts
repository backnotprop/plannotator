/**
 * send_message's word to the agent about two things the person will not see as sent (the message is sent either way):
 * a sound or video written inside a question, which the question card draws as text (`question_media_not_shown`),
 * and an attached HTML page past what the window frames, which reaches the person as a download card
 * (`pages_not_shown`).
 *
 * What regresses if this fails: an agent asks with a clip in a choice, or attaches a 16 MB page, and never hears that
 * the person saw text or no page.
 *
 * A real store in a temp data dir, driven through sendAgentMessage (the send path send_message runs); no Inbox
 * server, no network.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { recordInboxAttachments } from "@plannotator/shared/inbox/attachments";
import { sendAgentMessage, type InboxMcpContext } from "./inbox-mcp";
import { INBOX_PAGE_MAX_BYTES } from "./inbox-pages";
import { pagesNotShownText, questionMediaNotShownText } from "./inbox-send-warnings";

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

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-send-warnings-")));
  roots.push(root);
  process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
  const app = join(root, "fern-api");
  mkdirSync(app, { recursive: true });
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "fern-api", root: app });
  const context = {
    store,
    baseUrl: () => "http://localhost:1/",
    recordAttachments: (paths: readonly string[], _project: unknown, base: string) => recordInboxAttachments(store.dir, paths, { base, at: new Date().toISOString() }),
  } as unknown as InboxMcpContext;
  const send = (body: string, attachments?: string[]) => sendAgentMessage(context, project, { body, project_path: app, ...(attachments ? { attachments } : {}) } as never);
  return { app, send };
}

test("a video or sound in a picture choice, a Shows: line or a Before:/After: is named with its question; a picture is not", async () => {
  const w = world();
  const sent = await w.send(
    [
      ":::question",
      "Which intro plays first?",
      "",
      "- [ ] Calm — ![calm](/clips/calm.mp4) slow fade",
      "- [ ] Loud — ![loud](/clips/loud.png) quick cut",
      ":::",
      "",
      ":::question",
      "Is this the sound?",
      "Shows: ![chime](chime.mp3)",
      "",
      "- [ ] Yes",
      "- [ ] No",
      ":::",
      "",
      ":::question",
      "Ship the new motion?",
      "Where: the sign-in page",
      "Before: ![old](old.mp4)",
      "After: ![new](new.webm)",
      "",
      "- [ ] Ship it",
      "- [ ] Keep the old",
      ":::",
    ].join("\n"),
  );
  const listed = sent.structured.question_media_not_shown as { ref: string; question: string }[];
  expect(listed.map((item) => item.ref)).toEqual(["/clips/calm.mp4", "chime.mp3", "old.mp4", "new.webm"]);
  expect(listed.every((item) => /^q-/.test(item.question))).toBe(true);
  expect(questionMediaNotShownText(sent.questionMediaNotShown)).toContain("/clips/calm.mp4");

  const plain = await w.send(":::question\nWhich logo?\n\n- [ ] A — ![a](a.png)\n- [ ] B — ![b](b.png)\n:::\n\n![clip](intro.mp4) plays in the body.");
  expect(plain.structured.question_media_not_shown).toBeUndefined();
});

test("an attached page past what the window frames is named with its size; a page under it is not", async () => {
  const w = world();
  writeFileSync(join(w.app, "big.html"), `<!doctype html><p>${"x".repeat(INBOX_PAGE_MAX_BYTES + 1024)}</p>`);
  writeFileSync(join(w.app, "notes.html"), "<!doctype html><p>Small.</p>");
  const sent = await w.send("Two pages.", ["big.html", "notes.html"]);
  expect(sent.structured.pages_not_shown).toEqual([{ name: "big.html", size: expect.any(Number), limit: INBOX_PAGE_MAX_BYTES }]);
  expect(pagesNotShownText(sent.pagesNotShown)).toContain("big.html");
  const small = await w.send("One page.", ["notes.html"]);
  expect(small.structured.pages_not_shown).toBeUndefined();
});
