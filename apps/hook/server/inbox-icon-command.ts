import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { hasHelpFlag } from "./cli";
import { writeWholeToStdout } from "./write-whole-stdout";

export const INBOX_ICON_USAGE = [
  "Usage: plannotator inbox icon set <file> --request <id> [--json]",
  "",
  "Hand an animated icon back to the person's Plannotator Inbox, after an Inbox message asked you to animate one of",
  "their agent icons. <file> is your picture: SVG, PNG, GIF, WebP or JPEG, at most 512 KB. <id> is the request id",
  "written in that message (it starts with ia_).",
  "",
  "The Inbox shows your picture as that agent's icon in every window at once, and keeps the original, which the",
  "person can go back to with one click. It changes only the icon that message asked about. You can run it again",
  "with a better version.",
].join("\n");

const REQUEST_TIMEOUT_MS = 30_000;
const READ_CAP = 4 * 1024 * 1024;

const TYPES: Record<string, string> = { svg: "image/svg+xml", png: "image/png", gif: "image/gif", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg" };

export type ParsedIconCommand = { ok: true; file: string; request: string } | { ok: false; error: string };

export function parseIconCommand(argv: readonly string[]): ParsedIconCommand {
  const [op, ...rest] = argv;
  if (op !== "set") return { ok: false, error: op === undefined ? "inbox icon takes set." : `Unknown inbox icon command: ${op}` };
  let file: string | null = null;
  let request: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--request") request = rest[++i] ?? "";
    else if (arg.startsWith("--request=")) request = arg.slice("--request=".length);
    else if (arg.startsWith("-")) return { ok: false, error: `Unknown inbox icon set option: ${arg}` };
    else if (file === null) file = arg;
    else return { ok: false, error: `inbox icon set takes one file, not ${arg} too.` };
  }
  if (!file) return { ok: false, error: "inbox icon set needs the file." };
  if (!request) return { ok: false, error: "inbox icon set needs --request <id>, the request id from the Inbox message." };
  return { ok: true, file, request };
}

export interface IconCommandDeps {
  json: boolean;
  ensureRunning: () => Promise<InboxRegistryEntry>;
  cwd?: string;
  out?: (text: string) => void | Promise<void>;
  err?: (text: string) => void;
  timeoutMs?: number;
}

export async function runInboxIconCommand(argv: readonly string[], deps: IconCommandDeps): Promise<number> {
  const out = deps.out ?? writeWholeToStdout;
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  if (hasHelpFlag([...argv])) {
    await out(`${INBOX_ICON_USAGE}\n`);
    return 0;
  }
  const parsed = parseIconCommand(argv);
  if (!parsed.ok) {
    err(`${parsed.error}\n${INBOX_ICON_USAGE}\n`);
    return 2;
  }
  const refused = (code: string, message: string) => {
    err(`${code}: ${message}\n`);
    return 1;
  };
  const path = resolve(deps.cwd ?? process.cwd(), parsed.file);
  let bytes: Buffer;
  try {
    if (statSync(path).size > READ_CAP) return refused("validation_error", "Picture: at most 512 KB.");
    bytes = readFileSync(path);
  } catch {
    return refused("no_file", `Can't read ${parsed.file}.`);
  }
  let entry: InboxRegistryEntry;
  try {
    entry = await deps.ensureRunning();
  } catch (error) {
    return refused("not_running", `Plannotator Inbox is not running: ${error instanceof Error ? error.message : String(error)}`);
  }
  const type = TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}/api/inbox/icon-animate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: parsed.request, picture: `data:${type};base64,${bytes.toString("base64")}` }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.status === 404 && body?.code === undefined) return refused("not_supported", "This Inbox is older than icon hand-backs. Tell the person where the file is; they can drop it on the icon.");
    if (response.status !== 200 || !body) return refused(typeof body?.code === "string" ? body.code : "error", typeof body?.error === "string" ? body.error : `The Inbox answered ${response.status}. Nothing changed.`);
    const applied = body.applied === true;
    const line = applied ? "Done: the agent's icon is now your picture, in every Inbox window." : String(body.note ?? "Kept, but not shown.");
    await out(deps.json ? `${JSON.stringify({ applied, icon: body.icon }, null, 2)}\n` : `${line}\n`);
    return 0;
  } catch (error) {
    return refused("error", `${error instanceof Error ? error.message : String(error)}. Nothing changed.`);
  }
}
