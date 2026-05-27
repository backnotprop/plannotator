// @ts-ignore — Bun text import for embedding frontend HTML into the compiled binary
import shellHtml from "../../frontend/dist/index.html" with { type: "text" };

export function loadDaemonShellHtml(): string {
  return shellHtml as unknown as string;
}
