// @ts-ignore — Bun text import; embedded in compiled binary at build time
import shellHtml from "../../frontend/dist/index.html" with { type: "text" };

export function loadDaemonShellHtml(): string {
  return shellHtml as unknown as string;
}
