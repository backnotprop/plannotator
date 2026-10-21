/**
 * The Board's sample world (approval "inbox-board", step 2): realistic cards
 * in every column, written straight into a scratch Inbox store before an Inbox
 * starts on it, so each card has a real age ("2d ago"). Long titles and long
 * "You:" lines test the layout; the Icebox holds one card; Dropped holds one
 * the person dropped and two an agent dropped that the person has not seen.
 *
 *   bun tests/helpers/inbox-board-world.ts <data dir> <projects dir> [now ms]
 *
 * prints `{ ids, projects }` (card ids by key, project roots by name) and
 * exits. Only a scratch data dir (refuseRealDataDir), never the person's.
 * Import `seedBoardWorld` to seed in process.
 */
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { InboxAuthor, InboxCardColumn } from "../../packages/core/inbox-types";
import { InboxStore } from "../../packages/shared/inbox/store";
import { refuseRealDataDir } from "./real-data-dir";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const claude = (session: string): InboxAuthor => ({ kind: "agent", host: "claude-code", session, name: "Claude Code" });
const codex = (session: string): InboxAuthor => ({ kind: "agent", host: "codex", session, name: "Codex" });
const opencode = (session: string): InboxAuthor => ({ kind: "agent", host: "opencode", session, name: "OpenCode" });
const person: InboxAuthor = { kind: "person" };

interface Seed {
  key: string;
  project: "plannotator" | "workspaces" | "machine";
  by: InboxAuthor;
  title: string;
  column: InboxCardColumn;
  /** How long ago the card was last heard from. */
  ago: number;
  say?: string;
  you?: string;
  /** A thread to start for it (its first message's words). */
  thread?: string;
  prs?: string[];
  /** Icebox, Shipped or Dropped: where it was, and who moved it there. */
  from?: InboxCardColumn;
  movedBy?: InboxAuthor;
  reason?: string;
}

