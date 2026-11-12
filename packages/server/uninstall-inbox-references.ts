import { INBOX_AGENT_LABELS, type InboxAgentId } from "@plannotator/core/inbox-types";
import {
  AGENT_SPECS, agentHomeAllowed, claudeCodeMcpEntry, claudeCodeMcpPath, displayPath, entryArgv,
  INBOX_MCP_SERVER_NAME, inboxEntryRemovalHint, isPlannotatorInboxCommand, type AgentEnvironment,
  type RawReadOptions,
} from "./inbox-agents";
import { AGENT_FILE_MAX_BYTES } from "./agent-files";
import type { Unreadable } from "./uninstall-host-references";

export const UNINSTALL_PARSE_MAX_BYTES = 64 * 1024 * 1024;

const SCAN_READ: RawReadOptions = { maxBytes: UNINSTALL_PARSE_MAX_BYTES, lenient: true, searchAbove: AGENT_FILE_MAX_BYTES };

export type InboxReferenceScan = {
  warnings: string[];
  unreadable: Array<Unreadable & { owner: string }>;
};

export function remainingInboxReferences(
  environment: AgentEnvironment,
  binaryPaths: readonly string[],
  skip: ReadonlySet<InboxAgentId>,
): InboxReferenceScan {
  const scan: InboxReferenceScan = { warnings: [], unreadable: [] };
  if (!agentHomeAllowed(environment)) return scan;
  const normalize = (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    return environment.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const executables = new Set([...binaryPaths, "plannotator", ...(environment.platform === "win32" ? ["plannotator.exe"] : [])].map(normalize));
  for (const spec of AGENT_SPECS) {
    if (skip.has(spec.id)) continue;
    const claude = spec.id === "claude-code";
    const path = claude ? claudeCodeMcpPath(environment) : spec.file(environment);
    if (!path) continue;
    const read = claude ? claudeCodeMcpEntry(environment, [], SCAN_READ) : spec.raw(environment, SCAN_READ);
    if (!read || read.kind === "absent") continue;
    const owner = INBOX_AGENT_LABELS[spec.id];
    if (read.kind === "unreadable" && read.tooBig) {
      scan.warnings.push(
        `Skipped: ${owner}'s ${displayPath(path, environment)} has the text "${INBOX_MCP_SERVER_NAME}" but is larger than ${UNINSTALL_PARSE_MAX_BYTES / (1024 * 1024)} MiB, so uninstall did not read it. If it has a "${INBOX_MCP_SERVER_NAME}" entry that runs Plannotator, that entry will fail to start once Plannotator is gone (to remove it, ${inboxEntryRemovalHint(spec.id)}).`,
      );
      continue;
    }
    if (read.kind === "unreadable") {
      scan.unreadable.push({ file: path, reason: read.reason, owner });
      continue;
    }
    const argv = read.kind === "value" ? entryArgv(read.value) : read.argv;
    const executable = argv?.[0];
    const sourceCommand = argv?.length === 4 && isPlannotatorInboxCommand(argv);
    if (executable && (executables.has(normalize(executable)) || sourceCommand)) {
      scan.warnings.push(
        `Skipped: ${owner}'s "${INBOX_MCP_SERVER_NAME}" in ${displayPath(path, environment)} runs Plannotator and will fail to start once it is gone, but uninstall could not tell that Plannotator added it, so it is left (to remove it, ${inboxEntryRemovalHint(spec.id)}).`,
      );
    }
  }
  return scan;
}
