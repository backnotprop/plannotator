// The file tree demo. Dev only: `bun run dev:file-tree-demo` from the repo root.
// Never built into the binary, a plugin or a package (it has no build script).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const repoRoot = path.resolve(__dirname, '../..');

function git(args: string[]): string[] {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** GET /__demo/repo-files: this repo's tracked files, a few untracked ones, and `git status`. */
function repoFiles(): Plugin {
  return {
    name: 'file-tree-demo-repo-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/__demo/repo-files') return next();
        const tracked = git(['-c', 'core.quotePath=false', 'ls-files']);
        const untracked = git(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard']).slice(0, 20);
        const status = git(['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '--no-renames']).map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ tracked, untracked, status }));
      });
    },
  };
}

export default defineConfig({
  root: __dirname,
  server: { port: 5317, strictPort: true, host: '127.0.0.1' },
  plugins: [repoFiles(), tailwindcss()],
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@plannotator/ui': path.resolve(repoRoot, 'packages/ui'),
    },
  },
});
