/**
 * `plannotator inbox --help before-after`: every form of a question's change
 * lines (approval "before-after"), printed alone so an agent reads only this
 * when a question proposes a change. The tool's rule (`INBOX_CHANGE_RULE`)
 * ends by naming the command; the main `--help` lists it under "Help topics".
 *
 * Each form is a whole `:::question` block that core's parser reads as its
 * "Card:" line says (`inbox-help-before-after.test.ts` parses every one).
 * Words approved by the owner, 2026-11-18.
 */

/** The topic's word, after `plannotator inbox --help`. */
export const INBOX_HELP_BEFORE_AFTER_TOPIC = "before-after";

export interface InboxBeforeAfterForm {
  title: string;
  /** A whole question block. */
  markdown: string;
  /** What the person sees, one line. */
  card: string;
}

export const INBOX_BEFORE_AFTER_FORMS: readonly InboxBeforeAfterForm[] = [
  {
    title: "One place, one line",
    markdown: [
      ":::question",
      "Rename the Settings heading over sound and notifications?",
      "Where: Settings → General, the heading over the sound and notification rows.",
      "Before: When an agent asks you",
      "After: When an agent sends you something",
      "- [ ] Rename it",
      "- [ ] Leave it",
      ":::",
    ].join("\n"),
    card: "the Where with a pin, then Now \"When an agent ~~asks you~~\" and After \"When an agent **sends you something**\".",
  },
  {
    title: "A block, with the lines around the change",
    markdown: [
      ":::question",
      "Change the sound dialog's sentence to match?",
      "Where: The one-time dialog The Inbox can ring now, the sentence under its title.",
      "Before:",
      "> **The Inbox can ring now**",
      "> A soft doorbell when an agent asks you something and this tab is hidden.",
      "> Turn it off · Keep it on",
      "After:",
      "> **The Inbox can ring now**",
      "> A soft doorbell when an agent sends you something and this tab is hidden.",
      "> Turn it off · Keep it on",
      "- [ ] Change it",
      "- [ ] Leave it",
      ":::",
    ].join("\n"),
    card: "the changed line with the nearest line on each side, those dimmed (a longer run of unchanged lines shows as \"…\"); only \"asks\" → \"sends\" marked. `Before:` alone on its line, then `> ` lines (a paragraph, a list, a heading).",
  },
  {
    title: "An added line, inside its surroundings",
    markdown: [
      ":::question",
      "Add a lead sentence to the note?",
      "Where: The Plannotator Inbox section in each agent's instruction file, right under its heading.",
      "Before:",
      "> **Plannotator Inbox**",
      "> The person keeps an Inbox on this computer.",
      "After:",
      "> **Plannotator Inbox**",
      "> While the person is away, send decisions to the Inbox.",
      "> The person keeps an Inbox on this computer.",
      "- [ ] Add it",
      "- [ ] Not now",
      ":::",
    ].join("\n"),
    card: "no Now (nothing is removed); After with the new line marked between its neighbours. Better than `Before: none`, which loses where it goes.",
  },
  {
    title: "Something new, or something removed",
    markdown: [
      ":::question",
      "Show a toast after Plans is turned on?",
      "Where: The toast after you turn Plans on in Settings.",
      "Before: none",
      "After: Plans is on. [Open Plans](#)",
      "- [ ] Yes",
      "- [ ] No",
      ":::",
    ].join("\n"),
    card: "\"New\" and the words. `After: none` instead shows Now and \"Removed\".",
  },
  {
    title: "Several places",
    markdown: [
      ":::question",
      "Reword the line above a file that changed after it was sent?",
      "Where: The line above a file you open from a thread.",
      "Where: When you open the file",
      "Before: Changed since Claude Code sent it. [Open the version it sent](#)",
      "After: You are viewing the file as it is now. [Open the version it sent](#)",
      "Where: After you press Open the version it sent",
      "Before: The version Claude Code sent. [Open the file as it is now](#)",
      "After: You are viewing the version Claude Code sent. [Open the file as it is now](#)",
      "- [ ] Yes, both",
      "- [ ] Leave both",
      ":::",
    ].join("\n"),
    card: "the first Where (nothing under it) with a pin; each place under its own small heading. A repeated `Where:` (or `Before:` / `After:`) starts the next place.",
  },
  {
    title: "A set of new strings, each in its own place",
    markdown: [
      ":::question",
      "These two lines for turning Plans on?",
      "Where: The Plans page, under its title, the first time it opens",
      "Before: none",
      "After: Every plan you review lands here, newest first.",
      "Where: The terminal, after plannotator plans",
      "Before: none",
      "After: Plans is on. Opening it in your Inbox…",
      "- [ ] Both",
      "- [ ] Change some",
      ":::",
    ].join("\n"),
    card: "each place with its own pin, \"New\" and its words.",
  },
  {
    title: "Versions: each choice its own After",
    markdown: [
      ":::question",
      "New words for the Sync button's tooltip?",
      "Where: The tooltip on the Sync button, top right of the toolbar.",
      "Before: Syncs your stuff.",
      "- [ ] Plain",
      "  After: Sends your edits to the team and gets theirs.",
      "- [ ] Short",
      "  After: Syncs your stuff with the team.",
      "- [ ] Leave it",
      "Recommended: Short",
      ":::",
    ].join("\n"),
    card: "each choice shows its version under its label (marked against today's words); the one choice without an After shows today's words in full, and the separate Now goes. The question's `Before:` needs no `After:` of its own here: the choices' are its After.",
  },
  {
    title: "Versions over several places",
    markdown: [
      ":::question",
      "What should the Sync button and its tooltip say?",
      "- [ ] Sync with team",
      "  Where: the button at the top right of the toolbar",
      "  Before: Sync",
      "  After: Sync with team",
      "  Where: the tooltip under that button",
      "  Before: Syncs your stuff.",
      "  After: Syncs your edits with the team.",
      "- [ ] Leave them",
      ":::",
    ].join("\n"),
    card: "under the choice, each place named, with its Now and After. Or give the places at the question's indent and one `After:` per place, in order, under each choice.",
  },
  {
    title: "Pick any: each choice its own change, in pictures",
    markdown: [
      ":::question-multi",
      "Which contrast fixes go in?",
      "Where: Two themes, each where the problem shows.",
      "- [ ] Tags on dark themes",
      "  Before: ![Now](shots/tags-now.png)",
      "  After: ![After](shots/tags-after.png)",
      "- [ ] Links in Dracula",
      "  Before: ![Now](shots/links-now.png)",
      "  After: ![After](shots/links-after.png)",
      ":::",
    ].join("\n"),
    card: "each choice's Now and After pictures side by side under its row; a picture opens full size and never picks. Text works the same way. A picture choice (`- [ ] A — ![alt](path)`) shows its own `After:` in its tile, under its words.",
  },
  {
    title: "Pictures and clips, with words",
    markdown: [
      ":::question",
      "Update a row where it is when a reply arrives?",
      "Where: The thread list while you read one.",
      "Before: ![Now: the row jumps to the top](shots/today.gif)",
      "After: ![After: the row changes in place](shots/after.gif) The line and dot change; it moves when you press Show.",
      "- [ ] Update in place",
      "- [ ] Keep it as now",
      ":::",
    ].join("\n"),
    card: "the two side by side (stacked on a phone), each opening full size; words after a picture on its line show under it. A clip is a GIF.",
  },
  {
    title: "A picture of the place, and where it is in the code",
    markdown: [
      ":::question",
      "Rename the Settings heading?",
      "Where: Settings → General, the heading over the sound rows.",
      "Shows: ![Settings → General, the heading circled](shots/settings.png)",
      "Source: packages/inbox/components/Settings.tsx:392",
      "Before: When an agent asks you",
      "After: When an agent sends you something",
      "- [ ] Rename it",
      "- [ ] Leave it",
      ":::",
    ].join("\n"),
    card: "\"See it\" beside the Where opens the picture, with the Source; with no `Shows:` picture, `Source:` stays a plain line.",
  },
];

