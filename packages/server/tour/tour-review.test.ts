import { describe, expect, test } from "bun:test";
import { writeFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTourClaudeCommand,
  buildTourUserMessage,
  parseTourStreamOutput,
  parseTourFileOutput,
} from "./tour-review";

const stop = {
  title: "Add retry",
  gist: "Wrap the fetch in a retry.",
  detail: "Three attempts, exponential backoff.",
  transition: "",
  anchors: [{ file: "src/a.ts", line: 1, end_line: 10, hunk: "", label: "retry" }],
};
const validOutput = {
  title: "Retry pass",
  greeting: "hi",
  intent: "",
  before: "",
  after: "",
  key_takeaways: [],
  stops: [stop],
  qa_checklist: [],
};

describe("parseTourStreamOutput", () => {
  test("returns parsed output from terminal result event", () => {
    const stdout = [
      JSON.stringify({ type: "assistant" }),
      JSON.stringify({ type: "result", is_error: false, structured_output: validOutput }),
    ].join("\n");
    expect(parseTourStreamOutput(stdout)).toEqual(validOutput);
  });

  test("returns null when result has is_error: true", () => {
    const stdout = JSON.stringify({ type: "result", is_error: true, structured_output: validOutput });
    expect(parseTourStreamOutput(stdout)).toBeNull();
  });

  test("returns null when stops array is empty", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, structured_output: { stops: [] } });
    expect(parseTourStreamOutput(stdout)).toBeNull();
  });

  test("returns null when structured_output has no stops key", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, structured_output: {} });
    expect(parseTourStreamOutput(stdout)).toBeNull();
  });

  test("returns null on empty input", () => {
    expect(parseTourStreamOutput("")).toBeNull();
    expect(parseTourStreamOutput("   \n  ")).toBeNull();
  });

  test("does not throw on truncated/malformed JSON", () => {
    const stdout = '{"type":"assistant"}\n{"type":"result","is_err';
    expect(parseTourStreamOutput(stdout)).toBeNull();
  });
});

describe("parseTourFileOutput", () => {
  test("returns null when file missing", async () => {
    const missing = join(tmpdir(), "plannotator-tour-missing-" + Date.now() + ".json");
    expect(await parseTourFileOutput(missing)).toBeNull();
  });

  test("returns parsed output and unlinks file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plannotator-tour-"));
    const file = join(dir, "out.json");
    await writeFile(file, JSON.stringify(validOutput));
    const result = await parseTourFileOutput(file);
    expect(result).toEqual(validOutput);
    expect(existsSync(file)).toBe(false);
  });

  test("returns null and unlinks file when JSON is malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plannotator-tour-"));
    const file = join(dir, "out.json");
    await writeFile(file, "{not json");
    const result = await parseTourFileOutput(file);
    expect(result).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  test("returns null when stops array is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plannotator-tour-"));
    const file = join(dir, "out.json");
    await writeFile(file, JSON.stringify({ stops: [] }));
    expect(await parseTourFileOutput(file)).toBeNull();
  });

  test("returns null when stops key missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plannotator-tour-"));
    const file = join(dir, "out.json");
    await writeFile(file, JSON.stringify({ other: 1 }));
    expect(await parseTourFileOutput(file)).toBeNull();
  });
});

describe("buildTourUserMessage", () => {
  const patch = "diff --git a/src/large.ts b/src/large.ts\n+const value = 1;\n";

  test("builds JJ tour instructions without inlining the patch", () => {
    const cases = [
      ["jj-current", "jj diff --git -r @"],
      ["jj-last", "jj diff --git -r @-"],
      ["jj-line", "jj diff --git --from 'heads(::@ & ::(trunk()))' --to @"],
      ["jj-all", "jj diff --git --from 'root()' --to @"],
    ] as const;

    for (const [diffType, command] of cases) {
      const message = buildTourUserMessage(patch, diffType, { defaultBranch: "trunk()" });
      expect(message).toContain("Walk the reviewer through");
      expect(message).toContain(command);
      expect(message).not.toContain(patch);
    }
  });

  test("falls back to the inline patch for unknown local diff types", () => {
    const message = buildTourUserMessage(patch, "p4-default");

    expect(message).toContain("Walk the reviewer through the following code changes");
    expect(message).toContain(patch);
  });
});

describe("buildTourClaudeCommand", () => {
  test("allows read-only JJ commands", () => {
    const command = buildTourClaudeCommand("tour").command;
    const allowedTools = command[command.indexOf("--allowedTools") + 1];

    expect(allowedTools).toContain("Bash(jj status:*)");
    expect(allowedTools).toContain("Bash(jj diff:*)");
    expect(allowedTools).toContain("Bash(jj log:*)");
    expect(allowedTools).toContain("Bash(jj show:*)");
    expect(allowedTools).toContain("Bash(jj file show:*)");
    expect(allowedTools).toContain("Bash(jj cat:*)");
    expect(allowedTools).toContain("Bash(jj bookmark list:*)");
  });
});