/** The sample cards: COLUMNS.md's real items, as of the round-four evening, plus long words for the layout. */
export const BOARD_SEEDS: readonly Seed[] = [
  // Asked
  { key: "polylane", project: "workspaces", by: codex("ses_codex_poly"), title: "Polylane plan evaluation", column: "asked", ago: 50 * HOUR, say: "Not picked up yet" },
  {
    key: "autoupdate",
    project: "plannotator",
    by: claude("ses_cc_update"),
    title: "Auto-update for users: can the opt-in auto-update be on by default for everyone who installed with the script?",
    column: "asked",
    ago: 4 * HOUR,
    say: "Pick it up: read the opt-in auto-update and say whether it can be on by default, and what it would cost people on a metered connection",
  },
  { key: "video", project: "machine", by: opencode("ses_oc_video"), title: "A cool video for machine", column: "asked", ago: 2 * HOUR, say: "Took it after the drag-drop change lands" },
  // Designing
  { key: "agents", project: "workspaces", by: claude("ses_cc_agents"), title: "Company agents and the agent SDK research", column: "designing", ago: 75 * HOUR, say: "Write up where it landed" },
  {
    key: "rename",
    project: "workspaces",
    by: claude("ses_cc_rename"),
    title: "Rename a workspace or project",
    column: "designing",
    ago: 72 * HOUR,
    say: "Mock and videos sent; taking your feedback into round two",
    thread: "The rename mock and two videos are ready for round two.",
  },
  // Your look
  {
    key: "portless",
    project: "plannotator",
    by: claude("ses_cc_portless"),
    title: "One fixed address for the Inbox (portless)",
    column: "your_look",
    ago: 96 * HOUR,
    you: "Pick a dialog (three options in the thread); screenshots follow within the hour",
    thread: "Three dialogs for the fixed address are in this thread.",
    prs: ["backnotprop/plannotator#1945"],
  },
  { key: "design", project: "workspaces", by: claude("ses_cc_design"), title: "A design system “like Interfere”", column: "your_look", ago: 19 * HOUR, you: "Answer 11 questions with pictures; the hard ones are marked" },
  { key: "hero", project: "workspaces", by: claude("ses_cc_hero"), title: "Hero scene timers, easy to see", column: "your_look", ago: 39 * MINUTE, you: "Pick one of five options on the real hero" },
  {
    key: "blend",
    project: "workspaces",
    by: claude("ses_cc_blend"),
    title: "Landing: a third style blend from interfere.com with scroll-faded screenshots, real popovers and stacked guided plans",
    column: "your_look",
    ago: 18 * MINUTE,
    you: "Look at the sheet: PROTOTYPE.html has three directions side by side, and the third needs your call on whether the popovers stay live while you scroll",
    thread: "The third blend is in PROTOTYPE.html, three directions side by side.",
  },
  // Building
  { key: "herdr", project: "machine", by: codex("ses_codex_herdr"), title: "Herdr: PR triage, diffs-rs, Rex", column: "building", ago: 72 * HOUR, say: "Triage the open PRs, then diffs-rs" },
  { key: "vite", project: "workspaces", by: claude("ses_cc_vite"), title: "vite 8 and electron-forge 8", column: "building", ago: 48 * HOUR, say: "vite 8 merged (PR 1055); Forge held for one full move", prs: ["plannotator/workspaces#1055", "plannotator/workspaces#1057"] },
  { key: "nightlies", project: "workspaces", by: claude("ses_cc_night"), title: "Phone apps: red nightlies", column: "building", ago: 29 * MINUTE, say: "Triage started; PR 1124 open" },
  // Your review
  {
    key: "digits",
    project: "plannotator",
    by: claude("ses_cc_digits"),
    title: "Monospace digits as superscripts (#1961)",
    column: "your_review",
    ago: 72 * HOUR,
    you: "Merge #1963; the reporter is waiting",
    prs: ["backnotprop/plannotator#1963"],
  },
  { key: "caret", project: "plannotator", by: claude("ses_cc_caret"), title: "Caret anywhere in the reply box", column: "your_review", ago: 48 * HOUR, you: "Merge #1960", prs: ["backnotprop/plannotator#1960"] },
  {
    key: "explorer",
    project: "plannotator",
    by: claude("ses_cc_explorer"),
    title: "Code review explorer (4 stacked PRs and a sidebar)",
    column: "your_review",
    ago: 10 * HOUR,
    you: "Merge the stack, or say what's missing; a local build of all four runs on :64606 and the sidebar PR is the last one",
    thread: "The explorer stack is ready for your look: four PRs and the sidebar.",
    prs: ["backnotprop/plannotator#1964", "backnotprop/plannotator#1966", "backnotprop/plannotator#1969", "backnotprop/plannotator#1976"],
  },
  { key: "reload", project: "plannotator", by: claude("ses_cc_reload"), title: "/reload-plugins note and 0.28.25", column: "your_review", ago: 1 * HOUR, you: "Say go for 0.28.25", prs: ["backnotprop/plannotator#2009"] },
  // Shipped
  { key: "tabcount", project: "plannotator", by: claude("ses_cc_tab"), title: "Unread count on the tab", column: "shipped", from: "your_review", ago: 3 * HOUR, say: "Merged (#2011)", prs: ["backnotprop/plannotator#2011"] },
  { key: "toast", project: "plannotator", by: claude("ses_cc_toast"), title: "Sent toast on one line", column: "shipped", from: "your_review", ago: 2 * HOUR, say: "Merged (#2010)", prs: ["backnotprop/plannotator#2010"] },
  { key: "notes", project: "plannotator", by: claude("ses_cc_notes"), title: "Release notes grouped by product", column: "shipped", from: "building", ago: 14 * HOUR, say: "In the release skill and the 0.28.24 notes" },
  // Icebox: the person paused it.
  { key: "triage", project: "plannotator", by: claude("ses_cc_triage"), title: "Triage #1786 and #1787", column: "icebox", from: "your_look", movedBy: person, ago: 8 * 24 * HOUR, you: "Say which of the two goes first" },
  // Dropped: once by the person (seen), twice by an agent (not seen yet).
  { key: "oldhero", project: "workspaces", by: claude("ses_cc_oldhero"), title: "Old landing hero", column: "dropped", from: "designing", movedBy: person, ago: 5 * 24 * HOUR, reason: "Replaced by the converge round" },
  {
    key: "notify",
    project: "plannotator",
    by: codex("ses_codex_notify"),
    title: "Browser notifications that always work",
    column: "dropped",
    from: "asked",
    ago: 3 * HOUR,
    reason: "Folded into “Messages that never got to you”: the same fix covers both, so this card would only repeat it",
  },
  {
    key: "cursors",
    project: "workspaces",
    by: claude("ses_cc_cursors"),
    title: "Pricing cursors follow-up",
    column: "dropped",
    from: "building",
    ago: 25 * MINUTE,
    reason: "Not needed: PR 1120 brought the cursors back and the claims sheet covers the rest; nothing is left to build here",
  },
];