/** The topic, as printed. */
export const INBOX_BEFORE_AFTER_HELP = [
  "# Before and after: every form",
  "",
  "Printed by `plannotator inbox --help before-after`. For a `:::question` that proposes a change the person can see: words, a screen, code, a setting.",
  "",
  "- `Where: <place>`: what it is and where the person sees it, in their words. Drawn under the question (and its Stakes), with a pin.",
  "- `Before:` / `After:`: the whole sentence, block or screenshot it sits in. The card strikes removed words (red) in Now and marks added words (green) in After; a line that keeps under 40% of its words is shown unmarked, Now dimmed.",
  "",
  "What is read:",
  "",
  "- At the question's indent, a place is drawn when it has a `Before:` and an `After:` (its `Where:` first, optional). A question-level `Before:` with no `After:` is drawn only when choices carry their own `After:` (Versions).",
  "- Under a `- [ ]` choice, a place needs an `After:`; its `Where:` and `Before:` are optional. A choice's lines are indented under it. Lines at the question's indent, even right after the last choice, are the question's own place (drawn when complete) or stay plain text.",
  "- A value is one line: the words after the label, and only that line (a line under it is your own text). More than one line: the label alone, then `> ` lines (keeps lists and headings). Or `![alt](path)` (a GIF for a clip; words after it are its caption), or `none`.",
  "- Anything else stays plain text where you wrote it: a `Where:` alone, a `Before:` with no `After:`, an `After:` with no `Before:` at the question's indent. The lines never change the question's key, and an Inbox without this shows them as text.",
  "",
  ...INBOX_BEFORE_AFTER_FORMS.flatMap((form) => [`## ${form.title}`, "", "```markdown", form.markdown, "```", "", `Card: ${form.card}`, ""]),
  "## Not this",
  "",
  "- `Where: packages/inbox/Settings.tsx:392`: a path says nothing to the person. Say where they see it; the path goes on `Source:`.",
  "- `Before: asks` / `After: sends`: only the changed words. Give the whole sentence or block; the card marks the words.",
  "- A new feature or a prototype (nothing to compare): numbered pictures, or a `Prototype:` line. A choice the person never sees (a library, an internal name): no lines.",
  "- A fenced code block as a value: it stays text. Quote code lines with `> `.",
].join("\n");

/** The topics `plannotator inbox --help <topic>` prints alone: topic → its help. */
export const INBOX_HELP_TOPICS: Readonly<Record<string, string>> = {
  [INBOX_HELP_BEFORE_AFTER_TOPIC]: INBOX_BEFORE_AFTER_HELP,
};

/** The main `--help`'s closing list of topics. */
export const INBOX_HELP_TOPICS_LINES: readonly string[] = [
  "## Help topics",
  "",
  "Each prints alone, when you need it:",
  "",
  "- `plannotator inbox --help before-after`: every form of `Where:` / `Before:` / `After:` in a question (several places, versions per choice, pictures, new or removed), each with an example and what the person sees.",
];

/**
 * The topic's help for argv after `inbox` (`--help before-after`,
 * `before-after --help`, `help before-after`), or null: one known topic word
 * and a help word, nothing else.
 */
export function inboxHelpTopic(argv: readonly string[]): string | null {
  const helps = argv.filter((a) => a === "--help" || a === "-h" || a === "help");
  const words = argv.filter((a) => a !== "--help" && a !== "-h" && a !== "help");
  if (helps.length === 0 || words.length !== 1) return null;
  return INBOX_HELP_TOPICS[words[0]!] ?? null;
}
