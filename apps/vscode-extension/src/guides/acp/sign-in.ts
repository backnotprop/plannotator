import type { AdapterResolution, AgentDescriptor, LoginCommand } from "@plannotator/acp-client/agents";
import { planSpawn } from "@plannotator/acp-client/spawn-plan";
import { findExecutable } from "../sources/runner";

export type SignInPlan =
  | { ok: true; command: string; args: string[]; env: Record<string, string> }
  | { ok: false; message: string };

export function planSignIn(
  agent: AgentDescriptor,
  launch: AdapterResolution,
  login: LoginCommand | undefined,
  deps: { find?: (name: string) => string | null; spawnPlan?: typeof planSpawn } = {},
): SignInPlan {
  const find = deps.find ?? findExecutable;
  let command: string;
  let args: string[];
  if (login && launch.ok) {
    command = launch.command;
    args = [...launch.args, ...login.args];
  } else {
    const fallback = agent.signIn;
    const found = fallback ? (fallback.command ? find(fallback.command) : launch.ok ? launch.command : null) : null;
    if (!fallback || !found) {
      const shown = fallback ? [fallback.command ?? agent.command, ...fallback.args].join(" ") : "";
      return { ok: false, message: fallback ? `Run \`${shown}\` in a terminal to sign in, then resume the guide.` : `Sign in to ${agent.label} in a terminal (see ${agent.docsUrl}), then resume the guide.` };
    }
    command = found;
    args = [...fallback.args];
  }
  let plan;
  try {
    plan = (deps.spawnPlan ?? planSpawn)(command, args);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, command: plan.command, args: plan.args, env: { ...plan.env, ...(launch.ok && login ? launch.env : undefined), ...login?.env } };
}
