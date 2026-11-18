/**
 * The agents' marks for the native iPhone app: the product's own icon files
 * (.github/assets/icons, the ones the README and the marketing site's Inbox
 * show), copied into an Xcode asset catalog so the app never draws its own.
 *
 *   bun scripts/mobile/agent-marks.ts [--check]
 *
 * One image set per agent, named by its id in INBOX_AGENT_LABELS
 * (`agent-claude-code`), so Swift finds a mark by the id the wire carries. An
 * agent with no icon here keeps its letter in the app. Every path is a
 * literal: nothing lists a folder. `--check` fails when a committed file
 * differs from its source.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const ICONS = '.github/assets/icons';
const CATALOG = 'apps/mobile/ios/App/AgentMarks.xcassets';

/** Agent id → its icon: one file, or one per appearance (`light` is drawn on a light ground). */
const MARKS: Record<string, { any: string } | { light: string; dark: string }> = {
  'claude-code': { any: 'claude.svg' },
  codex: { any: 'codex.png' },
  gemini: { any: 'gemini.png' },
  amp: { any: 'amp.svg' },
  kiro: { any: 'kiro.svg' },
  opencode: { light: 'opencode-light.svg', dark: 'opencode-dark.svg' },
  pi: { light: 'pi-light.svg', dark: 'pi-dark.svg' },
};

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const dark = [{ appearance: 'luminosity', value: 'dark' }];

type Output = { path: string; bytes: Uint8Array };

function outputs(): Output[] {
  const text = (path: string, value: string): Output => ({ path, bytes: new TextEncoder().encode(value) });
  const out: Output[] = [text(`${CATALOG}/Contents.json`, json({ info: { author: 'xcode', version: 1 } }))];
  for (const [agent, mark] of Object.entries(MARKS)) {
    const set = `${CATALOG}/agent-${agent}.imageset`;
    const files = 'any' in mark ? [{ file: mark.any }] : [{ file: mark.light }, { file: mark.dark, appearances: dark }];
    for (const { file } of files) out.push({ path: `${set}/${file}`, bytes: readFileSync(join(ROOT, ICONS, file)) });
    out.push(
      text(
        `${set}/Contents.json`,
        json({
          images: files.map(({ file, appearances }) => ({ filename: file, idiom: 'universal', ...(appearances ? { appearances } : {}) })),
          info: { author: 'xcode', version: 1 },
          properties: { 'preserves-vector-representation': true },
        }),
      ),
    );
  }
  return out;
}

const check = process.argv.includes('--check');
const stale: string[] = [];
for (const { path, bytes } of outputs()) {
  const file = join(ROOT, path);
  const same = existsSync(file) && Buffer.compare(readFileSync(file), bytes) === 0;
  if (same) continue;
  if (check) stale.push(path);
  else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    console.log(`wrote ${path}`);
  }
}
if (stale.length) {
  console.error(`agent-marks: stale (run bun scripts/mobile/agent-marks.ts):\n  ${stale.join('\n  ')}`);
  process.exit(1);
}
if (check) console.log('agent-marks: up to date');
