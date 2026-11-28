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

/**
 * Set by the mod beside the `PLANNOTATOR_PLAN_REVIEW=0` it puts in a session
 * whose host draws its own plan card (Orca): the session that set it
 * (`claude-code:<session id>`). `HOST_PLAN_CARD_MARKER` in
 * apps/hook/hooks/mod/enabled.ts (mod-session-env.test.ts keeps them equal).
 */
export const MOD_PLAN_REVIEW_MARKER = "PLANNOTATOR_PLAN_REVIEW_SET_BY";

/** The mod's own plan review switch this process inherited: the session that set it. */
export type ModPlanReviewSwitch = { setBy: string } | null;

/**
 * Remove them from the environment, once, before anything is spawned. The
 * mod's marked `PLANNOTATOR_PLAN_REVIEW=0` goes too (a person's own value has
 * no marker and stays), so a server, the Inbox or an "Open in" terminal this
 * process starts never hands it to a later Claude Code; it is returned, for
 * the plan hook of the session that set it (`planReviewEnvFor`).
 */
export function scrubModSessionEnv(env: NodeJS.ProcessEnv = process.env): ModPlanReviewSwitch {
  for (const name of MOD_SESSION_ONLY_ENV) delete env[name];
  const setBy = env[MOD_PLAN_REVIEW_MARKER];
  if (setBy === undefined) return null;
  delete env[MOD_PLAN_REVIEW_MARKER];
  if (!setBy || env.PLANNOTATOR_PLAN_REVIEW?.trim() !== "0") return null;
  delete env.PLANNOTATOR_PLAN_REVIEW;
  return { setBy };
}

/**
 * The environment the Claude Code plan hook decides on: the mod's `0` counts
 * only in the hook of the session that set it (its id in the hook event), so
 * one inherited from another session never turns plan review off here.
 */
export function planReviewEnvFor(modSwitch: ModPlanReviewSwitch, sessionId: unknown, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!modSwitch || typeof sessionId !== "string" || modSwitch.setBy !== `claude-code:${sessionId}`) return env;
  return { ...env, PLANNOTATOR_PLAN_REVIEW: "0" };
}
