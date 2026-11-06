import { execFile } from 'node:child_process';

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Run one read-only git command in `root` and return its stdout as bytes. Rejects with git's own message. */
export function gitBytes(root: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', root, ...args],
      // the live environment, never the one the process started with
      { env: process.env, maxBuffer, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]}: ${String(stderr?.length ? stderr : err.message).trim()}`));
        else resolve(stdout);
      },
    );
  });
}

/** Text as UTF-8, or null when it is not. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

/** Run one read-only git command in `root` and return its stdout as UTF-8 text. */
export async function git(root: string, args: string[]): Promise<string> {
  const text = decodeUtf8(await gitBytes(root, args));
  if (text == null) throw new Error(`git ${args[0]}: the output is not UTF-8`);
  return text;
}

/** A ref or commit given by a caller, refused when git could read it as an option. */
export function checkRef(ref: string): string {
  if (!ref || ref.startsWith('-') || /[\s\0]/.test(ref)) throw new Error(`"${ref}" is not a git ref`);
  return ref;
}

/** The commit a ref names in `root`, or null when the repo does not have it. */
export async function resolveCommit(root: string, ref: string): Promise<string | null> {
  try {
    return (await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${checkRef(ref)}^{commit}`])).trim() || null;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('"')) throw e;
    return null;
  }
}

/** True when `root` is inside a git work tree. */
export async function isGitRepo(root: string): Promise<boolean> {
  try {
    return (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

export type TreeEntry = { mode: string; type: string; size: number | null };

/** Every path in the tree of `commit` under `prefix` (or the whole tree), folders included, with its mode. */
export async function lsTree(root: string, commit: string, prefix?: string): Promise<Map<string, TreeEntry>> {
  const args = ['ls-tree', '-r', '-t', '-l', '-z', '--full-tree', commit];
  if (prefix) args.push('--', prefix);
  const out = await git(root, args);
  const tree = new Map<string, TreeEntry>();
  for (const line of out.split('\0')) {
    if (!line) continue;
    // <mode> SP <type> SP <object> SP+ <size> TAB <path>
    const tab = line.indexOf('\t');
    const [mode, type, , size] = line.slice(0, tab).split(/ +/);
    tree.set(line.slice(tab + 1), { mode: mode!, type: type!, size: size === '-' || size == null ? null : Number(size) });
  }
  return tree;
}
