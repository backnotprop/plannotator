export const MOD_SESSION_ONLY_ENV = ["PLANNOTATOR_INBOX_REMINDER"] as const;

export function scrubModSessionEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of MOD_SESSION_ONLY_ENV) delete env[name];
}
