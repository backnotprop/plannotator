// Production frontend is statically imported — bundled into the compiled binary.
// @ts-ignore - Bun import attribute for text
import productionHtml from "../../frontend/dist/index.html" with { type: "text" };

// Debug frontend is read from disk at runtime when PLANNOTATOR_DEBUG_SHELL=1.
// Never bundled in production. Only works in dev when debug-frontend is built.
export async function loadDaemonShellHtml(): Promise<string> {
  if (process.env.PLANNOTATOR_DEBUG_SHELL === "1") {
    try {
      const debugPath = new URL("../../debug-frontend/dist/index.html", import.meta.url).pathname;
      return await Bun.file(debugPath).text();
    } catch {}
  }
  return productionHtml as unknown as string;
}
