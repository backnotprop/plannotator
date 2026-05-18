// TODO: Replace debug-frontend with production frontend (layer 5 in stack).
// Keep the daemon shell import separate from legacy mode HTML so direct
// non-daemon commands do not require apps/debug-frontend/dist unless the daemon starts.
// @ts-ignore - Bun import attribute for text
import shellHtml from "../../debug-frontend/dist/index.html" with { type: "text" };

export const daemonShellHtmlContent = shellHtml as unknown as string;
