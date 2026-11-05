#!/usr/bin/env bun
/**
 * Writes packages/inbox/feedbackRelated.data.json, the Feedback form's "Might
 * be related" list. The owner runs it while preparing a release, with `gh`
 * logged in (.agents/skills/release/SKILL.md), and the file goes in the release
 * commit. CI and the builds never run it, so they make no new network call.
 *
 * Reads, read-only, from the public repo: published release notes (the new
 * release's draft comes from RELEASE_NOTES_v<version>.md in the checkout), open
 * issue titles and open PR titles. Titles and version numbers are all that go
 * in the file. Never a body, an author or a draft release, because the logged
 * in owner can see drafts that nobody else can.
 *
 *   bun scripts/feedback-related-index.ts
 *
 * A failed or suspiciously empty read writes nothing and exits 1.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RelatedData, RelatedFeature, RelatedIssue, RelatedRelease } from '../packages/inbox/feedbackRelated';
import { isPublicRelatedUrl } from '../packages/inbox/feedbackRelated';

const REPO = 'backnotprop/plannotator';
const REPO_URL = `https://github.com/${REPO}`;
const DOCS = 'https://plannotator.ai/docs/reference/inbox/';
/** Older notes describe features that have since been renamed or removed. */
const OLDEST_RELEASE = [0, 20, 0] as const;
const OUT_FILE = 'packages/inbox/feedbackRelated.data.json';

/**
 * Features people ask for by another name, which no title can match ("done
 * button" for Archive). By hand: keep it about this short, in whole phrases,
 * and check each reason against the product when you add one. A single common
 * word here misfires on unrelated messages ("talk to me about pricing").
 */
export const RELATED_FEATURES: RelatedFeature[] = [
  { title: 'Archive', phrases: ['done button', 'mark done', 'mark as done', 'done state', 'finish thread', 'close thread', 'delete thread', 'remove thread', 'dismiss thread', 'trash'], reason: "Already there: the archive icon in a thread's header ends it. Unarchive reopens it.", url: `${DOCS}#what-you-see` },
  { title: 'Mark unread', phrases: ['unread'], reason: "Already there: on a thread's row and in its header.", url: `${REPO_URL}/releases/tag/v0.28.43` },
  { title: 'Pin a thread', phrases: ['pin', 'star thread', 'favorite', 'favourite', 'bookmark'], reason: 'Already there: right-click a thread and choose Pin thread.', url: `${DOCS}#what-you-see` },
  { title: 'Snooze a thread', phrases: ['snooze', 'remind me', 'postpone'], reason: 'Already there: right-click a row and choose Snooze.', url: `${REPO_URL}/releases/tag/v0.28.46` },
  { title: 'Dictate your replies', phrases: ['by voice', 'voice input', 'voice reply', 'use voice', 'microphone', 'dictate', 'speech to text'], reason: 'Already there: press the mic to record.', url: `${REPO_URL}/releases/tag/v0.28.43` },
  { title: 'New message', phrases: ['compose', 'new message', 'write first'], reason: 'Already there: the pencil beside Search writes to a running agent first.', url: `${DOCS}#what-you-see` },
  { title: 'Search', phrases: ['search message', 'search thread', 'find thread', 'find message', 'search across'], reason: 'Already there: Search at the top of the sidebar, grouped by threads and messages.', url: `${DOCS}#what-you-see` },
  { title: 'Settings, Appearance', phrases: ['dark mode', 'light mode', 'font size', 'text size', 'change theme', 'own theme'], reason: 'Already there: light, dark or system, the text size and the colors.', url: `${DOCS}#what-you-see` },
  { title: 'Settings, Rows', phrases: ['compact row', 'compact list', 'rows compact', 'cramped', 'density'], reason: 'Already there: density, first line, unread style and more.', url: `${REPO_URL}/releases/tag/v0.28.47` },
  { title: 'Over your tailnet', phrases: ['on my phone', 'on phone', 'from my phone', 'on mobile', 'mobile app', 'iphone app', 'android app', 'ipad'], reason: 'Already there: open the Inbox from your other devices over your tailnet.', url: `${DOCS}#over-your-tailnet` },
];

