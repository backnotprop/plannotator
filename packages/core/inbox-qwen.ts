export const INBOX_QWEN_WAKE_MIN_VERSION = "0.24.0";

export const INBOX_QWEN_HOST = "qwen";

export const INBOX_QWEN_NAME = "Qwen Code";

export const INBOX_QWEN_MCP_CLIENT_PREFIX = "qwen-cli-mcp-client-";
export const INBOX_QWEN_MCP_CLIENT_LEGACY = "qwen-code-mcp-client";

export function isQwenMcpClient(name: string | null | undefined): boolean {
  return typeof name === "string" && (name === INBOX_QWEN_MCP_CLIENT_LEGACY || (name.startsWith(INBOX_QWEN_MCP_CLIENT_PREFIX) && name.length > INBOX_QWEN_MCP_CLIENT_PREFIX.length));
}

export const INBOX_QWEN_SESSION_ENV = "QWEN_CODE_SESSION_ID";

export const INBOX_QWEN_INVOCATION_META_KEY = "qwen-code/invocation";

export const INBOX_QWEN_REGISTRY_SCHEMA = 1;

const QWEN_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[A-Za-z0-9_]{1,32}(?:-[A-Za-z0-9_]{1,32}){0,3})?$/i;

export function isQwenSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 160 && QWEN_SESSION_ID.test(value);
}

export function qwenSessionOfCall(meta: unknown): string | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const invocation = (meta as Record<string, unknown>)[INBOX_QWEN_INVOCATION_META_KEY];
  if (!invocation || typeof invocation !== "object" || Array.isArray(invocation)) return null;
  const record = invocation as Record<string, unknown>;
  if (record.version !== 1) return null;
  return isQwenSessionId(record.sessionId) ? record.sessionId : null;
}

export interface InboxQwenSessionRecord {
  pid: number;
  sessionId: string;
  kind: string;
  ipcPath: string | null;
  ipcToken: string | null;
  procStart: string | null;
  pidNs: number | null;
  cwd: string | null;
  startedAt: number;
  shared: boolean;
}

export function qwenRecordFilePid(name: string): { pid: number; shared: boolean } | null {
  const match = /^([1-9]\d{0,9})(-[0-9a-f]{8})?\.json$/.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? { pid, shared: match[2] !== undefined } : null;
}

export function parseQwenSessionRecord(value: unknown, file: { pid: number; shared: boolean }): InboxQwenSessionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== INBOX_QWEN_REGISTRY_SCHEMA) return null;
  if (record.pid !== file.pid) return null;
  if (!isQwenSessionId(record.sessionId)) return null;
  const kind = typeof record.kind === "string" && /^[a-z][a-z0-9-]{0,15}$/.test(record.kind) ? record.kind : "tui";
  const ipcPath = typeof record.ipcPath === "string" && record.ipcPath.startsWith("/") && record.ipcPath.length < 1024 && !record.ipcPath.includes("\u0000") ? record.ipcPath : null;
  const ipcToken = typeof record.ipcToken === "string" && /^[0-9a-f]{64}$/i.test(record.ipcToken) ? record.ipcToken : null;
  const tokenBroken = record.ipcToken !== undefined && record.ipcToken !== null && ipcToken === null;
  return {
    pid: file.pid,
    sessionId: record.sessionId,
    kind,
    ipcPath: tokenBroken ? null : ipcPath,
    ipcToken,
    procStart: typeof record.procStart === "string" && record.procStart.length < 256 ? record.procStart : null,
    pidNs: typeof record.pidNs === "number" && Number.isSafeInteger(record.pidNs) ? record.pidNs : null,
    cwd: typeof record.cwd === "string" && record.cwd.startsWith("/") && record.cwd.length < 4096 && !record.cwd.includes("\u0000") ? record.cwd : null,
    startedAt: typeof record.startedAt === "number" && Number.isFinite(record.startedAt) ? record.startedAt : 0,
    shared: file.shared,
  };
}
