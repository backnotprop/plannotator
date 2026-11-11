/** `plannotator inbox export --jsonl <folder>`: writes the Inbox as JSONL files, from the database or its files. Read-only, so it may run beside a running Inbox. A refusal goes to stderr as `<code>: <message>` (exit 1); bad usage exits 2. */

import { resolve } from "node:path";
import { exportInbox, InboxExportError } from "@plannotator/shared/inbox/store-log/sqlite/export-inbox";
import { hasHelpFlag, INBOX_EXPORT_USAGE } from "./cli";
import { writeWholeToStdout } from "./write-whole-stdout";

export type ParsedExportCommand = { ok: true; folder: string } | { ok: false; error: string };

export function parseExportCommand(argv: readonly string[]): ParsedExportCommand {
  let folder: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg !== "--jsonl") return { ok: false, error: arg.startsWith("--") ? `Unknown inbox export option: ${arg}` : `inbox export takes its folder after --jsonl: ${arg}` };
    if (folder !== null) return { ok: false, error: "--jsonl given twice." };
    folder = argv[++i] ?? null;
    if (folder === null || folder.startsWith("--")) return { ok: false, error: "--jsonl takes a folder." };
  }
  if (folder === null) return { ok: false, error: "inbox export needs --jsonl <folder>." };
  return { ok: true, folder };
}

export interface ExportCommandDeps {
  dataDir: string;
  cwd: string;
  json: boolean;
  out?: (text: string) => void | Promise<void>;
  err?: (text: string) => void;
}

export async function runInboxExportCommand(argv: readonly string[], deps: ExportCommandDeps): Promise<number> {
  const out = deps.out ?? writeWholeToStdout;
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  if (hasHelpFlag([...argv])) {
    await out(`${INBOX_EXPORT_USAGE}\n`);
    return 0;
  }
  const parsed = parseExportCommand(argv);
  if (!parsed.ok) {
    err(`${parsed.error}\n${INBOX_EXPORT_USAGE}\n`);
    return 2;
  }
  const folder = resolve(deps.cwd, parsed.folder);
  let result: ReturnType<typeof exportInbox>;
  try {
    result = exportInbox(deps.dataDir, folder);
  } catch (error) {
    if (error instanceof InboxExportError) err(`${error.code}: ${error.message}\n`);
    else err(`export_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (deps.json) {
    await out(`${JSON.stringify({ folder: result.from === "empty" ? null : folder, from: result.from, lines: result.lines })}\n`);
    return 0;
  }
  const count = result.lines.toLocaleString("en-US");
  await out(
    result.from === "empty"
      ? "The Inbox holds nothing yet, so nothing was written.\n"
      : `Exported ${count} line${result.lines === 1 ? "" : "s"} from the Inbox ${result.from === "database" ? "database" : "files"} to ${folder}\n`,
  );
  return 0;
}
