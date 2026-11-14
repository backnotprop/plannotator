import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';

export const FIRST_RUN: Record<string, string> = {
  'plannotator-announce-agent-tool-seen': '1',
  'plannotator-announce-ask-session-seen': '1',
  'plannotator-announce-inbox-seen': '1',
  'plannotator-announce-tui-herdr-seen': '1',
  'plannotator-auto-viewed-notice-seen': '1',
  'plannotator-edit-mode-announcement-seen': '3',
  'plannotator-guide-hint-acked': 'true',
  'plannotator-guide-intro-seen': '2',
  'plannotator-plan-look-choice-resolved': 'true',
  'plannotator-review-dest-spotlight-seen': '1',
  'plannotator-token-hover-announcement-seen': '1',
};

export function ownPath(root: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const found = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, 'git'))
    .find((file) => {
      try {
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
  if (found) symlinkSync(found, join(bin, 'git'));
  return [bin, '/usr/bin', '/bin'].join(delimiter);
}

export function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

export function buildRepo(root: string): string {
  const repo = join(root, 'billing-api');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'checkout', '-qb', 'main');
  git(repo, 'config', 'user.email', 'dev@example.com');
  git(repo, 'config', 'user.name', 'Dev');
  writeFileSync(join(repo, 'src/billing.ts'), 'export function charge(amount: number) {\n  return stripe.charges.create({ amount });\n}\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'billing');
  git(repo, 'checkout', '-qb', 'fix/charge');
  writeFileSync(join(repo, 'src/billing.ts'), 'export function charge(amount: number) {\n  if (amount < 0) throw new Error("bad");\n  return stripe.charges.create({ amount });\n}\n');
  return repo;
}


export function liveEnv(root: string, dataDir: string): Record<string, string> {
  return {
    PATH: ownPath(root),
    HOME: root,
    PLANNOTATOR_TEST_SANDBOX: root,
    PLANNOTATOR_AI: 'disabled',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_REMOTE: '0',
  };
}
