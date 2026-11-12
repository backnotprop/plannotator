import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

function isExecutable(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function resolveNoBrowser(): string {
  if (process.platform === "win32") {
    const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    const whoami = join(root, "System32", "whoami.exe");
    if (isExecutable(whoami)) return whoami;
    throw new Error(`tests/helpers/no-browser.ts: ${whoami} not found; no no-op program to give PLANNOTATOR_BROWSER.`);
  }
  for (const candidate of ["/usr/bin/true", "/bin/true"]) {
    if (isExecutable(candidate)) return candidate;
  }
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!entry || !entry.startsWith("/")) continue;
    const candidate = join(entry, "true");
    if (isExecutable(candidate)) return candidate;
  }
  throw new Error("tests/helpers/no-browser.ts: no `true` executable found; no no-op program to give PLANNOTATOR_BROWSER.");
}

export const NO_BROWSER: string = resolveNoBrowser();
