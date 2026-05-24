/**
 * Code navigation — Bun runtime adapter and request handler.
 */

import {
  type CodeNavRequest,
  type CodeNavRuntime,
  type CodeNavResponse,
  resolveCodeNav,
  validateCodeNavRequest,
  extractChangedFiles,
} from "@plannotator/shared/code-nav";

export type { CodeNavRequest, CodeNavResponse };

const bunCodeNavRuntime: CodeNavRuntime = {
  async runCommand(command, args, options) {
    let proc;
    try {
      proc = Bun.spawn([command, ...args], {
        cwd: options?.cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      return { stdout: "", stderr: "command not found", exitCode: 1 };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options?.timeoutMs) {
      timer = setTimeout(() => proc.kill(), options.timeoutMs);
    }

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (timer) clearTimeout(timer);
    return { stdout, stderr, exitCode };
  },
};

export async function handleCodeNavResolve(
  req: Request,
  cwd: string,
  changedFiles: string[],
): Promise<Response> {
  try {
    const body = (await req.json()) as CodeNavRequest;
    const error = validateCodeNavRequest(body);
    if (error) {
      return Response.json({ error }, { status: 400 });
    }

    const result = await resolveCodeNav(
      bunCodeNavRuntime,
      body,
      cwd,
      changedFiles,
    );

    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Code navigation failed" },
      { status: 500 },
    );
  }
}

export { extractChangedFiles };
