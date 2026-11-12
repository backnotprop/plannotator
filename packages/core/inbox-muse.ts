export const INBOX_MUSE_HOST = "muse";

export const INBOX_MUSE_NAME = "Muse Code";

export const INBOX_MUSE_BIN = "muse";

export const INBOX_MUSE_SESSION_ENV = "MUSE_SESSION_ID";

export const INBOX_MUSE_CONFIG_FOLDER = "muse";

export const INBOX_MUSE_SETTINGS_FILE = "settings.json";

export const INBOX_MUSE_MCP_KEY = "mcpServers";

export const INBOX_MUSE_OLD_MCP_KEY = "mcp_servers";

export const INBOX_MUSE_SETTINGS_SEED: Readonly<Record<string, unknown>> = { schema_version: 1 };

export function museMcpEntry(command: readonly string[]): { type: "stdio"; command: string; args: string[]; mode: "optional" } {
  const [program = "plannotator", ...args] = command;
  return { type: "stdio", command: program, args, mode: "optional" };
}

export function museMcpKey(settings: unknown): string {
  const top = settings && typeof settings === "object" && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {};
  return INBOX_MUSE_OLD_MCP_KEY in top && !(INBOX_MUSE_MCP_KEY in top) ? INBOX_MUSE_OLD_MCP_KEY : INBOX_MUSE_MCP_KEY;
}
