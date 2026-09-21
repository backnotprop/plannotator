/**
 * Code navigation — Bun runtime adapter and request handler.
 */

import {
  type CodeNavRequest,
  type CodeNavRuntime,
  type CodeNavResponse,
  type CodeNavHoverResponse,
  CODE_NAV_MAX_FILE_BYTES,
  resolveCodeNav,
  resolveCodeNavHover,
  validateCodeNavRequest,
  extractChangedFiles,
} from "@plannotator/shared/code-nav";

export type { CodeNavRequest, CodeNavResponse, CodeNavHoverResponse };

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

  async readFile(path, options) {
    try {
      const file = Bun.file(options?.cwd ? `${options.cwd}/${path}` : path);
      // Check the size before pulling bytes: rg would not have searched a
      // file this large either.
      if (file.size > CODE_NAV_MAX_FILE_BYTES) return null;
      return await file.text();
    } catch {
      return null;
    }
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

/**
 * Hover card resolution. A separate handler from {@link handleCodeNavResolve}
 * on purpose: the two answer different shapes, and Cmd+click's handler stays
 * untouched by construction.
 */
export async function handleCodeNavHover(
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

    const result = await resolveCodeNavHover(
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
