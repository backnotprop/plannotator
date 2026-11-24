/**
 * Whether the Codex wake may read a Codex home's rollouts and hooks file (inbox-codex-steer.ts). Always, except under
 * the test sandbox (PLANNOTATOR_TEST_SANDBOX): there both the home and the Codex home must be scratch folders under the
 * temp folder, so a test can never reach the person's real ~/.codex, even with a CODEX_HOME left pointing at it.
 */

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { agentHomeAllowed, codexHome, type AgentEnvironment } from "./inbox-agents";

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const underTemp = (path: string): boolean => {
  const forms = [path, real(path)];
  const roots = [tmpdir(), "/tmp", "/private/tmp"].flatMap((root) => [root, real(root)]).map((root) => root.replace(/[\\/]+$/, ""));
  return forms.some((form) => roots.some((base) => form.startsWith(`${base}${sep}`) || form.startsWith(`${base}/`)));
};

export function codexSteerAllowed(environment: AgentEnvironment): boolean {
  if (!agentHomeAllowed(environment)) return false;
  if (!environment.env.PLANNOTATOR_TEST_SANDBOX && !process.env.PLANNOTATOR_TEST_SANDBOX) return true;
  return underTemp(codexHome(environment));
}
