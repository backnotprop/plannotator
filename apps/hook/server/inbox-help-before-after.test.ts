/**
 * `plannotator inbox --help before-after` (approval "before-after").
 *
 * What regresses if this fails: an example in the topic stops reading as the
 * card its "Card:" line promises (an agent copies a form that renders as
 * plain text, or as the wrong card); the rule's pointer names a topic the
 * CLI does not answer; the main help stops listing the topic.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseQuestionBlock, type ParsedQuestion } from "@plannotator/core/question-block";
import { INBOX_CHANGE_RULE } from "@plannotator/shared/inbox/connection";
import { INBOX_CHANGE_RULE as MOD_INBOX_CHANGE_RULE } from "../hooks/mod/inbox-contract";
import { createAgentEnvironmentFor } from "../../../packages/server/inbox-agents";
import { diffQuestionChange } from "@plannotator/ui/utils/questionChangeDiff";
import { INBOX_BEFORE_AFTER_EXAMPLE, formatInboxHelp } from "./inbox-help";
import {
  INBOX_BEFORE_AFTER_FORMS,
  INBOX_BEFORE_AFTER_HELP,
  INBOX_HELP_BEFORE_AFTER_TOPIC,
  INBOX_HELP_TOPICS,
  inboxHelpTopic,
} from "./inbox-help-before-after";

const parse = (markdown: string, changeLines: boolean): ParsedQuestion => {
  const lines = markdown.split("\n");
  const kind = lines[0]!.slice(3);
  const q = parseQuestionBlock(kind, lines.slice(1, -1).join("\n"), { contractLines: true, optionLines: true, changeLines });
  if (!q) throw new Error(`not a question: ${lines[0]}`);
  return q;
};
const form = (title: string) => {
  const found = INBOX_BEFORE_AFTER_FORMS.find((f) => f.title === title);
  if (!found) throw new Error(`no form "${title}"`);
  return parse(found.markdown, true);
};
const text = (t: string) => ({ kind: "text", text: t });

describe("every form in the topic reads as its card", () => {
  test("each form's lines are read (none left as context), and the key, prompt and labels are the default parse's", () => {
    for (const f of INBOX_BEFORE_AFTER_FORMS) {
      const on = parse(f.markdown, true);
      const off = parse(f.markdown, false);
      expect([f.title, on.key, on.prompt, on.choices.map((c) => c.label)]).toEqual([f.title, off.key, off.prompt, off.choices.map((c) => c.label)]);
      expect([f.title, /\b(Where|Before|After|Source):/.test(on.context)]).toEqual([f.title, false]);
      expect([f.title, Boolean(on.change || on.choices.some((c) => c.before || c.after || c.places))]).toEqual([f.title, true]);
    }
  });

  test("one line, a quoted block, an added line, new and removed", () => {
    expect(form("One place, one line").change).toEqual({
      where: "Settings → General, the heading over the sound and notification rows.",
      groups: [{ before: text("When an agent asks you"), after: text("When an agent sends you something") }],
    });
    const block = form("A block, with the lines around the change").change!.groups[0]!;
    expect((block.before as { text: string }).text.split("\n")).toHaveLength(3);
    expect((block.after as { text: string }).text).toContain("sends you something");
    const added = form("An added line, inside its surroundings").change!.groups[0]!;
    expect((added.after as { text: string }).text.split("\n")).toEqual(["**Plannotator Inbox**", "While the person is away, send decisions to the Inbox.", "The person keeps an Inbox on this computer."]);
    expect(form("Something new, or something removed").change!.groups[0]!.before).toEqual({ kind: "none" });
  });

  test("several places, and a set of new strings each with its own place", () => {
    const places = form("Several places").change!;
    expect(places.where).toBe("The line above a file you open from a thread.");
    expect(places.groups.map((g) => g.where)).toEqual(["When you open the file", "After you press Open the version it sent"]);
    const set = form("A set of new strings, each in its own place").change!;
    expect(set.where).toBeUndefined();
    expect(set.groups.map((g) => [g.where, g.before?.kind])).toEqual([
      ["The Plans page, under its title, the first time it opens", "none"],
      ["The terminal, after plannotator plans", "none"],
    ]);
  });

  test("versions per choice, over one place and over several", () => {
    const versions = form("Versions: each choice its own After");
    expect(versions.choices.map((c) => c.after)).toEqual([text("Sends your edits to the team and gets theirs."), text("Syncs your stuff with the team."), undefined]);
    const over = form("Versions over several places");
    expect(over.choices[0]!.places?.map((p) => p.where)).toEqual(["the button at the top right of the toolbar", "the tooltip under that button"]);
    expect(over.choices[0]!.description).toBeUndefined();
  });

  test("pictures: per choice (pick any), a clip with its caption, and the place's picture with its Source", () => {
    const pick = form("Pick any: each choice its own change, in pictures");
    expect(pick.kind).toBe("multi");
    expect(pick.choices.map((c) => [c.before?.kind, c.after?.kind])).toEqual([["image", "image"], ["image", "image"]]);
    const clip = form("Pictures and clips, with words").change!.groups[0]!;
    expect(clip.before).toEqual({ kind: "image", alt: "Now: the row jumps to the top", src: "shots/today.gif" });
    expect(clip.after).toMatchObject({ kind: "image", src: "shots/after.gif", caption: "The line and dot change; it moves when you press Show." });
    const place = form("A picture of the place, and where it is in the code");
    expect(place.shows).toMatchObject({ kind: "image", src: "shots/settings.png" });
    expect(place.change?.source).toBe("packages/inbox/components/Settings.tsx:392");
  });
});

describe("the main help's example", () => {
  test("shows what the card marks: each choice's version keeps most of today's words, so its changed words are marked", () => {
    const q = parse(INBOX_BEFORE_AFTER_EXAMPLE, true);
    const before = q.change?.groups[0]?.before;
    expect(before?.kind).toBe("text");
    const versions = q.choices.filter((c) => c.after?.kind === "text");
    expect(versions.length).toBeGreaterThan(1);
    for (const c of versions) {
      const rows = diffQuestionChange((before as { text: string }).text, (c.after as { text: string }).text);
      expect([c.label, rows.some((r) => r.type === "mod" && !r.whole && r.afterTokens.some((t) => t.mark))]).toEqual([c.label, true]);
    }
  });
});

describe("reaching the topic", () => {
  test("`--help before-after` in any order prints the topic; anything else is not a topic", () => {
    for (const argv of [["--help", "before-after"], ["before-after", "--help"], ["-h", "before-after"], ["help", "before-after"]]) {
      expect([argv, inboxHelpTopic(argv)]).toEqual([argv, INBOX_BEFORE_AFTER_HELP]);
    }
    for (const argv of [["--help"], ["before-after"], ["--help", "nope"], ["--help", "before-after", "extra"], ["projects", "--help"]]) {
      expect([argv, inboxHelpTopic(argv)]).toEqual([argv, null]);
    }
  });

  test("the rule (both copies) ends by naming a topic the CLI answers, and the main help lists it", () => {
    const command = `plannotator inbox --help ${INBOX_HELP_BEFORE_AFTER_TOPIC}`;
    expect(INBOX_CHANGE_RULE).toEndWith(`\`${command}\`.`);
    expect(MOD_INBOX_CHANGE_RULE).toBe(INBOX_CHANGE_RULE);
    expect(INBOX_HELP_TOPICS[INBOX_HELP_BEFORE_AFTER_TOPIC]).toBe(INBOX_BEFORE_AFTER_HELP);
    // A made-up home that is never created: the help only names paths in it.
    const home = join(tmpdir(), "plannotator-help-topic-test-home");
    const help = formatInboxHelp({ command: ["plannotator"], dataDir: join(home, ".plannotator"), platform: "linux", agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: home, env: { HOME: home, PATH: "" } }) });
    const topics = help.slice(help.indexOf("## Help topics"));
    expect(topics).toContain(`\`${command}\``);
  });
});
