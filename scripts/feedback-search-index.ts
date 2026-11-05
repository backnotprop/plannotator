#!/usr/bin/env bun
/**
 * Writes packages/inbox/feedbackSearch.data.json, what the Feedback form's "These
 * might help" searches. The owner runs it while preparing a release, with `gh`
 * logged in (.agents/skills/release/SKILL.md). CI and the builds never run it.
 *
 * Reads, read-only, from the public repo: open issue titles, open and merged PR
 * titles, and published release notes (the new release's come from
 * RELEASE_NOTES_v<version>.md in the checkout). Never a draft release, because
 * the logged in owner can see drafts that nobody else can.
 *
 *   bun scripts/feedback-search-index.ts
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SearchData, SearchFeature } from '../packages/inbox/feedbackSearch';

const REPO = 'backnotprop/plannotator';
const REPO_URL = `https://github.com/${REPO}`;
const DOCS = 'https://plannotator.ai/docs/reference/inbox/';
const OUT_FILE = 'packages/inbox/feedbackSearch.data.json';

/** By hand: the features people ask for by another name ("done button" for Archive). Check each against the product when you add one. */
export const FEATURES: SearchFeature[] = [
  { title: 'Archive', names: ['done button', 'mark done', 'mark as done', 'done state', 'finish thread', 'close thread', 'delete thread', 'remove thread', 'dismiss thread', 'trash thread', 'trash folder', 'trash button', 'trash can', 'move to trash'], definition: "In a thread's ⋯ menu. Unarchive reopens it.", url: `${DOCS}#what-you-see` },
  { title: 'Mark unread', names: ['mark unread', 'mark as unread', 'mark thread unread', 'thread as unread', 'keep unread'], definition: "On a thread's row and in its header.", url: `${REPO_URL}/releases/tag/v0.28.43` },
  { title: 'Pin a thread', names: ['pin thread', 'pin message', 'star thread', 'favorite thread', 'favourite thread', 'bookmark thread'], definition: "In a thread's ⋯ menu.", url: `${DOCS}#what-you-see` },
  { title: 'Snooze a thread', names: ['snooze thread', 'snooze message', 'snooze this', 'snooze button', 'remind me later', 'remind me tomorrow', 'postpone thread'], definition: 'Top bar, or ⋯ menu on a phone.', url: `${REPO_URL}/releases/tag/v0.28.46` },
  { title: 'Voice', names: ['by voice', 'voice input', 'voice reply', 'use voice', 'use microphone', 'microphone input', 'microphone button', 'dictate reply', 'dictate message', 'speech to text'], definition: 'Turn on Voice in Settings, then press the mic.', url: `${REPO_URL}/releases/tag/v0.28.43` },
  { title: 'New message', names: ['compose message', 'compose new message', 'compose button', 'write first', 'write to agent first', 'start new message', 'write new message', 'send new message', 'new message button'], definition: 'The pencil beside Search.', url: `${DOCS}#what-you-see` },
  { title: 'Search', names: ['search message', 'search thread', 'find thread', 'find message', 'search across thread', 'search across message', 'search all message'], definition: 'At the top of the sidebar.', url: `${DOCS}#what-you-see` },
  { title: 'Settings, Appearance', names: ['dark mode', 'light mode', 'font size', 'text size', 'change theme', 'own theme', 'own color'], definition: 'Theme, text size and colors.', url: `${DOCS}#what-you-see` },
  { title: 'Settings, Rows', names: ['compact row', 'compact list', 'rows compact', 'row density', 'list density', 'density option', 'rows feel cramped', 'list too cramped', 'row too cramped'], definition: 'Density, first line and more.', url: `${REPO_URL}/releases/tag/v0.28.47` },
  { title: 'Over your tailnet', names: ['use on my phone', 'use on phone', 'open on my phone', 'inbox on my phone', 'use from my phone', 'reply from my phone', 'open from my phone', 'check from my phone', 'use on mobile', 'mobile app', 'iphone app', 'android app', 'ipad app'], definition: 'Open it from your other devices.', url: `${DOCS}#over-your-tailnet` },
];

export interface Release {
  tag: string;
  draft?: boolean;
  prerelease?: boolean;
  body: string | null;
}
export interface Titled {
  number: number;
  title: string;
  labels?: { name: string }[];
}

