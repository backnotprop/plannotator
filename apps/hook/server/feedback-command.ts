import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_HEREDOC_END,
  FEEDBACK_UNAVAILABLE,
  feedbackInputError,
  feedbackOsName,
  productFeedbackPayload,
  productFeedbackUrl,
  sendProductFeedback,
  type FeedbackCategory,
} from "@plannotator/core/product-feedback";
import { FEEDBACK_COMMAND_USAGE } from "./cli";

export { FEEDBACK_COMMAND_USAGE };

export const FEEDBACK_STDIN_MAX_BYTES = 64 * 1024;

export type ParsedFeedbackCommand =
  | { ok: true; help: true }
  | { ok: true; help: false; stdin: boolean; message: string; category: FeedbackCategory | null; contact: string | null }
  | { ok: false; error: string };

const USAGE_HINT = `Give the message on stdin: plannotator feedback --stdin <<'${FEEDBACK_HEREDOC_END}' … ${FEEDBACK_HEREDOC_END}`;

export function parseFeedbackCommand(argv: readonly string[]): ParsedFeedbackCommand {
  const words: string[] = [];
  let category: FeedbackCategory | null = null;
  let contact: string | null = null;
  let stdin = false;
  let flagsDone = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!flagsDone && arg === "--") {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && (arg === "--help" || arg === "-h")) return { ok: true, help: true };
    if (!flagsDone && (arg === "--stdin" || arg === "-")) {
      stdin = true;
      continue;
    }
    if (!flagsDone && (arg === "--category" || arg.startsWith("--category="))) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (value === undefined) return { ok: false, error: "--category needs a value (bug, idea or other)." };
      if (!(FEEDBACK_CATEGORIES as readonly string[]).includes(value)) return { ok: false, error: `--category must be one of: ${FEEDBACK_CATEGORIES.join(", ")}.` };
      category = value as FeedbackCategory;
      continue;
    }
    if (!flagsDone && (arg === "--contact" || arg.startsWith("--contact="))) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (value === undefined) return { ok: false, error: "--contact needs a value." };
      contact = value;
      continue;
    }
    if (!flagsDone && arg.startsWith("--")) return { ok: false, error: `Unknown option: ${arg}` };
    words.push(arg);
  }
  if (stdin && words.length > 0) return { ok: false, error: "Give the message on stdin or as words, not both." };
  const message = words.join(" ");
  if (!stdin) {
    const invalid = feedbackInputError({ message, category, contact });
    if (invalid) return { ok: false, error: invalid === "Write your feedback first." ? USAGE_HINT : invalid };
  }
  return { ok: true, help: false, stdin, message, category, contact };
}

async function readStdin(stream: ReadableStream<Uint8Array>): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > FEEDBACK_STDIN_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function stdinMessage(text: string): string {
  return text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
}

export interface FeedbackCommandDeps {
  env: Record<string, string | undefined>;
  version: string;
  platform?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  stdin?: ReadableStream<Uint8Array>;
  stdinIsTTY?: boolean;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function runFeedbackCommand(argv: readonly string[], deps: FeedbackCommandDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const usage = (error: string) => {
    err(error);
    err("Run 'plannotator feedback --help' for usage.");
    return 2;
  };
  const parsed = parseFeedbackCommand(argv);
  if (!parsed.ok) return usage(parsed.error);
  if (parsed.help) {
    out(FEEDBACK_COMMAND_USAGE);
    return 0;
  }
  let message = parsed.message;
  if (parsed.stdin) {
    if (deps.stdinIsTTY ?? process.stdin.isTTY === true) return usage(`--stdin reads the message from a pipe or heredoc. ${USAGE_HINT}`);
    const text = await readStdin(deps.stdin ?? (Bun.stdin.stream() as ReadableStream<Uint8Array>)).catch(() => "");
    if (text === null) return usage("The message on stdin is too long: keep it under 4,000 characters.");
    message = stdinMessage(text);
    const invalid = feedbackInputError({ message, category: parsed.category, contact: parsed.contact });
    if (invalid) return usage(invalid === "Write your feedback first." ? `stdin was empty. ${USAGE_HINT}` : invalid);
  }
  let result: Awaited<ReturnType<typeof sendProductFeedback>>;
  try {
    const payload = productFeedbackPayload(
      { message, category: parsed.category, contact: parsed.contact },
      { version: deps.version, os: feedbackOsName(deps.platform ?? process.platform), surface: "cli" },
    );
    result = await sendProductFeedback(payload, { url: productFeedbackUrl(deps.env), fetch: deps.fetch, timeoutMs: deps.timeoutMs });
  } catch {
    result = { ok: false, reason: FEEDBACK_UNAVAILABLE, unavailable: true };
  }
  if (!result.ok) {
    err(result.unavailable ? result.reason : `Not sent: ${result.reason}`);
    return 1;
  }
  out("Sent");
  return 0;
}
