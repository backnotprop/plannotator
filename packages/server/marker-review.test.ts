import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  markerOpen,
  markerClose,
  makeMarkerNonce,
  extractMarkerNonce,
  buildMarkerOutputContract,
  MARKER_ENGINES,
  buildMarkerCommand,
  reduceMarkerStream,
  parseMarkerStreamOutput,
  formatMarkerLogEvent,
  transformMarkerFindings,
  validateMarkerReviewOutput,
  composeMarkerReviewPrompt,
  type MarkerEngine,
  type MarkerFinding,
  type MarkerReviewOutput,
} from "./marker-review";
import type { ResolvedReviewProfile } from "@plannotator/shared/review-profiles";

const cursor = MARKER_ENGINES.cursor;
const opencode = MARKER_ENGINES.opencode;
const pi = MARKER_ENGINES.pi;
const piInsufficientCreditsStdout = readFileSync(
  new URL("./fixtures/pi-insufficient-credits.ndjson", import.meta.url),
  "utf8",
);

// A fixed, valid nonce (pn + 12 hex) for deterministic tests.
const NONCE = "pn0123456789ab";
const OPEN = markerOpen(NONCE);
const CLOSE = markerClose(NONCE);

// ---------------------------------------------------------------------------
// NDJSON builders, mirroring each engine's real stream shape.
// ---------------------------------------------------------------------------

