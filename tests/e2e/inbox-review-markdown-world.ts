/**
 * The world of inbox-review-markdown.spec.ts: inbox-review-images-world.ts's
 * scratch Inbox (compiled binary, its own HOME and data folder, a fake `gh`),
 * with a teammate's pull request that rewrites the README (it shows a picture
 * the PR changes and one it does not) and edits an SVG, and an agent's guided
 * review of the same real `git diff`. Every name is invented.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { scratchProject } from '../../scripts/inbox-sim';
import { git, picture, startPullWorld, type ImagesWorld, type Rgb } from './inbox-review-images-world';

export const README = 'README.md';
export const SVG = 'assets/mark.svg';
export const CHART = 'assets/dashboard.png';

const PAPER: Rgb = [246, 244, 238];
const INK: Rgb = [52, 64, 84];
const BLUE: Rgb = [59, 110, 214];
const ORANGE: Rgb = [232, 128, 52];
const bars = (heights: number[], color: Rgb) => heights.map((h, i) => ({ x: 30 + i * 44, y: 150 - h, w: 28, h, color }));
const axis = [
  { x: 20, y: 14, w: 3, h: 140, color: INK },
  { x: 20, y: 151, w: 240, h: 3, color: INK },
];
const CHART_BEFORE = picture(280, 170, PAPER, [...axis, ...bars([40, 70, 90, 60, 100], BLUE)]);
const CHART_AFTER = picture(280, 170, PAPER, [...axis, ...bars([40, 80, 110, 60, 125], BLUE), { x: 196, y: 16, w: 60, h: 14, color: ORANGE }]);
const LOGO = picture(96, 96, [255, 255, 255], [{ x: 12, y: 12, w: 72, h: 72, color: INK }, { x: 36, y: 36, w: 24, h: 24, color: ORANGE }]);

const README_BEFORE = `# Web app

The dashboard shows last quarter's sales.

## Pictures

![The dashboard](assets/dashboard.png)

- Bars per region
- One colour per year
`;

const README_AFTER = `# Web app

The dashboard shows this quarter's sales, with a legend.

![Logo](/assets/logo.png)

## Pictures

![The dashboard](assets/dashboard.png)

- Bars per region
- One colour per year
- A legend in the corner

## Running it

Run \`bun dev\` and open the page.
`;

const svg = (fill: string, ring: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">\n  <rect width="120" height="120" rx="24" fill="${fill}"/>\n  <circle cx="60" cy="60" r="30" fill="none" stroke="${ring}" stroke-width="10"/>\n</svg>\n`;

function change(parent: string): { project: string; patch: string; head: string; base: string } {
  const project = scratchProject(parent, 'web-app');
  mkdirSync(join(project, 'assets'), { recursive: true });
  writeFileSync(join(project, README), README_BEFORE);
  writeFileSync(join(project, CHART), CHART_BEFORE);
  writeFileSync(join(project, 'assets/logo.png'), LOGO);
  writeFileSync(join(project, SVG), svg('#3b6ed6', '#ffffff'));
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'base');
  writeFileSync(join(project, README), README_AFTER);
  writeFileSync(join(project, CHART), CHART_AFTER);
  writeFileSync(join(project, SVG), svg('#e88034', '#344054'));
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'the change');
  git(project, 'remote', 'add', 'origin', 'https://github.com/northwind/web-app.git');
  return { project, patch: git(project, 'diff', '--no-renames', 'HEAD~1', 'HEAD'), head: git(project, 'rev-parse', 'HEAD').trim(), base: git(project, 'rev-parse', 'HEAD~1').trim() };
}

const GUIDE = {
  title: 'Rewrite the README',
  intent: 'The README says what the dashboard shows now, and the mark gets the new colours.',
  sections: [
    { title: 'The README', overview: 'New words, a logo and a section on running it.', diffs: [{ file: README, summary: 'The new README.' }, { file: CHART, summary: 'The chart it shows.' }] },
    { title: 'The mark', overview: 'New colours.', diffs: [{ file: SVG, summary: 'Orange now.' }] },
  ],
};

export function startMarkdownWorld(browser: Browser): Promise<ImagesWorld> {
  return startPullWorld(browser, 'plannotator-review-markdown-e2e-', change, GUIDE, 'The README to read.');
}

export { openPull, openReview, stopWorld, windowAt } from './inbox-review-images-world';
