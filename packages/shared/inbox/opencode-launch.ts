/** Set on an OpenCode server the Inbox starts: its plugin watches each session from the moment it is created. */
export const OPENCODE_LAUNCH_ENV = "PLANNOTATOR_INBOX_LAUNCHED";
/** The session such a server continues: its plugin watches it from the start. */
export const OPENCODE_LAUNCH_SESSION_ENV = "PLANNOTATOR_INBOX_LAUNCHED_SESSION";
/** The first plugin release that watches a launched session. */
export const OPENCODE_LAUNCH_MIN_PLUGIN = "0.28.62";

const SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/;

export const openCodeSessionIdOk = (value: unknown): value is string => typeof value === "string" && SESSION_ID.test(value);

export function openCodeLaunchWatch(env: Readonly<Record<string, string | undefined>>): { created: boolean; session: string | null } {
  const session = env[OPENCODE_LAUNCH_SESSION_ENV];
  return { created: env[OPENCODE_LAUNCH_ENV] === "1", session: openCodeSessionIdOk(session) ? session : null };
}
