import { describe, expect, test } from "bun:test";
import { detectOrigin } from "./detect-origin";

describe("detectOrigin", () => {
  test("a DeepSeek Harness shell is dsh", () => {
    expect(detectOrigin({ DSH_SHELL: "1", DSH_SESSION_ID: "s1" })).toBe("dsh");
  });

  test("PLANNOTATOR_ORIGIN still wins over DSH_SHELL", () => {
    expect(detectOrigin({ DSH_SHELL: "1", PLANNOTATOR_ORIGIN: "codex" })).toBe("codex");
  });

  const inheritedDsh = { DSH_SHELL: "1", DSH_SESSION_ID: "s1", DSH_HOME: "/tmp/dsh" };
  test.each([
    ["Claude Code", { CLAUDECODE: "1" }, "claude-code"],
    ["Claude Code's Agent SDK", { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }, "claude-code"],
    ["the Claude Code mod's detached CLI", { PLANNOTATOR_SESSION_TAG: "claude-code:0b6e1c2a-4f1d-4c3e-9a51-2f7d8e9c1a20" }, "claude-code"],
    ["Pi", { PI_SESSION_ID: "pi-1" }, "claude-code"],
    ["Cursor's agent CLI", { CURSOR_AGENT: "1" }, "claude-code"],
    ["Codex", { CODEX_THREAD_ID: "t" }, "codex"],
    ["Copilot CLI", { COPILOT_CLI: "1" }, "copilot-cli"],
    ["OpenCode", { OPENCODE: "1" }, "opencode"],
    ["Gemini CLI", { GEMINI_CLI: "1" }, "gemini-cli"],
    ["Qwen Code", { QWEN_CODE_SESSION_ID: "q1" }, "qwen-code"],
    ["Qwen Code's shell tool", { QWEN_CODE: "1" }, "qwen-code"],
    ["oh-my-pi", { OMPCODE: "1" }, "oh-my-pi"],
    ["Amp (wrapper override)", { PLANNOTATOR_ORIGIN: "amp" }, "amp"],
    ["Droid (wrapper override)", { PLANNOTATOR_ORIGIN: "droid" }, "droid"],
    ["Kiro CLI (skill override)", { PLANNOTATOR_ORIGIN: "kiro-cli" }, "kiro-cli"],
    ["Mistral Vibe (skill override)", { PLANNOTATOR_ORIGIN: "mistral-vibe" }, "mistral-vibe"],
  ] as const)("%s started from a DSH shell is detected as itself", (_name, marker, origin) => {
    expect(detectOrigin({ ...inheritedDsh, ...marker })).toBe(origin);
  });

  test.each(["claude-code:", "nope:abc", "claude-code:../x", "garbage"])(
    "a malformed session tag (%s) does not hide DSH",
    (tag) => {
      expect(detectOrigin({ ...inheritedDsh, PLANNOTATOR_SESSION_TAG: tag })).toBe("dsh");
    },
  );

  test("an empty agent marker does not hide DSH", () => {
    expect(detectOrigin({ ...inheritedDsh, CLAUDECODE: "", CLAUDE_CODE_ENTRYPOINT: "", PI_SESSION_ID: "", CURSOR_AGENT: "", PLANNOTATOR_SESSION_TAG: "" })).toBe("dsh");
  });

  test("an unknown PLANNOTATOR_ORIGIN falls through to DSH_SHELL", () => {
    expect(detectOrigin({ DSH_SHELL: "1", PLANNOTATOR_ORIGIN: "nope" })).toBe("dsh");
  });

  test("no fingerprint is claude-code", () => {
    expect(detectOrigin({})).toBe("claude-code");
  });
});
