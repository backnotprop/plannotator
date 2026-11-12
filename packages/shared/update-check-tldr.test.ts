import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractReleaseNotes, readReleaseNotes, releaseBodyStamp, releaseNotesFrom, splitTldr, updateCheckPaths, writeReleaseNotes } from "./update-check";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-tldr-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const body = (tldr: string) =>
  ["| [v0.28.52](https://x/v0.28.52) | Ask AI everywhere |", "", "## What's New in v0.28.53", "", tldr, "Starting an agent from New message now covers a new folder.", "", "## Install / Update", "", "curl …"].join("\n");

test("the TL;DR's lines come apart from the notes, labels in the skill's spelling", () => {
  const out = extractReleaseNotes(
    body(
      [
        "### TL;DR",
        "",
        "- **New:** Start an agent in a new folder, or from a git URL",
        "- **changed**: New message offers the open thread's files",
        "- **Fixed:** A [thread's](https://x/1) links stay put",
        "- **Removed:** `PLANNOTATOR_INBOX_ASK_AI`: Ask AI is always on",
        "- **Off by default:** Bro mode",
        "",
      ].join("\n"),
    ),
  );
  expect(out.tldr).toEqual([
    { label: "New", text: "Start an agent in a new folder, or from a git URL" },
    { label: "Changed", text: "New message offers the open thread's files" },
    { label: "Fixed", text: "A thread's links stay put" },
    { label: "Removed", text: "`PLANNOTATOR_INBOX_ASK_AI`: Ask AI is always on" },
    { label: "Off by default", text: "Bro mode" },
  ]);
  expect(out.notes).toBe("Starting an agent from New message now covers a new folder.");
  expect(out.highlights).toEqual([{ version: "0.28.52", text: "Ask AI everywhere" }]);
});

test("no TL;DR: no lines, and the notes are untouched", () => {
  const out = extractReleaseNotes(body(""));
  expect(out.tldr).toEqual([]);
  expect(out.notes).toBe("Starting an agent from New message now covers a new folder.");
});

test("malformed: a heading with no list, or a TL;DR below the opening paragraph, takes nothing from the notes", () => {
  const paragraph = "### TL;DR\n\nThis release is mostly fixes.\n\nMore words.";
  expect(splitTldr(paragraph)).toEqual({ tldr: [], notes: paragraph });
  const later = "Opening paragraph.\n\n### TL;DR\n\n- **New:** Something";
  expect(splitTldr(later)).toEqual({ tldr: [], notes: later });
  expect(splitTldr("### TL;DR\n\n- **New:**\n- **Fixed:** It works\n\nRest").tldr).toEqual([{ label: "Fixed", text: "It works" }]);
});

test("odd lines: an unknown label is kept as written, a line with no label keeps its words, the list stops at the first other line", () => {
  const out = splitTldr("### TL;DR\n- **Security:** Tokens rotate\n- Just words\n- **New** Colon outside the bold\nNot a list line\n- **New:** never read");
  expect(out.tldr).toEqual([
    { label: "Security", text: "Tokens rotate" },
    { label: "", text: "Just words" },
    { label: "New", text: "Colon outside the bold" },
  ]);
  expect(out.notes).toBe("Not a list line\n- **New:** never read");
});

test("at most 8 lines, each capped", () => {
  const lines = Array.from({ length: 12 }, (_, i) => `- **New:** Line ${i} ${"x".repeat(400)}`);
  const out = splitTldr(`### TL;DR\n${lines.join("\n")}\n\nNotes.`);
  expect(out.tldr).toHaveLength(8);
  expect(out.tldr.every((l) => l.text.length <= 300)).toBe(true);
  expect(out.notes).toBe("Notes.");
});

test("saved notes keep the TL;DR and the body's stamp; notes saved by an older version are read the same way", () => {
  const raw = body("### TL;DR\n\n- **New:** A thing\n");
  writeReleaseNotes(releaseNotesFrom("0.28.53", { body: raw, publishedAt: "2026-11-08T00:00:00Z" }), dataDir);
  const saved = readReleaseNotes("0.28.53", dataDir)!;
  expect(saved.tldr).toEqual([{ label: "New", text: "A thing" }]);
  expect(saved.stamp).toBe(releaseBodyStamp(raw));
  expect(saved.notes).toBe("Starting an agent from New message now covers a new folder.");

  mkdirSync(updateCheckPaths(dataDir).notes, { recursive: true });
  writeFileSync(
    join(updateCheckPaths(dataDir).notes, "0.28.50.json"),
    JSON.stringify({ version: "0.28.50", notes: "### TL;DR\n\n- **Changed:** Faster\n\nThe Inbox opens faster.", highlights: [] }),
  );
  const old = readReleaseNotes("0.28.50", dataDir)!;
  expect(old.tldr).toEqual([{ label: "Changed", text: "Faster" }]);
  expect(old.notes).toBe("The Inbox opens faster.");
  expect(old.stamp).toBeUndefined();
});

test("the stamp follows the body: an edit changes it, line endings do not", () => {
  expect(releaseBodyStamp("a\nb")).toBe(releaseBodyStamp("a\r\nb"));
  expect(releaseBodyStamp("a\nb")).not.toBe(releaseBodyStamp("a\nb\n### TL;DR"));
});
