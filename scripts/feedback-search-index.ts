#!/usr/bin/env bun
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SearchData, SearchFeature } from '../packages/inbox/feedbackSearch';

const REPO = 'backnotprop/plannotator';
const REPO_URL = `https://github.com/${REPO}`;
const DOCS = 'https://plannotator.ai/docs/reference/inbox/';
const OUT_FILE = 'packages/inbox/feedbackSearch.data.json';

export const FEATURES: SearchFeature[] = [
  { title: 'Archive', names: ['done button', 'mark done', 'mark as done', 'done state', 'finish thread', 'close thread', 'delete thread', 'remove thread', 'dismiss thread', 'trash thread', 'trash folder', 'trash button', 'trash can', 'move to trash'], definition: "In a thread's ⋯ menu. Unarchive reopens it.", url: `${DOCS}#what-you-see` },
  { title: 'Mark unread', names: ['mark unread', 'mark as unread', 'mark thread unread', 'thread as unread', 'keep unread'], definition: "On a thread's row and in its header.", url: `${REPO_URL}/releases/tag/v0.28.43` },
  { title: 'Star a thread', names: ['pin thread', 'pin message', 'star thread', 'favorite thread', 'favourite thread', 'bookmark thread'], definition: "In a thread's ⋯ menu.", url: `${DOCS}#what-you-see` },
  { title: 'Snooze a thread', names: ['snooze thread', 'snooze message', 'snooze this', 'snooze button', 'remind later', 'remind tomorrow', 'postpone thread'], definition: 'Top bar, or ⋯ menu on a phone.', url: `${REPO_URL}/releases/tag/v0.28.46` },
  { title: 'Voice', names: ['by voice', 'voice input', 'voice reply', 'use voice', 'use microphone', 'microphone input', 'microphone button', 'dictate reply', 'dictate message', 'speech to text'], definition: 'Turn on Voice in Settings, then press the mic.', url: `${REPO_URL}/releases/tag/v0.28.43` },
  { title: 'New message', names: ['compose message', 'compose new message', 'compose button', 'message first', 'message agent first', 'start new message', 'write new message', 'send new message', 'new message button'], definition: 'The pencil beside Search.', url: `${DOCS}#what-you-see` },
  { title: 'Search', names: ['search message', 'search thread', 'find thread', 'find message', 'search across thread', 'search across message', 'search all message'], definition: 'At the top of the sidebar.', url: `${DOCS}#what-you-see` },
  { title: 'Settings, Appearance', names: ['dark mode', 'light mode', 'font size', 'text size', 'change theme', 'own theme', 'own color'], definition: 'Theme, text size and colors.', url: `${DOCS}#what-you-see` },
  { title: 'Settings, Rows', names: ['compact row', 'compact list', 'rows compact', 'row density', 'list density', 'density option', 'tighter rows', 'denser list', 'smaller rows'], definition: 'Density, first line and more.', url: `${REPO_URL}/releases/tag/v0.28.47` },
  { title: 'Over your tailnet', names: ['use on phone', 'open on phone', 'inbox on phone', 'use from phone', 'reply from phone', 'open from phone', 'check from phone', 'use on mobile', 'mobile app', 'iphone app', 'android app', 'ipad app'], definition: 'Open it from your other devices.', url: `${DOCS}#over-your-tailnet` },
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
export interface ClosedIssue extends Titled {
  stateReason?: string | null;
  closedByPullRequestsReferences?: { number: number; repository?: { name: string; owner?: { login: string } } }[];
}

const SKIPPED_ISSUES = new Set([925, 956]);
const NOT_A_REQUEST = /^(chore\(deps\)|bump |dependency dashboard|pre-release manual qa)/i;
const NOT_A_FEATURE = /^(what's changed|what's new|install|new contributors|community|contributors|thanks|full changelog|plannotator( inbox)?$|plannotator\.ai$|smaller |additional |behavior changes|documentation updates|features$|ux( improvements)?$|tidy$|tl;dr$|not yet on$|v\d)/i;
const HAS_EMAIL = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;

const plain = (text: string) => text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`|\*/g, '').replace(/\s+/g, ' ').trim();
const pullTitle = (title: string) => plain(title).replace(/^(fix|feat|chore|docs|refactor|test|ci|perf|build|style)(\([^)]*\))?!?:\s*/i, '').replace(/^./, (first) => first.toUpperCase());

export function releaseTitles(body: string): string[] {
  const start = body.search(/^## What's New\b/m);
  if (start < 0) return [];
  const headings = body.slice(start).split(/^##+ +(?:Install|What's Changed)/m)[0]!.match(/^#{2,4} +.+$/gm) ?? [];
  return headings.map((heading) => plain(heading.replace(/^#+ +/, ''))).filter((title) => !NOT_A_FEATURE.test(title));
}

const version = (tag: string) => tag.replace(/^v/, '').split('.').map(Number);
const compareVersions = (a: string, b: string) => version(a).reduce((order, part, at) => order || part - version(b)[at]!, 0);
const olderFirst = (a: Release, b: Release) => compareVersions(a.tag, b.tag);
const published = (release: Release) => !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag);

export function firstReleases(releases: Release[]): Map<number, string> {
  const first = new Map<number, string>();
  for (const release of releases.filter(published).sort(olderFirst)) {
    const body = release.body ?? '';
    const linked = [...body.matchAll(/github\.com\/backnotprop\/plannotator\/(?:issues|pull)\/(\d+)/g), ...body.matchAll(/(?<![\w/&])#(\d+)\b/g)];
    for (const [, number] of linked) if (!first.has(Number(number))) first.set(Number(number), release.tag.slice(1));
  }
  return first;
}

export function fixedIn(issue: ClosedIssue, first: Map<number, string>): string | null {
  if (issue.stateReason !== 'COMPLETED') return null;
  const pulls = (issue.closedByPullRequestsReferences ?? []).filter((pull) => !pull.repository || (pull.repository.name === 'plannotator' && (pull.repository.owner?.login ?? 'backnotprop') === 'backnotprop'));
  const shipped = pulls.map((pull) => first.get(pull.number)).filter((tag): tag is string => tag !== undefined);
  if (shipped.length) return shipped.sort(compareVersions).at(-1)!;
  return first.get(issue.number) ?? null;
}

export function buildSearchData(input: { issues: Titled[]; closedIssues?: ClosedIssue[]; pulls: Titled[]; releases: Release[] }): SearchData {
  const newest = (a: Titled, b: Titled) => b.number - a.number;
  const listed = (issue: Titled) => !SKIPPED_ISSUES.has(issue.number) && !issue.labels?.some((label) => label.name === 'security');
  const first = firstReleases(input.releases);
  const links: SearchData['links'] = [
    ...[...input.issues].sort(newest).filter(listed).map((issue) => ({ title: plain(issue.title), path: `issues/${issue.number}` })),
    ...[...(input.closedIssues ?? [])]
      .sort(newest)
      .filter(listed)
      .flatMap((issue) => {
        const fixed = fixedIn(issue, first);
        return fixed ? [{ title: plain(issue.title), path: `issues/${issue.number}`, fixed }] : [];
      }),
    ...[...input.pulls].sort(newest).map((pull) => ({ title: pullTitle(pull.title), path: `pull/${pull.number}` })),
    ...input.releases
      .filter(published)
      .sort((a, b) => olderFirst(b, a))
      .flatMap((release) => releaseTitles(release.body ?? '').map((title) => ({ title, path: `releases/tag/${release.tag}` }))),
  ];
  const seen = new Set(FEATURES.map((feature) => feature.title.toLowerCase()));
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
  const data = buildSearchData({
    issues: list('issue', 'open', 'number,title,labels'),
    closedIssues: list('issue', 'closed', 'number,title,labels,stateReason,closedByPullRequestsReferences') as ClosedIssue[],
    pulls: [...list('pr', 'open', 'number,title'), ...list('pr', 'merged', 'number,title')],
    releases,
  });
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
