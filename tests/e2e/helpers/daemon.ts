import { spawn, type ChildProcess } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const bunExecutable = Bun.which('bun') ?? 'bun';

const HOOK_ENTRY_REL = 'apps/hook/server/index.ts';

let cachedBinaryPromise: Promise<string> | undefined;

function isPlannotatorDependencyRoot(candidate: string): boolean {
  if (!existsSync(join(candidate, 'node_modules'))) {
    return false;
  }
  const packageJsonPath = join(candidate, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return false;
  }
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: string };
    return pkg.name === 'plannotator';
  } catch {
    return false;
  }
}

function tryResolveFromGitFile(): string | null {
  // In git worktrees, .git is a file (not a directory) containing:
  //   gitdir: /path/to/repo/.git/worktrees/<branch>
  // From that we can derive the actual repo root.
  const dotGitPath = join(repoRoot, '.git');
  if (!existsSync(dotGitPath)) {
    return null;
  }
  const stat = statSync(dotGitPath);
  if (stat.isDirectory()) {
    return null; // Not a worktree
  }
  try {
    const content = readFileSync(dotGitPath, 'utf8').trim();
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match) {
      return null;
    }
    const gitdir = match[1].trim();
    // gitdir like /path/to/repo/.git/worktrees/<branch> → repo root is /path/to/repo
    const worktreesIdx = gitdir.indexOf(`${sep}.git${sep}worktrees${sep}`);
    if (worktreesIdx !== -1) {
      const repoRootCandidate = gitdir.substring(0, worktreesIdx);
      if (isPlannotatorDependencyRoot(repoRootCandidate)) {
        return repoRootCandidate;
      }
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

function resolveDependencyRoot(): string {
  if (isPlannotatorDependencyRoot(repoRoot)) {
    return repoRoot;
  }

  // Try resolving from .git worktree file (handles opencode worktree paths)
  const fromGitFile = tryResolveFromGitFile();
  if (fromGitFile) {
    return fromGitFile;
  }

  // Convention: /<parent>/<repo>_worktrees/<branch>/ — peel off the worktree
  // suffix to find the original checkout, which holds the installed deps.
  const trimmed = repoRoot.replace(new RegExp(`${sep === '\\' ? '\\\\' : sep}$`), '');
  const segments = trimmed.split(sep);
  if (segments.length >= 2) {
    const parent = segments[segments.length - 2];
    if (parent.endsWith('_worktrees')) {
      const projectName = parent.slice(0, -'_worktrees'.length);
      const projectPath = `${segments.slice(0, -2).join(sep)}${sep}${projectName}`;
      if (isPlannotatorDependencyRoot(projectPath)) {
        return projectPath;
      }
    }
  }

  let current = repoRoot;
  for (let depth = 0; depth < 5; depth += 1) {
    const parent = resolve(current, '..');
    if (parent === current) {
      break;
    }
    if (isPlannotatorDependencyRoot(parent)) {
      return parent;
    }
    current = parent;
  }

  throw new Error(
    `Could not locate plannotator workspace dependencies. Run \`bun install\` in the project root before running e2e tests.`,
  );
}

function symlinkWorkspaceNodeModules(
  dependencyRoot: string,
  workspaceRoot: string,
  workspaceDirs: string[],
): void {
  for (const dir of workspaceDirs) {
    const source = join(dependencyRoot, dir, 'node_modules');
    if (!existsSync(source)) {
      continue;
    }
    const destinationParent = join(workspaceRoot, dir);
    if (!existsSync(destinationParent)) {
      continue;
    }
    const destination = join(destinationParent, 'node_modules');
    if (existsSync(destination)) {
      continue;
    }
    symlinkSync(source, destination, 'dir');
  }
}

function createBuildWorkspace(): string {
  const dependencyRoot = resolveDependencyRoot();
  const baseDir = mkdtempSync(join(tmpdir(), 'plannotator-e2e-build-'));
  const workspaceRoot = join(baseDir, 'workspace');

  cpSync(repoRoot, workspaceRoot, {
    recursive: true,
    filter(source) {
      const rel = relative(repoRoot, source);
      if (!rel) {
        return true;
      }
      if (rel === '.git' || rel.startsWith(`.git${sep}`)) {
        return false;
      }
      const segments = rel.split(/[\\/]/);
      return !segments.includes('node_modules');
    },
  });

  symlinkSync(
    join(dependencyRoot, 'node_modules'),
    join(workspaceRoot, 'node_modules'),
    'dir',
  );

  const workspaceAppsDirs = [
    'apps/hook',
    'apps/review',
    'apps/opencode-plugin',
    'apps/vscode-extension',
  ];
  symlinkWorkspaceNodeModules(dependencyRoot, workspaceRoot, workspaceAppsDirs);

  const packagesDirs = [
    'packages/server',
    'packages/ui',
    'packages/editor',
    'packages/review-editor',
    'packages/shared',
  ];
  symlinkWorkspaceNodeModules(dependencyRoot, workspaceRoot, packagesDirs);

  return workspaceRoot;
}

type RunResult = { exitCode: number; stdout: string; stderr: string };

function runShell(
  command: string[],
  opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    description: string;
  },
): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timeout = opts.timeoutMs ?? 240_000;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(
        new Error(
          `Timed out after ${timeout}ms running ${opts.description}.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        ),
      );
    }, timeout);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveRun({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

export async function buildBinary(): Promise<string> {
  if (!cachedBinaryPromise) {
    cachedBinaryPromise = (async () => {
      const workspaceRoot = createBuildWorkspace();

      const buildHook = await runShell([bunExecutable, 'run', 'build:hook'], {
        cwd: workspaceRoot,
        description: 'bun run build:hook (e2e sandbox)',
        timeoutMs: 240_000,
      });
      if (buildHook.exitCode !== 0) {
        throw new Error(
          `bun run build:hook failed (exit ${buildHook.exitCode}).\n--- stdout ---\n${buildHook.stdout}\n--- stderr ---\n${buildHook.stderr}`,
        );
      }

      const binaryPath = join(workspaceRoot, 'plannotator');
      const compile = await runShell(
        [bunExecutable, 'build', HOOK_ENTRY_REL, '--compile', '--outfile', binaryPath],
        {
          cwd: workspaceRoot,
          description: `bun build --compile ${HOOK_ENTRY_REL}`,
          timeoutMs: 240_000,
        },
      );
      if (compile.exitCode !== 0) {
        throw new Error(
          `bun build --compile failed (exit ${compile.exitCode}).\n--- stdout ---\n${compile.stdout}\n--- stderr ---\n${compile.stderr}`,
        );
      }
      if (!existsSync(binaryPath)) {
        throw new Error(
          `bun build --compile reported success but ${binaryPath} is missing.`,
        );
      }
      const stat = statSync(binaryPath);
      if (!stat.isFile() || stat.size < 1_000_000) {
        throw new Error(
          `Compiled binary at ${binaryPath} looks invalid (size=${stat.size}).`,
        );
      }
      return binaryPath;
    })().catch((err) => {
      cachedBinaryPromise = undefined;
      throw err;
    });
  }
  return cachedBinaryPromise;
}

export async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolveOk, rejectErr) => {
        const socket = connect({ host: '127.0.0.1', port });
        socket.once('connect', () => {
          socket.end();
          resolveOk();
        });
        socket.once('error', (err) => {
          socket.destroy();
          rejectErr(err);
        });
      });
      return;
    } catch (err) {
      lastError = err as Error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(
    `Port ${port} not connectable within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}.`,
  );
}

export async function getDaemonStatus(
  port: number,
): Promise<{ status: string } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { status?: string };
    if (typeof body.status !== 'string') {
      return null;
    }
    return { status: body.status };
  } catch {
    return null;
  }
}

export type DaemonHandle = {
  pid: number;
  stop(): Promise<void>;
};

// Module-level registry so sandbox.cleanup() can kill any orphaned daemon processes.
const _activeDaemonProcesses = new Set<ChildProcess>();

export function killAllDaemons(): void {
  for (const child of _activeDaemonProcesses) {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
  _activeDaemonProcesses.clear();
}

export async function startDaemon(opts: {
  port: number;
  home: string;
  binary: string;
}): Promise<DaemonHandle> {
  const { port, home, binary } = opts;
  if (!existsSync(binary)) {
    throw new Error(`startDaemon: binary path does not exist: ${binary}`);
  }
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true });
  }

  const child = spawn(binary, ['daemon', 'start', '--foreground'], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      PLANNOTATOR_PORT: String(port),
      PLANNOTATOR_BROWSER:
        process.env.PLANNOTATOR_BROWSER ?? Bun.which('true') ?? '/usr/bin/true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  _activeDaemonProcesses.add(child);

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuf += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderrBuf += chunk;
  });

  let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.once('close', (code, signal) => {
    _activeDaemonProcesses.delete(child);
    earlyExit = { code, signal };
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (earlyExit) {
      throw new Error(
        `daemon exited early (code=${earlyExit.code} signal=${earlyExit.signal}).\n--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}`,
      );
    }
    const status = await getDaemonStatus(port);
    if (status) {
      const pid = child.pid ?? -1;
      return {
        pid,
        async stop() {
          if (child.exitCode !== null || child.signalCode !== null) {
            _activeDaemonProcesses.delete(child);
            return;
          }
          try {
            child.kill('SIGTERM');
          } catch {}
          await new Promise<void>((resolveStop) => {
            const t = setTimeout(() => {
              try {
                child.kill('SIGKILL');
              } catch {}
              _activeDaemonProcesses.delete(child);
              resolveStop();
            }, 5_000);
            child.once('close', () => {
              clearTimeout(t);
              _activeDaemonProcesses.delete(child);
              resolveStop();
            });
          });
        },
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    child.kill('SIGKILL');
  } catch {}
  _activeDaemonProcesses.delete(child);
  throw new Error(
    `daemon did not become ready on port ${port} within 15s.\n--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}`,
  );
}