export interface BoardWorld {
  ids: Record<string, string>;
  projects: Record<string, string>;
  projectIds: Record<string, string>;
}

/**
 * Seed the sample cards into the store at `dataDir`. `roots` names an existing
 * folder per project (else one is made under `projectsDir`). Close the store
 * before an Inbox opens the same folder.
 */
export function seedBoardWorld(dataDir: string, projectsDir: string, nowMs: number = Date.now(), roots: Partial<Record<Seed["project"], string>> = {}): BoardWorld {
  refuseRealDataDir(dataDir, "inbox-board-world.ts");
  let t = nowMs;
  const store = InboxStore.open(dataDir, { now: () => new Date(t) });
  const projects: Record<string, string> = {};
  const projectIds: Record<string, string> = {};
  for (const name of ["plannotator", "workspaces", "machine"] as const) {
    let root = roots[name];
    if (!root) {
      root = join(projectsDir, name);
      mkdirSync(root, { recursive: true });
      root = realpathSync(root);
    }
    projects[name] = root;
    t = nowMs - 30 * 24 * HOUR;
    projectIds[name] = store.ensureProject({ name, root }).id;
  }
  const ids: Record<string, string> = {};
  for (const seed of BOARD_SEEDS) {
    const project = projectIds[seed.project]!;
    const aside = seed.column === "shipped" || seed.column === "icebox" || seed.column === "dropped";
    const madeAt = nowMs - seed.ago - (aside ? 2 * HOUR : 0);
    t = madeAt - 5 * MINUTE;
    const threads: string[] = [];
    if (seed.thread) threads.push(store.sendMessage({ project_id: project, author: seed.by, body: seed.thread }).message.id);
    t = madeAt;
    const first = aside ? (seed.from ?? "asked") : seed.column;
    const card = store.createCard({
      project_id: project,
      by: seed.by,
      title: seed.title,
      column: first,
      say: seed.say,
      you: first === "your_look" || first === "your_review" ? (seed.you ?? "Have a look") : undefined,
      threads,
      prs: seed.prs ?? [],
    }).card;
    if (aside) {
      t = nowMs - seed.ago;
      store.updateCard(card.id, { by: seed.movedBy ?? seed.by, column: seed.column, reason: seed.column === "dropped" ? seed.reason : undefined });
    }
    ids[seed.key] = card.id;
  }
  return { ids, projects, projectIds };
}

if (import.meta.main) {
  const [dataDir, projectsDir, nowArg] = process.argv.slice(2);
  if (!dataDir || !projectsDir) {
    process.stderr.write("usage: inbox-board-world.ts <data dir> <projects dir> [now ms]\n");
    process.exit(2);
  }
  const world = seedBoardWorld(dataDir, projectsDir, nowArg ? Number(nowArg) : Date.now());
  process.stdout.write(`${JSON.stringify(world)}\n`);
}