/** #956: a security report. #925: a question, not a known problem. */
const SKIPPED_ISSUES = new Set([925, 956]);
/** Bots and trackers. */
const NOT_A_REQUEST = /^(chore\(deps\)|bump |dependency dashboard|pre-release manual qa)/i;
/** Sections of release notes that are people or install steps. */
const NOT_A_FEATURE = /^(what's changed|what's new|install|new contributors|community|contributors|thanks|full changelog|plannotator( inbox)?$|plannotator\.ai$|smaller |additional |behavior changes|documentation updates|features$|ux( improvements)?$|tidy$|v\d)/i;
const HAS_EMAIL = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;

const plain = (text: string) => text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`|\*/g, '').replace(/\s+/g, ' ').trim();
const pullTitle = (title: string) => plain(title).replace(/^(fix|feat|chore|docs|refactor|test|ci|perf|build|style)(\([^)]*\))?!?:\s*/i, '').replace(/^./, (first) => first.toUpperCase());

/** The headings under "What's New" in one release's notes. */
export function releaseTitles(body: string): string[] {
  const start = body.search(/^## What's New\b/m);
  if (start < 0) return [];
  const headings = body.slice(start).split(/^##+ +(?:Install|What's Changed)/m)[0]!.match(/^#{2,4} +.+$/gm) ?? [];
  return headings.map((heading) => plain(heading.replace(/^#+ +/, ''))).filter((title) => !NOT_A_FEATURE.test(title));
}

/** Issues, then PRs, then release notes, each newest first; a title twice stays once. */
export function buildSearchData(input: { issues: Titled[]; pulls: Titled[]; releases: Release[] }): SearchData {
  const newest = (a: Titled, b: Titled) => b.number - a.number;
  const version = (tag: string) => tag.replace(/^v/, '').split('.').map(Number);
  const links = [
    ...[...input.issues].sort(newest).filter((issue) => !SKIPPED_ISSUES.has(issue.number) && !issue.labels?.some((label) => label.name === 'security')).map((issue) => ({ title: plain(issue.title), path: `issues/${issue.number}` })),
    ...[...input.pulls].sort(newest).map((pull) => ({ title: pullTitle(pull.title), path: `pull/${pull.number}` })),
    ...input.releases
      .filter((release) => !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag))
      .sort((a, b) => version(b.tag).reduce((order, part, at) => order || part - version(a.tag)[at]!, 0))
      .flatMap((release) => releaseTitles(release.body ?? '').map((title) => ({ title, path: `releases/tag/${release.tag}` }))),
  ];
  const seen = new Set<string>();
  return {
    features: FEATURES,
    links: links.filter(({ title }) => {
      const key = title.toLowerCase();
      if (!title || seen.has(key) || NOT_A_REQUEST.test(title) || HAS_EMAIL.test(title)) return false;
      seen.add(key);
      return true;
    }),
  };
}

export type Gh = (args: string[]) => string;

const realGh: Gh = (args) => {
  const run = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`gh ${args[0]}: ${run.stderr.toString().trim()}`);
  return run.stdout.toString();
};

export function writeSearchIndex(root: string, gh: Gh): SearchData {
  const list = (kind: string, state: string, fields: string) => JSON.parse(gh([kind, 'list', '-R', REPO, '--state', state, '--limit', '10000', '--json', fields])) as Titled[];
  const releases = gh(['api', `repos/${REPO}/releases?per_page=100`, '--paginate', '--jq', '.[] | {tag: .tag_name, draft, prerelease, body}'])
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Release);
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  const notes = join(root, `RELEASE_NOTES_v${version}.md`);
  if (existsSync(notes) && !releases.some((release) => release.tag === `v${version}`)) releases.unshift({ tag: `v${version}`, body: readFileSync(notes, 'utf8') });
  const data = buildSearchData({ issues: list('issue', 'open', 'number,title,labels'), pulls: [...list('pr', 'open', 'number,title'), ...list('pr', 'merged', 'number,title')], releases });
  if (!data.links.length) throw new Error('Nothing from GitHub: the file stays as it is.');
  const out = join(root, OUT_FILE);
  const block = (name: string, rows: unknown[]) => `  ${JSON.stringify(name)}: [\n${rows.map((row) => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]`;
  writeFileSync(`${out}.tmp`, `{\n${block('features', data.features)},\n${block('links', data.links)}\n}\n`);
  renameSync(`${out}.tmp`, out);
  return data;
}

if (import.meta.main) {
  const data = writeSearchIndex(resolve(import.meta.dir, '..'), realGh);
  console.log(`${OUT_FILE}: ${data.features.length} features, ${data.links.length} links`);
}
