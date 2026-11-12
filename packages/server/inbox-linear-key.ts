import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxLinearKeyState } from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { InboxError } from "@plannotator/shared/inbox/schema";

export const LINEAR_KEY_FILE = join("inbox", "linear-key");

export interface LinearKey {
  apiKey(): string | null;
  state(): InboxLinearKeyState;
  route(req: Request, path: string, via: string): Promise<Response | null>;
}

export function createLinearKey(options: {
  dataDir: string;
  serverSession: string;
  json: (body: unknown, status?: number) => Response;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  env?: Record<string, string | undefined>;
  changed?: () => void;
}): LinearKey {
  const { json } = options;
  const keyPath = join(options.dataDir, LINEAR_KEY_FILE);
  const env = options.env ?? process.env;
  const savedKey = (): string | null => {
    try {
      return readFileSync(keyPath, "utf8").trim() || null;
    } catch {
      return null;
    }
  };
  const envKey = (): string | null => env.LINEAR_API_KEY?.trim() || null;
  const writeKey = (key: string) => {
    mkdirSync(join(options.dataDir, "inbox"), { recursive: true, mode: 0o700 });
    const temp = `${keyPath}.${process.pid}.tmp`;
    writeFileSync(temp, `${key}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, keyPath);
  };
  const state = (): InboxLinearKeyState => {
    const key = savedKey();
    if (key) return { source: "saved", last4: key.slice(-4) };
    return { source: envKey() ? "env" : null, last4: null };
  };
  return {
    apiKey: () => savedKey() ?? envKey(),
    state,
    async route(req, path, via) {
      if (path !== "/api/inbox/linear/key") return null;
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      if (via !== "local" && req.headers.get("x-forwarded-proto") !== "https") {
        return json({ error: "An API key is accepted only over HTTPS.", code: "https_required" }, 403);
      }
      const body = await options.readBody(req);
      if (checkServerSession(body, options.serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      if (body.key === null) rmSync(keyPath, { force: true });
      else if (typeof body.key === "string" && /^[\x21-\x7e]{8,512}$/.test(body.key.trim())) writeKey(body.key.trim());
      else throw new InboxError("validation_error", "key: that doesn't look like a Linear API key.", { field: "key" });
      options.changed?.();
      return json({ key: state() });
    },
  };
}