export interface ReleaseInput {
  tag: string;
  draft?: boolean;
  prerelease?: boolean;
  body: string | null;
}
export interface TitleInput {
  number: number;
  title: string;
}

/** Sections that are people, install steps or the raw PR list: never a feature. */
const NOT_A_FEATURE = /^(what's changed|what's new|install|new contributors|community|contributors|thanks|full changelog)/i;
/** A section whose heading only groups its bullets: each bullet is the line. */
const GROUPING = /smaller|additional|other|fixes|bug|ux improvements/i;
/** A bullet that only credits someone or names a PR: no feature in it. */
const ONLY_A_CREDIT = /^(authored|reported|requested|closes|closing|thanks|credit)\b/i;
/** A heading that only names the product: what is under it is the feature. */
const ONLY_THE_PRODUCT = /^plannotator( inbox)?$/i;
/** Bots and trackers: nobody files feedback about these. */
const NOT_A_REQUEST = /^(chore\(deps\)|bump |dependency dashboard|pre-release manual qa)/i;

const plain = (text: string) =>
  text
    .replace(/\r/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`|\*\*|\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function firstSentence(text: string): string {
  const line = plain(text);
  return (/^(.{20,}?[.!?])(\s|$)/.exec(line)?.[1] ?? line).slice(0, 180);
}

const versionParts = (tag: string) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)?.slice(1).map(Number) ?? null;

function isOldEnough(parts: number[]): boolean {
  for (let at = 0; at < 3; at++) if (parts[at] !== OLDEST_RELEASE[at]) return parts[at]! > OLDEST_RELEASE[at]!;
  return true;
}

function newestFirst(a: ReleaseInput, b: ReleaseInput): number {
  const [x, y] = [versionParts(a.tag)!, versionParts(b.tag)!];
  for (let at = 0; at < 3; at++) if (x[at] !== y[at]) return y[at]! - x[at]!;
  return 0;
}

/** The headings below "What's New" of one release's notes (a grouping section gives its bullets). */
export function releaseTitles(body: string): string[] {
  const text = body.replace(/\r/g, '');
  const start = text.search(/^## What's New\b/m);
  if (start < 0) return [];
  let notes = text.slice(start);
  const end = notes.search(/^##+ +(Install|What's Changed)/m);
  if (end > 0) notes = notes.slice(0, end);
  const parts = notes.split(/^(#{2,4} +.+)$/m);
  const titles: string[] = [];
  for (let at = 1; at < parts.length; at += 2) {
    const heading = plain(parts[at]!.replace(/^#+ +/, ''));
    if (NOT_A_FEATURE.test(heading) || ONLY_THE_PRODUCT.test(heading)) continue;
    const bullets = (parts[at + 1] ?? '').split('\n').filter((line) => line.startsWith('- '));
    if (GROUPING.test(heading) && bullets.length) titles.push(...bullets.map((line) => firstSentence(line.slice(2))));
    else titles.push(heading);
  }
  return titles.filter((title) => title && !ONLY_A_CREDIT.test(title));
}

/** The file's content from what GitHub answered. Pure; the tests call it with no `gh` in sight. */
export function buildRelatedData(input: { releases: ReleaseInput[]; issues: TitleInput[]; pulls: TitleInput[] }): RelatedData {
  const seen = new Set<string>();
  const releases: RelatedRelease[] = [];
  const published = input.releases.filter((release) => {
    const parts = versionParts(release.tag);
    return parts && !release.draft && !release.prerelease && isOldEnough(parts);
  });
  for (const release of published.sort(newestFirst)) {
    for (const title of releaseTitles(release.body ?? '')) {
      // Patch notes repeat a heading; the newest release that has it stays.
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      releases.push({ title, version: release.tag });
    }
  }
  const issues: RelatedIssue[] = input.issues
    .filter((issue) => !NOT_A_REQUEST.test(issue.title))
    .sort((a, b) => b.number - a.number)
    .map((issue) => ({ title: plain(issue.title), number: issue.number }));
  const open = new Map(issues.map((issue) => [issue.number, issue]));
  for (const pull of [...input.pulls].sort((a, b) => a.number - b.number)) {
    if (NOT_A_REQUEST.test(pull.title)) continue;
    const title = plain(pull.title).replace(/^(fix|feat|chore|docs|refactor|test|ci|perf|build|style)(\([^)]*\))?!?:\s*/i, '');
    const cited = [...title.matchAll(/#(\d{2,6})/g)].map((match) => open.get(Number(match[1]))).find(Boolean);
    if (cited) cited.prWords = cited.prWords ? `${cited.prWords} ${title}` : title;
  }
  for (const feature of RELATED_FEATURES) if (!isPublicRelatedUrl(feature.url)) throw new Error(`Not a public address: ${feature.url}`);
  return { features: RELATED_FEATURES, releases, issues };
}

/** One entry per line, so the release commit's diff reads as the titles that changed. */
export function serializeRelatedData(data: RelatedData): string {
  const block = (name: string, rows: unknown[]) => `  ${JSON.stringify(name)}: [\n${rows.map((row) => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]`;
  return `{\n${[block('features', data.features), block('releases', data.releases), block('issues', data.issues)].join(',\n')}\n}\n`;
}

/** Runs `gh` and returns its stdout, or throws. A seam: no test reaches a real `gh` (tests/setup/gh-tripwire.ts). */
export type GhRunner = (args: string[]) => string;

const realGh: GhRunner = (args) => {
  const run = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`gh ${args[0]} ${args[1] ?? ''}: ${run.stderr.toString().trim()}`);
  return run.stdout.toString();
};

export function readRelatedInput(gh: GhRunner, draft: ReleaseInput | null) {
  const published = gh(['api', `repos/${REPO}/releases?per_page=100`, '--paginate', '--jq', '.[] | {tag: .tag_name, draft, prerelease, body}'])
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ReleaseInput);
  const title = (kind: 'issue' | 'pr') => JSON.parse(gh([kind, 'list', '-R', REPO, '--state', 'open', '--limit', '1000', '--json', 'number,title'])) as TitleInput[];
  const releases = draft && !published.some((release) => release.tag === draft.tag) ? [draft, ...published] : published;
  return { releases, issues: title('issue'), pulls: title('pr') };
}

/** The new release's own notes, which GitHub has only after the tag: untracked in the checkout, by design. */
export function draftNotes(root: string): ReleaseInput | null {
  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  const file = join(root, `RELEASE_NOTES_v${version}.md`);
  return existsSync(file) ? { tag: `v${version}`, body: readFileSync(file, 'utf8') } : null;
}

export function writeRelatedIndex(root: string, gh: GhRunner): RelatedData {
  const data = buildRelatedData(readRelatedInput(gh, draftNotes(root)));
  // An empty answer that still exits 0 must not wipe the file in a release commit.
  if (data.releases.length < 50 || data.issues.length === 0) throw new Error(`Suspiciously little from GitHub: ${data.releases.length} release lines, ${data.issues.length} issues. Nothing written.`);
  const out = join(root, OUT_FILE);
  writeFileSync(`${out}.tmp`, serializeRelatedData(data));
  renameSync(`${out}.tmp`, out);
  return data;
}

if (import.meta.main) {
  try {
    const data = writeRelatedIndex(resolve(import.meta.dir, '..'), realGh);
    console.log(`${OUT_FILE}: ${data.features.length} features, ${data.releases.length} release lines, ${data.issues.length} open issues`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
