import { INBOX_TEXT_COMPLETE_META_KEY } from "@plannotator/shared/inbox/connection";
import { InboxError } from "@plannotator/shared/inbox/schema";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

export const TEXT_COMPLETE_META = { [INBOX_TEXT_COMPLETE_META_KEY]: true } as const;

export const PROJECT_PATH_DESCRIPTION =
  "Absolute path of the repository or folder you work in; the thread lands in that project's row. The `plannotator inbox mcp` shim fills it from its working folder.";

export function ok(line: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: line }], structuredContent: structured };
}

export function okComplete(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured, _meta: { ...TEXT_COMPLETE_META } };
}

export function fail(code: string, message: string): ToolResult {
  return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true };
}

export async function guarded(run: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof InboxError) return fail(error.code, error.message);
    return fail("internal_error", error instanceof Error ? error.message : String(error));
  }
}
