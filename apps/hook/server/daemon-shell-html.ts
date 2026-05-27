import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const FRONTEND_DIST = resolve(import.meta.dir, "../../frontend/dist/index.html");

export function loadDaemonShellHtml(): string {
  if (existsSync(FRONTEND_DIST)) {
    return readFileSync(FRONTEND_DIST, "utf-8");
  }
  return "<html><head><title>Plannotator</title></head><body><p>Frontend not built. Run <code>bun run --cwd apps/frontend build</code> first.</p></body></html>";
}
