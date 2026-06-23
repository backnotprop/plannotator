import { describe, expect, test } from "bun:test";
import {
  CURSOR_MARKER_OPEN,
  CURSOR_MARKER_CLOSE,
  buildCursorCommand,
  reduceCursorStreamEvents,
  parseCursorStreamOutput,
  formatCursorLogEvent,
  transformCursorFindings,
  validateCursorReviewOutput,
  parseCursorModelsOutput,
  type CursorFinding,
  type CursorReviewOutput,
} from "./cursor-review";

// ---------------------------------------------------------------------------
// Helpers — build NDJSON the way Cursor `stream-json` does.
// ---------------------------------------------------------------------------

/** Wrap a JSON object as one NDJSON record (line + newline). */
function ndjson(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

/** A real partial-output assistant delta: timestamp_ms present, model_call_id absent. */
function assistantDelta(text: string, ts = 1): string {
  return ndjson({ type: "assistant", timestamp_ms: ts, message: { content: text } });
}

/** A duplicate assistant flush: model_call_id present → must be skipped. */
function assistantDuplicate(text: string, ts = 1): string {
  return ndjson({ type: "assistant", timestamp_ms: ts, model_call_id: "call_1", message: { content: text } });
}

/** Wrap review JSON in the marker block. */
function markerBlock(payload: unknown): string {
  return `${CURSOR_MARKER_OPEN}\n${JSON.stringify(payload, null, 2)}\n${CURSOR_MARKER_CLOSE}`;
}

const validReview: CursorReviewOutput = {
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

/** Split a string into N near-equal chunks to simulate arbitrary pipe boundaries. */
function chunkify(s: string, parts: number): string[] {
  const size = Math.ceil(s.length / parts);
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Command construction
// ---------------------------------------------------------------------------

describe("buildCursorCommand", () => {
  test("uses the `agent` binary and read-only flags, prompt as trailing argv", () => {
    const { command } = buildCursorCommand("review this", "gpt-5", "/repo");
    expect(command[0]).toBe("agent");
    expect(command).toContain("-p");
    // Read-only posture: --mode ask + --sandbox enabled, NO --force/--yolo.
    expect(command).toContain("--mode");
    expect(command[command.indexOf("--mode") + 1]).toBe("ask");
    expect(command).toContain("--sandbox");
    expect(command[command.indexOf("--sandbox") + 1]).toBe("enabled");
    expect(command).not.toContain("--force");
    expect(command).not.toContain("--yolo");
    // Headless print mode needs --trust to skip the interactive workspace-trust prompt.
    expect(command).toContain("--trust");
    // stream-json + partial output for live logs.
    expect(command).toContain("--output-format");
    expect(command[command.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(command).toContain("--stream-partial-output");
    // workspace matches launch cwd; model present.
    expect(command[command.indexOf("--workspace") + 1]).toBe("/repo");
    expect(command[command.indexOf("--model") + 1]).toBe("gpt-5");
    // Prompt is the trailing positional argv arg — agent reads it from argv, not stdin.
    expect(command[command.length - 1]).toBe("review this");
  });

  test("omits --model when model is Auto or empty", () => {
    expect(buildCursorCommand("p", "Auto", "/repo").command).not.toContain("--model");
    expect(buildCursorCommand("p", "", "/repo").command).not.toContain("--model");
    expect(buildCursorCommand("p", undefined, "/repo").command).not.toContain("--model");
  });

  test("omits --workspace when no cwd is provided", () => {
    expect(buildCursorCommand("p").command).not.toContain("--workspace");
  });
});

// ---------------------------------------------------------------------------
// NDJSON reduction — line buffering across arbitrary chunk boundaries
// ---------------------------------------------------------------------------

describe("reduceCursorStreamEvents", () => {
  test("reconstructs canonical text regardless of how the buffer is chunked", () => {
    const stdout =
      ndjson({ type: "system", subtype: "init", model: "Auto" }) +
      assistantDelta("Looking at ") +
      assistantDelta("the diff.") +
      ndjson({ type: "result", result: " Done." });

    // Whole buffer (the accumulated stdout is what onJobComplete parses).
    const whole = reduceCursorStreamEvents(stdout);
    expect(whole.canonicalText).toBe("Looking at the diff. Done.");

    // Re-joining arbitrary chunk splits must yield identical canonical text —
    // proves pipe chunk boundaries never corrupt a record.
    for (const parts of [2, 3, 7, stdout.length]) {
      const rejoined = chunkify(stdout, parts).join("");
      expect(reduceCursorStreamEvents(rejoined).canonicalText).toBe("Looking at the diff. Done.");
    }
  });

  test("filters duplicate partial-output flushes (model_call_id present)", () => {
    const stdout =
      assistantDelta("real ") +
      assistantDuplicate("DUPLICATE") + // skipped: model_call_id present
      assistantDelta("text");
    const { canonicalText } = reduceCursorStreamEvents(stdout);
    expect(canonicalText).toBe("real text");
    expect(canonicalText).not.toContain("DUPLICATE");
  });

  test("ignores malformed lines without aborting the reduction", () => {
    const stdout = assistantDelta("a") + "this is not json\n" + assistantDelta("b");
    const { canonicalText, recordCount } = reduceCursorStreamEvents(stdout);
    expect(canonicalText).toBe("ab");
    expect(recordCount).toBe(2); // malformed line not counted
  });
});

// ---------------------------------------------------------------------------
// Marker extraction — last block wins
// ---------------------------------------------------------------------------

describe("parseCursorStreamOutput", () => {
  test("extracts the LAST complete marker block from multi-message output", () => {
    // An earlier (stale/draft) block followed by the final authoritative one.
    const staleReview = { findings: [], summary: { correctness: "Correct", explanation: "draft", confidence: 0.1 } };
    const stdout =
      assistantDelta("Here is a draft:\n" + markerBlock(staleReview) + "\n") +
      assistantDelta("On reflection:\n" + markerBlock(validReview));

    const out = parseCursorStreamOutput(stdout);
    expect(out).not.toBeNull();
    expect(out!.summary.correctness).toBe("Issues Found");
    expect(out!.findings).toHaveLength(1);
    expect(out!.findings[0].file).toBe("packages/server/review.ts");
  });

  test("parses a single marker block spread across NDJSON records and chunks", () => {
    const full = "Commentary first.\n" + markerBlock(validReview);
    // Split the marker text itself across multiple assistant deltas.
    const half = Math.floor(full.length / 2);
    const stdout = assistantDelta(full.slice(0, half)) + assistantDelta(full.slice(half));
    // Then chunk the raw stdout at arbitrary byte boundaries.
    const rejoined = chunkify(stdout, 9).join("");
    const out = parseCursorStreamOutput(rejoined);
    expect(out).not.toBeNull();
    expect(out!.findings).toHaveLength(1);
  });

  test("returns null when the marker block is missing", () => {
    const stdout = assistantDelta("I found no issues. Everything looks correct.");
    expect(parseCursorStreamOutput(stdout)).toBeNull();
  });

  test("returns null when the marker block is opened but never closed", () => {
    const stdout = assistantDelta(`prose ${CURSOR_MARKER_OPEN}\n{"findings":[]`);
    expect(parseCursorStreamOutput(stdout)).toBeNull();
  });

  test("returns null when the marker block contains malformed JSON", () => {
    const stdout = assistantDelta(`${CURSOR_MARKER_OPEN}\n{ findings: [ }\n${CURSOR_MARKER_CLOSE}`);
    expect(parseCursorStreamOutput(stdout)).toBeNull();
  });

  test("returns null when JSON is valid but schema-invalid", () => {
    // Missing summary.confidence (and bad severity) — must fail validation.
    const bad = {
      findings: [{ file: "x.ts", line: 1, severity: "blocker", description: "d" }],
      summary: { correctness: "Issues Found", explanation: "e" },
    };
    const stdout = assistantDelta(markerBlock(bad));
    expect(parseCursorStreamOutput(stdout)).toBeNull();
  });

  test("returns null on empty stdout", () => {
    expect(parseCursorStreamOutput("")).toBeNull();
    expect(parseCursorStreamOutput("   \n  ")).toBeNull();
  });

  test("accepts an empty finding set with a valid summary", () => {
    const clean = { findings: [], summary: { correctness: "Correct", explanation: "No issues.", confidence: 1 } };
    const out = parseCursorStreamOutput(assistantDelta(markerBlock(clean)));
    expect(out).not.toBeNull();
    expect(out!.findings).toHaveLength(0);
    expect(out!.summary.correctness).toBe("Correct");
  });
});

// ---------------------------------------------------------------------------
// Schema validator (direct)
// ---------------------------------------------------------------------------

describe("validateCursorReviewOutput", () => {
  test("defaults end_line to line and reasoning to empty string", () => {
    const out = validateCursorReviewOutput({
      findings: [{ file: "a.ts", line: 5, severity: "nit", description: "d" }],
      summary: { correctness: "Issues Found", explanation: "e", confidence: 0.5 },
    });
    expect(out).not.toBeNull();
    expect(out!.findings[0].end_line).toBe(5);
    expect(out!.findings[0].reasoning).toBe("");
  });

  test("rejects non-object, missing findings array, and bad severity", () => {
    expect(validateCursorReviewOutput(null)).toBeNull();
    expect(validateCursorReviewOutput({ summary: { correctness: "c", explanation: "e", confidence: 1 } })).toBeNull();
    expect(
      validateCursorReviewOutput({
        findings: [{ file: "a.ts", line: 1, severity: "high", description: "d" }],
        summary: { correctness: "c", explanation: "e", confidence: 1 },
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Log formatting
// ---------------------------------------------------------------------------

describe("formatCursorLogEvent", () => {
  test("maps init / assistant-delta / tool_call / result and skips noise", () => {
    expect(formatCursorLogEvent(ndjson({ type: "system", subtype: "init", model: "Auto", session_id: "s1" }))).toContain("model=Auto");
    expect(formatCursorLogEvent(assistantDelta("hello").trim())).toBe("hello");
    expect(formatCursorLogEvent(ndjson({ type: "tool_call", subtype: "started", name: "read_file", args: { path: "x.ts" } }))).toContain("[read_file]");
    expect(formatCursorLogEvent(ndjson({ type: "tool_call", subtype: "completed", name: "read_file" }))).toBe("[read_file] completed");
    expect(formatCursorLogEvent(ndjson({ type: "result", duration_ms: 42, request_id: "r1" }))).toContain("42ms");
  });

  test("skips duplicate assistant flushes and malformed lines", () => {
    expect(formatCursorLogEvent(assistantDuplicate("dup").trim())).toBeNull();
    expect(formatCursorLogEvent("not json")).toBeNull();
    expect(formatCursorLogEvent(ndjson({ type: "user" }).trim())).toBeNull();
  });

  test("skips the final buffered assistant flush (no timestamp_ms) under partial output", () => {
    // End-of-turn flush carries no timestamp_ms and repeats already-streamed
    // deltas — showing it would duplicate the whole assistant output in live logs.
    expect(
      formatCursorLogEvent(ndjson({ type: "assistant", message: { content: "FULL FLUSH" } }).trim()),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Finding → annotation transform
// ---------------------------------------------------------------------------

describe("transformCursorFindings", () => {
  const findings: CursorFinding[] = [
    {
      file: "/repo/packages/server/review.ts",
      line: 10,
      end_line: 12,
      severity: "important",
      description: "Off-by-one in the loop bound.",
      reasoning: "Index reaches length, overrunning the array.",
    },
  ];

  test("produces the shared annotation shape with author Cursor and severity-prefixed text", () => {
    const [a] = transformCursorFindings(findings, "agent-abcd1234", "/repo");
    expect(a.source).toBe("agent-abcd1234");
    expect(a.filePath).toBe("packages/server/review.ts"); // relativized to cwd
    expect(a.lineStart).toBe(10);
    expect(a.lineEnd).toBe(12);
    expect(a.side).toBe("new");
    expect(a.scope).toBe("line");
    expect(a.type).toBe("comment");
    expect(a.author).toBe("Cursor");
    expect(a.severity).toBe("important");
    expect(a.text).toBe("[important] Off-by-one in the loop bound.");
    expect(a.reasoning).toBe("Index reaches length, overrunning the array.");
  });

  test("applies the workspace path transform when provided", () => {
    const [a] = transformCursorFindings(findings, "src", "/repo", (p) => `child/${p}`);
    expect(a.filePath).toBe("child/packages/server/review.ts");
  });

  test("drops findings without a file or numeric line", () => {
    const dirty = [
      ...findings,
      { file: "", line: 1, end_line: 1, severity: "nit", description: "x", reasoning: "" } as CursorFinding,
      { file: "y.ts", line: undefined as unknown as number, end_line: 1, severity: "nit", description: "x", reasoning: "" } as CursorFinding,
    ];
    expect(transformCursorFindings(dirty, "src", "/repo")).toHaveLength(1);
  });

  test("defaults lineEnd to lineStart when end_line is absent", () => {
    const f = [{ file: "/repo/a.ts", line: 7, severity: "nit", description: "d", reasoning: "" } as unknown as CursorFinding];
    expect(transformCursorFindings(f, "src", "/repo")[0].lineEnd).toBe(7);
  });
});

describe("parseCursorModelsOutput", () => {
  test("parses `id - Label` lines and skips the header + tip", () => {
    const out = [
      "Available models",
      "",
      "auto - Auto",
      "gpt-5.2 - GPT-5.2",
      "claude-opus-4-8-thinking-high - Opus 4.8 1M Thinking",
      "composer-2.5 - Composer 2.5 (current)",
      "",
      "Tip: use --model <id> (or /model <id> in interactive mode) to switch.",
    ].join("\n");
    const models = parseCursorModelsOutput(out);
    expect(models).toEqual([
      { id: "auto", label: "Auto" },
      { id: "gpt-5.2", label: "GPT-5.2" },
      { id: "claude-opus-4-8-thinking-high", label: "Opus 4.8 1M Thinking" },
      { id: "composer-2.5", label: "Composer 2.5 (current)" },
    ]);
  });

  test("returns [] for unauthenticated / empty output", () => {
    expect(parseCursorModelsOutput("No models available for this account.")).toEqual([]);
    expect(parseCursorModelsOutput("")).toEqual([]);
    expect(parseCursorModelsOutput("Not logged in")).toEqual([]);
  });

  test("dedupes repeated ids, keeping first", () => {
    const models = parseCursorModelsOutput("auto - Auto\nauto - Auto Again\ngpt-5.2 - GPT-5.2");
    expect(models).toEqual([
      { id: "auto", label: "Auto" },
      { id: "gpt-5.2", label: "GPT-5.2" },
    ]);
  });
});
