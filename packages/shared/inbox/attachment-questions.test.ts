/**
 * The server's read of the questions inside attached Markdown files (issue
 * #2828): from each file's SENT bytes, as its viewer reads them.
 *
 * What regresses if this fails: a file's questions are read from the file as
 * it is now (not as sent), keyed unlike the card the window draws, or a file
 * that is not Markdown asks questions.
 */
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findQuestionBlocks } from "@plannotator/core/question-block";
import type { InboxAttachment } from "@plannotator/core/inbox-types";
import { readInboxAttachmentQuestions } from "./attachment-questions";
import { writeBlob } from "./attachments";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PLAN = ["---", "title: Plan", "---", "# Plan", "", ":::question", "Which database?", "", "- [ ] Postgres", "- [ ] SQLite", ":::"].join("\n");

function sent(dir: string, name: string, kind: InboxAttachment["kind"], text: string): InboxAttachment {
  const bytes = Buffer.from(text, "utf8");
  const sha = createHash("sha256").update(bytes).digest("hex");
  writeBlob(dir, sha, bytes);
  return { id: `att_${name}`, path: `/nowhere/${name}`, named_path: null, name, kind, sent_sha256: sha, size: bytes.length, sent_at: "", sent_mtime: "" };
}

test("each Markdown file's questions, from its sent bytes, keyed as its card computes them; other files ask nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-file-questions-read-"));
  roots.push(dir);
  const plan = sent(dir, "plan.md", "markdown", PLAN);
  const notes = sent(dir, "notes.txt", "text", PLAN);
  const empty = sent(dir, "readme.md", "markdown", "# Nothing asked\n");
  // The file on disk (`path`) does not exist: only the blob is read.
  const read = await readInboxAttachmentQuestions(dir, [notes, plan, empty]);
  expect(read.map((r) => r.attachment_id)).toEqual([plan.id]);
  const [q] = read[0]!.questions;
  expect(q!.prompt).toBe("Which database?");
  // The window's viewer strips a .md file's frontmatter and finds the same key.
  expect(q!.key).toBe(findQuestionBlocks(PLAN)[0]!.key);
  expect(q!.parsed.line).toBe(7);
});

test("a blob that is gone asks nothing, and never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-file-questions-read-"));
  roots.push(dir);
  const plan: InboxAttachment = { id: "att_gone", path: "/nowhere/plan.md", named_path: null, name: "plan.md", kind: "markdown", sent_sha256: "a".repeat(64), size: 10, sent_at: "", sent_mtime: "" };
  expect(await readInboxAttachmentQuestions(dir, [plan])).toEqual([]);
});
