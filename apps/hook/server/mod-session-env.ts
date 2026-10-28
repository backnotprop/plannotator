/**
 * Variables the Claude Code mod sets in its session for the plugin's own
 * hooks, which no Plannotator process has any use for and none may pass on.
 *
 * `PLANNOTATOR_INBOX_REMINDER`: the Inbox reminder, printed by the plugin's
 * `SessionStart` `compact` command hook (apps/hook/hooks/hooks.json). A CLI the
 * mod starts (a review server, the Inbox) would otherwise hand it to every
 * child it spawns, including Claude agent jobs (`claude -p`), whose own
 * compaction would then print a reminder naming a tool they do not have.
 */
export const MOD_SESSION_ONLY_ENV = ["PLANNOTATOR_INBOX_REMINDER"] as const;

/** Remove them from the environment, once, before anything is spawned. */
export function scrubModSessionEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of MOD_SESSION_ONLY_ENV) delete env[name];
}
