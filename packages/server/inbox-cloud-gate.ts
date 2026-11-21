import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_RELAY_ANSWERED_FILE = "relay-answered";
const PROBE_TIMEOUT_MS = 4_000;

export function createInboxCloudGate(options: { dataDir: string; relayUrl: () => string; fetch?: typeof fetch; timeoutMs?: number }) {
  const marker = join(inboxDir(options.dataDir), INBOX_RELAY_ANSWERED_FILE);
  let answered = existsSync(marker);
  let probing: Promise<void> | null = null;

  const remember = () => {
    if (answered) return;
    answered = true;
    void writeFile(marker, `${new Date().toISOString()}\n`, { mode: 0o600 }).catch(() => undefined);
  };

  const probe = (): Promise<void> => {
    probing ??= (options.fetch ?? fetch)(`${options.relayUrl()}/v1/hello`, { signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS) })
      .then(remember, () => undefined)
      .finally(() => {
        probing = null;
      });
    return probing;
  };

  const available = async (pairedAgents: number): Promise<boolean> => {
    if (pairedAgents > 0 || answered) return true;
    await probe();
    return answered;
  };

  return { available, remember };
}

export type InboxCloudGate = ReturnType<typeof createInboxCloudGate>;
