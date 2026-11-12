import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number;
  out: string;
  err: string;
  timedOut: boolean;
}

export function runCommand(argv: readonly string[], opts: { cwd?: string; timeoutMs: number }): Promise<CommandResult> {
  return new Promise((resolve) => {
    const [cmd, ...rest] = argv;
    const child = spawn(cmd, rest, { cwd: opts.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { }
      finish(-1);
    }, opts.timeoutMs);
    child.stdout!.setEncoding('utf8').on('data', (d: string) => { out += d; });
    child.stderr!.setEncoding('utf8').on('data', (d: string) => { err += d; });
    child.on('error', (e) => { err += String(e); finish(-1); });
    child.on('close', (code) => finish(code ?? -1));
  });
}
