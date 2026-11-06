import { execFile } from 'node:child_process';

/** Run one read-only git command in `root` and return its stdout. Rejects with git's own message. */
export function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', root, ...args],
      // the live environment, never the one the process started with
      { env: process.env, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]}: ${String(stderr || err.message).trim()}`));
        else resolve(stdout);
      },
    );
  });
}