function ndjson(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

/** Cursor: a real partial-output assistant delta (timestamp_ms, no model_call_id). */
function cursorDelta(text: string, ts = 1): string {
  return ndjson({ type: "assistant", timestamp_ms: ts, message: { content: text } });
}
/** Cursor: a duplicate flush (model_call_id present) — must be skipped. */
function cursorDuplicate(text: string, ts = 1): string {
  return ndjson({ type: "assistant", timestamp_ms: ts, model_call_id: "call_1", message: { content: text } });
}
/** OpenCode: a finalized text part (the only events carrying assistant text). */
function opencodeText(text: string): string {
  return ndjson({ type: "text", timestamp: 1, sessionID: "s1", part: { type: "text", text, time: { start: 1, end: 2 } } });
}

function markerBlock(payload: unknown): string {
  return `${OPEN}\n${JSON.stringify(payload, null, 2)}\n${CLOSE}`;
}

function chunkify(s: string, parts: number): string[] {
  const size = Math.ceil(s.length / parts);
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

const validReview: MarkerReviewOutput = {
  findings: [
    {
      file: "packages/server/review.ts",
      line: 123,
      end_line: 130,
      severity: "important",
      description: "Null deref on the unhappy path.",
      reasoning: "The guard above only covers the happy path.",
    },
  ],
  summary: { correctness: "Issues Found", explanation: "One important issue.", confidence: 0.85 },
};

// ===========================================================================
// buildArgv — both descriptors
// ===========================================================================

describe("buildMarkerCommand: cursor", () => {
  test("uses the `agent` binary, read-only flags, prompt as trailing argv", () => {
    const { command } = buildMarkerCommand(cursor, "review this", "gpt-5", "/repo");
    expect(command[0]).toBe("agent");
    expect(command).toContain("-p");
    expect(command[command.indexOf("--mode") + 1]).toBe("ask");
    expect(command[command.indexOf("--sandbox") + 1]).toBe("enabled");
    expect(command).not.toContain("--force");
    expect(command).not.toContain("--yolo");
    expect(command).toContain("--trust");
    expect(command[command.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(command).toContain("--stream-partial-output");
    expect(command[command.indexOf("--workspace") + 1]).toBe("/repo");
    expect(command[command.indexOf("--model") + 1]).toBe("gpt-5");
    expect(command[command.length - 1]).toBe("review this");
  });

  test("omits --model for Auto/empty/undefined; --workspace when no cwd", () => {
    expect(buildMarkerCommand(cursor, "p", "Auto", "/repo").command).not.toContain("--model");
    expect(buildMarkerCommand(cursor, "p", "", "/repo").command).not.toContain("--model");
    expect(buildMarkerCommand(cursor, "p", undefined, "/repo").command).not.toContain("--model");
    expect(buildMarkerCommand(cursor, "p").command).not.toContain("--workspace");
  });

  test("cursorSandbox: false omits the --sandbox pair entirely (escape hatch)", () => {
    const { command } = buildMarkerCommand(cursor, "review this", "gpt-5", "/repo", { cursorSandbox: false });
    expect(command).not.toContain("--sandbox");
    // The pair is OMITTED, never flipped to `--sandbox disabled`.
    expect(command).not.toContain("enabled");
    expect(command).not.toContain("disabled");
    // The rest of the read-only posture is unchanged.
    expect(command[command.indexOf("--mode") + 1]).toBe("ask");
    expect(command).not.toContain("--force");
    expect(command).not.toContain("--yolo");
    expect(command[command.length - 1]).toBe("review this");
  });

  test("cursorSandbox: true and undefined keep --sandbox enabled (default)", () => {
    const explicit = buildMarkerCommand(cursor, "p", "gpt-5", "/repo", { cursorSandbox: true }).command;
    expect(explicit[explicit.indexOf("--sandbox") + 1]).toBe("enabled");
    const omitted = buildMarkerCommand(cursor, "p", "gpt-5", "/repo", {}).command;
    expect(omitted[omitted.indexOf("--sandbox") + 1]).toBe("enabled");
  });
});

describe("buildMarkerCommand: opencode", () => {
  test("uses `opencode run --format json --agent plan`, prompt trailing", () => {
    const { command } = buildMarkerCommand(opencode, "review this", "opencode/glm-5.1", "/repo");
    expect(command[0]).toBe("opencode");
    expect(command[1]).toBe("run");
    expect(command[command.indexOf("--format") + 1]).toBe("json");
    expect(command[command.indexOf("--agent") + 1]).toBe("plan");
    expect(command[command.indexOf("--dir") + 1]).toBe("/repo");
    expect(command[command.indexOf("--model") + 1]).toBe("opencode/glm-5.1");
    expect(command).not.toContain("--dangerously-skip-permissions");
    expect(command[command.length - 1]).toBe("review this");
  });

  test("omits --model when empty; --dir when no cwd", () => {
    expect(buildMarkerCommand(opencode, "p", "", "/repo").command).not.toContain("--model");
    expect(buildMarkerCommand(opencode, "p").command).not.toContain("--dir");
  });
});

describe("buildMarkerCommand: copilot", () => {
  test("json output, non-interactive denial posture, read-only shell allowlist, prompt via -p", () => {
    const { command } = buildMarkerCommand(MARKER_ENGINES.copilot, "review this", "claude-sonnet-5", "/repo");
    expect(command[0]).toBe("copilot");
    expect(command[command.indexOf("-C") + 1]).toBe("/repo");
    expect(command[command.indexOf("--output-format") + 1]).toBe("json");
    expect(command).toContain("--no-ask-user");
    expect(command).toContain("--no-auto-update");
    expect(command).toContain("--disable-builtin-mcps");
    expect(command).toContain("--deny-tool=write");
    expect(command).toContain("--allow-tool=shell(git:*)");
    expect(command).toContain("--allow-tool=shell(gh:*)");
    // High-consequence verbs are structurally denied even though git:*/gh:*/
    // glab:* are allowed — deny rules take precedence in Copilot's model.
    expect(command).toContain("--deny-tool=shell(git push)");
    expect(command).toContain("--deny-tool=shell(git reset)");
    expect(command).toContain("--deny-tool=shell(git clean)");
    expect(command).toContain("--deny-tool=shell(git restore)");
    expect(command).toContain("--deny-tool=shell(gh pr comment)");
    expect(command).toContain("--deny-tool=shell(gh pr merge)");
    expect(command).toContain("--deny-tool=shell(glab mr note)");
    expect(command).not.toContain("--allow-all-tools");
    expect(command).not.toContain("--yolo");
    expect(command[command.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    // Prompt is the VALUE of -p, last in argv.
    expect(command[command.length - 2]).toBe("-p");
    expect(command[command.length - 1]).toBe("review this");
  });

  test("omits --model for auto/empty/undefined; -C when no cwd", () => {
    expect(buildMarkerCommand(MARKER_ENGINES.copilot, "p", "auto", "/repo").command).not.toContain("--model");
    expect(buildMarkerCommand(MARKER_ENGINES.copilot, "p", "", "/repo").command).not.toContain("--model");
    expect(buildMarkerCommand(MARKER_ENGINES.copilot, "p", undefined, "/repo").command).not.toContain("--model");
    expect(buildMarkerCommand(MARKER_ENGINES.copilot, "p").command).not.toContain("-C");
  });
});

// ===========================================================================
// parseModels — both descriptors
// ===========================================================================

describe("parseModels: cursor", () => {
  test("parses `id - Label` lines, skips header/tip, dedupes", () => {
    const out = [
      "Available models",
      "",
      "auto - Auto",
      "gpt-5.2 - GPT-5.2",
      "claude-opus-4-8-thinking-high - Opus 4.8 1M Thinking",
      "auto - Auto Again",
      "Tip: use --model <id> to switch.",
    ].join("\n");
    expect(cursor.parseModels(out)).toEqual([
      { id: "auto", label: "Auto" },
      { id: "gpt-5.2", label: "GPT-5.2" },
      { id: "claude-opus-4-8-thinking-high", label: "Opus 4.8 1M Thinking" },
    ]);
  });

  test("returns [] for unauthenticated / empty output", () => {
    expect(cursor.parseModels("No models available for this account.")).toEqual([]);
    expect(cursor.parseModels("")).toEqual([]);
  });
});

describe("parseModels: opencode", () => {
  test("parses provider/model lines (incl. nested slashes), dedupes, skips junk", () => {
    const out = ["opencode/big-pickle", "openrouter/deepseek/deepseek-chat-v3", "opencode/big-pickle", "", "Some header line"].join("\n");
    expect(opencode.parseModels(out)).toEqual([
      { id: "opencode/big-pickle", label: "opencode/big-pickle" },
      { id: "openrouter/deepseek/deepseek-chat-v3", label: "openrouter/deepseek/deepseek-chat-v3" },
    ]);
  });

  test("returns [] for empty / no provider lines", () => {
    expect(opencode.parseModels("")).toEqual([]);
    expect(opencode.parseModels("No models configured")).toEqual([]);
  });
});

// ===========================================================================
// reduceMarkerStream / extractText — both descriptors
// ===========================================================================

describe("reduceMarkerStream: copilot", () => {
  test("reads assistant.message content once; deltas and bookkeeping are skipped", () => {
    const stdout =
      ndjson({ type: "session.tools_updated", data: { model: "claude-sonnet-5" } }) +
      ndjson({ type: "assistant.message_delta", data: { deltaContent: "Loo" } }) +
      ndjson({ type: "assistant.message_delta", data: { deltaContent: "king" } }) +
      ndjson({ type: "assistant.message", data: { content: "Looking at the diff." } }) +
      ndjson({ type: "assistant.message", data: { content: "", toolRequests: [{ name: "bash" }] } }) +
      ndjson({ type: "result", exitCode: 0 });
    const { canonicalText } = reduceMarkerStream(stdout, MARKER_ENGINES.copilot);
    expect(canonicalText).toBe("Looking at the diff.");
  });

  test("full pipeline: marker block inside assistant.message content parses", () => {
    const stdout = ndjson({
      type: "assistant.message",
      data: { content: "Commentary first.\n" + markerBlock(validReview) },
    });
    const out = parseMarkerStreamOutput(stdout, MARKER_ENGINES.copilot, NONCE);
    expect(out?.findings).toHaveLength(1);
    expect(out?.findings[0].file).toBe("packages/server/review.ts");
  });
});

describe("reduceMarkerStream: cursor", () => {
  test("reconstructs canonical text regardless of chunk boundaries", () => {
    const stdout =
      ndjson({ type: "system", subtype: "init", model: "Auto" }) +
      cursorDelta("Looking at ") +
      cursorDelta("the diff.") +
      ndjson({ type: "result", result: " Done." });

    expect(reduceMarkerStream(stdout, cursor).canonicalText).toBe("Looking at the diff. Done.");
    for (const parts of [2, 3, 7, stdout.length]) {
      const rejoined = chunkify(stdout, parts).join("");
      expect(reduceMarkerStream(rejoined, cursor).canonicalText).toBe("Looking at the diff. Done.");
    }
  });

  test("filters duplicate flushes (model_call_id present), skips malformed", () => {
    const stdout = cursorDelta("real ") + cursorDuplicate("DUP") + "not json\n" + cursorDelta("text");
    const { canonicalText, recordCount } = reduceMarkerStream(stdout, cursor);
    expect(canonicalText).toBe("real text");
    expect(canonicalText).not.toContain("DUP");
    expect(recordCount).toBe(3); // malformed line not counted
  });
});

describe("reduceMarkerStream: opencode", () => {
  test("concatenates type:text part.text, ignores tool/step events", () => {
    const stdout =
      opencodeText("Looking at ") +
      ndjson({ type: "tool_use", sessionID: "s1", part: { type: "tool", tool: "read", state: { status: "completed" } } }) +
      opencodeText("the diff.") +
      ndjson({ type: "step_finish", sessionID: "s1", part: { type: "step-finish" } });
    expect(reduceMarkerStream(stdout, opencode).canonicalText).toBe("Looking at the diff.");
  });

  test("survives chunk-joined buffer and malformed lines", () => {
    const stdout = opencodeText("a") + "not json\n" + opencodeText("b");
    expect(reduceMarkerStream(stdout, opencode).canonicalText).toBe("ab");
  });
});

describe("reduceMarkerStream: pi", () => {
  test("extracts a structured provider failure from Pi's exit-0 NDJSON stream", () => {
    const reduction = reduceMarkerStream(piInsufficientCreditsStdout, pi);
    expect(reduction.canonicalText).toBe("");
    expect(reduction.providerError).toBe("Insufficient API credits");
  });

  test("bounds and redacts provider diagnostics without dumping the NDJSON record", () => {
    const secret = `sk-${"a".repeat(32)}`;
    const stdout = ndjson({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: `Insufficient credits\nAuthorization: Bearer ${secret}; ${"x".repeat(700)}`,
      },
    });

    const { providerError } = reduceMarkerStream(stdout, pi);
    expect(providerError).toStartWith("Insufficient credits Authorization: [REDACTED]");
    expect(providerError).not.toContain(secret);
    expect(providerError).not.toContain("\n");
    expect(providerError?.length).toBe(500);
  });

  test("uses an actionable fallback for an aborted Pi assistant message", () => {
    const stdout = ndjson({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "aborted" },
    });
    expect(reduceMarkerStream(stdout, pi).providerError).toBe("Pi request aborted");
  });

  test("clears a transient Pi error after a later successful assistant outcome", () => {
    const transientErrorPrefix = piInsufficientCreditsStdout
      .trimEnd()
      .split("\n")
      .slice(0, 5)
      .join("\n");
    const successfulMessage = ndjson({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "stop" },
    });
    expect(reduceMarkerStream(`${transientErrorPrefix}\n${successfulMessage}`, pi).providerError).toBeNull();
  });
});

// ===========================================================================
// parseMarkerStreamOutput — NDJSON split, last block wins, failure → null
// ===========================================================================

describe("parseMarkerStreamOutput: last block wins, chunk-safe", () => {
  test("cursor: extracts the LAST complete marker block across messages", () => {
    const stale = { findings: [], summary: { correctness: "Correct", explanation: "draft", confidence: 0.1 } };
    const stdout =
      cursorDelta("Draft:\n" + markerBlock(stale) + "\n") +
      cursorDelta("Final:\n" + markerBlock(validReview));
    const out = parseMarkerStreamOutput(stdout, cursor, NONCE);
    expect(out!.summary.correctness).toBe("Issues Found");
    expect(out!.findings).toHaveLength(1);
  });

  test("opencode: a single block split across text parts + raw chunks parses", () => {
    const full = "Commentary first.\n" + markerBlock(validReview);
    const half = Math.floor(full.length / 2);
    const stdout = opencodeText(full.slice(0, half)) + opencodeText(full.slice(half));
    const out = parseMarkerStreamOutput(chunkify(stdout, 9).join(""), opencode, NONCE);
    expect(out!.findings).toHaveLength(1);
  });
});

describe("parseMarkerStreamOutput: failure modes → null", () => {
  test("cursor: missing / unclosed / malformed-JSON / schema-invalid / empty", () => {
    expect(parseMarkerStreamOutput(cursorDelta("no marker here"), cursor, NONCE)).toBeNull();
    expect(parseMarkerStreamOutput(cursorDelta(`${OPEN}\n{"findings":[]`), cursor, NONCE)).toBeNull();
    expect(parseMarkerStreamOutput(cursorDelta(`${OPEN}\n{ bad json }\n${CLOSE}`), cursor, NONCE)).toBeNull();
    const badSeverity = { findings: [{ file: "x.ts", line: 1, severity: "blocker", description: "d", reasoning: "" }], summary: { correctness: "x", explanation: "y", confidence: 1 } };
    expect(parseMarkerStreamOutput(cursorDelta(markerBlock(badSeverity)), cursor, NONCE)).toBeNull();
    expect(parseMarkerStreamOutput("", cursor, NONCE)).toBeNull();
    expect(parseMarkerStreamOutput("   \n  ", cursor, NONCE)).toBeNull();
  });

  test("cursor: a complete block followed by a truncated block fails closed (no stale fallback)", () => {
    // Model emitted a draft block, then started a replacement that got cut off.
    // We must NOT silently return the earlier block.
    const stdout = cursorDelta(
      "Draft:\n" + markerBlock(validReview) + "\nFinal:\n" + `${OPEN}\n{"findings":[`,
    );
    expect(parseMarkerStreamOutput(stdout, cursor, NONCE)).toBeNull();
  });

  test("cursor: bare static sentinels in prose don't corrupt extraction (real-run regression)", () => {
    // Reproduces the live failure: reviewing this module, Composer's prose quoted
    // the bare `<plannotator-review-json>` tag (no nonce) BEFORE its real payload.
    // The static parser latched onto that mention; the nonce makes it inert.
    const bareOpen = "<plannotator-review-json>";
    const bareClose = "</plannotator-review-json>";
    const stdout = cursorDelta(
      `Findings are extracted from a ${bareOpen} marker block; see ${bareClose}.\n` +
        "Here is my review.\n" +
        markerBlock(validReview) +
        "\nTo run the full panel, switch to Agent mode.",
    );
    const out = parseMarkerStreamOutput(stdout, cursor, NONCE);
    expect(out!.summary.correctness).toBe("Issues Found");
    expect(out!.findings).toHaveLength(1);
  });

  test("nonce: makeMarkerNonce round-trips through a composed prompt; wrong/absent nonce fails closed", () => {
    const nonce = makeMarkerNonce();
    expect(nonce).toMatch(/^pn[0-9a-f]{12}$/);
    const prompt = composeMarkerReviewPrompt(undefined, "review the diff", nonce);
    expect(extractMarkerNonce(prompt)).toBe(nonce);
    expect(extractMarkerNonce("no marker here")).toBeNull();
    // A payload tagged with the real nonce parses only under that nonce.
    const stdout = cursorDelta(`${markerOpen(nonce)}\n${JSON.stringify(validReview)}\n${markerClose(nonce)}`);
    expect(parseMarkerStreamOutput(stdout, cursor, nonce)!.findings).toHaveLength(1);
    expect(parseMarkerStreamOutput(stdout, cursor, "pnffffffffffff")).toBeNull();
    expect(parseMarkerStreamOutput(stdout, cursor, "")).toBeNull();
  });

  test("opencode: missing summary field → null; valid empty findings accepted", () => {
    const missingSummary = { findings: [], summary: { correctness: "x", explanation: "y" } };
    expect(parseMarkerStreamOutput(opencodeText(markerBlock(missingSummary)), opencode, NONCE)).toBeNull();
    const clean = { findings: [], summary: { correctness: "Correct", explanation: "ok", confidence: 1 } };
    const out = parseMarkerStreamOutput(opencodeText(markerBlock(clean)), opencode, NONCE);
    expect(out!.findings).toEqual([]);
  });
});

// ===========================================================================
// validateMarkerReviewOutput — nullable placement schema (mirrors Claude)
// ===========================================================================

describe("validateMarkerReviewOutput: nullable file/line/end_line", () => {
  test("accepts a line finding, a whole-file finding (line null), and a general note (file+line null)", () => {
    const out = validateMarkerReviewOutput({
      findings: [
        { file: "a.ts", line: 5, end_line: 5, severity: "important", description: "line issue", reasoning: "r" },
        { file: "a.ts", line: null, end_line: null, severity: "nit", description: "whole-file", reasoning: "r" },
        { file: null, line: null, end_line: null, severity: "nit", description: "general note", reasoning: "r" },
        // Absent placement fields are equivalent to null.
        { severity: "nit", description: "general via omission", reasoning: "r" },
      ],
      summary: { correctness: "Issues Found", explanation: "e", confidence: 0.5 },
    });
    expect(out).not.toBeNull();
    expect(out!.findings).toHaveLength(4);
    expect(out!.findings[1].line).toBeNull();
    expect(out!.findings[2].file).toBeNull();
    expect(out!.findings[3].file).toBeNull();
    expect(out!.findings[3].line).toBeNull();
  });

  test("rejects non-object, missing findings array, bad severity, wrong placement type", () => {
    expect(validateMarkerReviewOutput(null)).toBeNull();
    expect(validateMarkerReviewOutput({ summary: { correctness: "c", explanation: "e", confidence: 1 } })).toBeNull();
    expect(validateMarkerReviewOutput({ findings: [{ severity: "high", description: "d" }], summary: { correctness: "c", explanation: "e", confidence: 1 } })).toBeNull();
    // line must be number|null — a string is invalid.
    expect(validateMarkerReviewOutput({ findings: [{ file: "a", line: "x", severity: "important", description: "d" }], summary: { correctness: "c", explanation: "e", confidence: 1 } })).toBeNull();
  });

  test("defaults reasoning to empty string", () => {
    const out = validateMarkerReviewOutput({
      findings: [{ file: "a.ts", line: 5, severity: "nit", description: "d" }],
      summary: { correctness: "Issues Found", explanation: "e", confidence: 0.5 },
    });
    expect(out!.findings[0].reasoning).toBe("");
  });
});

// ===========================================================================
// formatMarkerLogEvent — both descriptors
// ===========================================================================

describe("formatMarkerLogEvent", () => {
  test("cursor: init / delta / tool_call / result; skips dup, flush, malformed", () => {
    expect(formatMarkerLogEvent(ndjson({ type: "system", subtype: "init", model: "Auto", session_id: "s1" }).trim(), cursor)).toContain("model=Auto");
    expect(formatMarkerLogEvent(cursorDelta("hello").trim(), cursor)).toBe("hello");
    expect(formatMarkerLogEvent(ndjson({ type: "tool_call", subtype: "completed", name: "read_file" }).trim(), cursor)).toBe("[read_file] completed");
    expect(formatMarkerLogEvent(ndjson({ type: "result", duration_ms: 42 }).trim(), cursor)).toContain("42ms");
    expect(formatMarkerLogEvent(cursorDuplicate("dup").trim(), cursor)).toBeNull();
    expect(formatMarkerLogEvent(ndjson({ type: "assistant", message: { content: "FULL FLUSH" } }).trim(), cursor)).toBeNull();
    expect(formatMarkerLogEvent("not json", cursor)).toBeNull();
  });

  test("opencode: text / tool_use / error; skips step, malformed", () => {
    expect(formatMarkerLogEvent(opencodeText("hello").trim(), opencode)).toBe("hello");
    expect(formatMarkerLogEvent(ndjson({ type: "tool_use", part: { type: "tool", tool: "read", state: { status: "completed" } } }).trim(), opencode)).toBe("[read] completed");
    expect(formatMarkerLogEvent(ndjson({ type: "error", error: {} }).trim(), opencode)).toContain("[error]");
    expect(formatMarkerLogEvent(ndjson({ type: "step_start", part: { type: "step-start" } }).trim(), opencode)).toBeNull();
    expect(formatMarkerLogEvent("not json", opencode)).toBeNull();
  });
});

// ===========================================================================
// transformMarkerFindings — classifyFindingPlacement; nothing dropped
// ===========================================================================

describe("transformMarkerFindings: line/file/general, nothing dropped", () => {
  const findings: MarkerFinding[] = [
    { file: "/repo/packages/server/review.ts", line: 10, end_line: 12, severity: "important", description: "line bug", reasoning: "r" },
    { file: "/repo/packages/server/review.ts", line: null, end_line: null, severity: "nit", description: "whole-file note", reasoning: "r" },
    { file: null, line: null, end_line: null, severity: "nit", description: "general note", reasoning: "r" },
  ];

  test("cursor: produces line/file/general placements with author Cursor", () => {
    const out = transformMarkerFindings(findings, "agent-x", cursor.author, "/repo");
    expect(out).toHaveLength(3); // nothing dropped

    const [line, file, general] = out;
    expect(line.scope).toBe("line");
    expect(line.filePath).toBe("packages/server/review.ts");
    expect(line.lineStart).toBe(10);
    expect(line.lineEnd).toBe(12);
    expect(line.author).toBe("Cursor");
    expect(line.text).toBe("[important] line bug");

    expect(file.scope).toBe("file");
    expect(file.filePath).toBe("packages/server/review.ts");
    expect(file.lineStart).toBe(0);

    expect(general.scope).toBe("general");
    expect(general.filePath).toBe("");
  });

  test("opencode: same placements with author OpenCode; path transform applied", () => {
    const out = transformMarkerFindings(findings, "src", opencode.author, "/repo", (p) => p ? `child/${p}` : p);
    expect(out[0].author).toBe("OpenCode");
    expect(out[0].filePath).toBe("child/packages/server/review.ts");
    // general note has no file → transform receives "" and placement stays general
    expect(out[2].scope).toBe("general");
  });

  test("defaults lineEnd to lineStart when end_line absent on a line finding", () => {
    const f: MarkerFinding[] = [{ file: "/repo/a.ts", line: 7, severity: "nit", description: "d", reasoning: "" }];
    expect(transformMarkerFindings(f, "src", cursor.author, "/repo")[0].lineEnd).toBe(7);
  });
});

// ===========================================================================
// composeMarkerReviewPrompt — contract ALWAYS appended (default AND custom)
// ===========================================================================

describe("composeMarkerReviewPrompt", () => {
  const userMessage = "Review the diff for branch X.";

  test("default profile: methodology + contract + user message", () => {
    const prompt = composeMarkerReviewPrompt(undefined, userMessage, NONCE);
    expect(prompt).toContain("# Code Review");
    expect(prompt).toContain(buildMarkerOutputContract(NONCE));
    expect(prompt).toContain(OPEN);
    expect(prompt.endsWith(userMessage)).toBe(true);
  });

  test("builtin:default profile behaves like no profile (contract present)", () => {
    const builtin: ResolvedReviewProfile = { id: "builtin:default", label: "Default", instructions: "", source: "builtin", default: true };
    const prompt = composeMarkerReviewPrompt(builtin, userMessage, NONCE);
    expect(prompt).toContain("# Code Review");
    expect(prompt).toContain(buildMarkerOutputContract(NONCE));
  });

  test("custom profile REPLACES methodology but KEEPS the output contract", () => {
    const custom: ResolvedReviewProfile = {
      id: "user:security",
      label: "Security",
      instructions: "ONLY look for SQL injection and auth bypasses.",
      source: "user",
    };
    const prompt = composeMarkerReviewPrompt(custom, userMessage, NONCE);
    expect(prompt).toContain("ONLY look for SQL injection and auth bypasses.");
    // Custom instructions replace the default methodology...
    expect(prompt).not.toContain("You are a senior engineer reviewing a code change.");
    // ...but the marker contract is still appended — it's the only thing that
    // makes marker output parseable.
    expect(prompt).toContain(buildMarkerOutputContract(NONCE));
    expect(prompt).toContain(OPEN);
    expect(prompt.endsWith(userMessage)).toBe(true);
  });
});
