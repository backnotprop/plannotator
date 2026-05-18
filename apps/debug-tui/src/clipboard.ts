import { spawn } from "node:child_process";

export interface ClipboardResult {
  ok: boolean;
  message: string;
}

interface ClipboardCommand {
  command: string;
  args: string[];
}

export function clipboardCandidates(platform: NodeJS.Platform = process.platform): ClipboardCommand[] {
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (platform === "win32") return [{ command: "cmd", args: ["/c", "clip"] }];
  return [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
}

export async function copyTextToClipboard(text: string): Promise<ClipboardResult> {
  if (!text) return { ok: false, message: "Nothing to copy." };

  const errors: string[] = [];
  for (const candidate of clipboardCandidates()) {
    const result = await runClipboardCommand(candidate, text);
    if (result.ok) return { ok: true, message: "Copied to clipboard." };
    errors.push(result.message);
  }

  return {
    ok: false,
    message: `Clipboard copy failed: ${errors.filter(Boolean).join("; ") || "no clipboard command found"}`,
  };
}

function runClipboardCommand(candidate: ClipboardCommand, text: string): Promise<ClipboardResult> {
  return new Promise((resolve) => {
    const child = spawn(candidate.command, candidate.args, {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;

    const settle = (result: ClipboardResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      settle({
        ok: false,
        message: err.code === "ENOENT" ? `${candidate.command} not found` : err.message,
      });
    });
    child.on("close", (code) => {
      settle({
        ok: code === 0,
        message: code === 0 ? "copied" : `${candidate.command} exited ${code}: ${stderr.trim()}`,
      });
    });
    child.stdin.end(text);
  });
}
