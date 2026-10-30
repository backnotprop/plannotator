/**
 * Launch PR 2: what a permission question offers and what Claude Code is
 * told. The shapes are the ones bg-perm-test proved on a real `claude --bg`
 * (allow echoes `updatedInput`; deny carries a message that says not to
 * retry); "for this session" never writes the person's settings files.
 */
import { describe, expect, test } from "bun:test";
import {
  inboxPermissionDecision,
  inboxPermissionHookOutput,
  inboxPermissionQuestion,
  inboxPermissionSessionChoice,
  isPlanModeExit,
  readInboxPermissionEvent,
  type InboxPermissionEvent,
} from "./inbox-permission";
import { parseInboxQuestionBlocks } from "./inbox-questions";

/** The real stdin of bg-perm-test's first prompt (ids shortened). */
const REAL = {
  session_id: "ad91b9e9-14c6-4a91-8963-f1225b065020",
  transcript_path: "/Users/x/.claude/projects/w/ad91b9e9.jsonl",
  cwd: "/Users/x/work",
  prompt_id: "p-1",
  permission_mode: "default",
  effort: { level: "low" },
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "touch a.txt", description: "Create empty file a.txt" },
  permission_suggestions: [
    { type: "addDirectories", directories: ["/Users/x/work"], destination: "session" },
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ],
};

const event = (patch: Partial<InboxPermissionEvent> = {}): InboxPermissionEvent => ({ ...readInboxPermissionEvent(REAL)!, ...patch });

/** The choices as the store keeps them, read back from the body the Inbox writes. */
const parsedChoices = (body: string) => parseInboxQuestionBlocks(body)[0]!.parsed.choices.map((c) => c.label);

describe("the question", () => {
  test("the real stdin reads; ExitPlanMode is left to plan review", () => {
    expect(readInboxPermissionEvent(REAL)?.tool_name).toBe("Bash");
    expect(readInboxPermissionEvent({ tool_name: "Bash" })).toBeNull();
    expect(isPlanModeExit({ tool_name: "ExitPlanMode" })).toBe(true);
    expect(isPlanModeExit({ tool_name: "Bash" })).toBe(false);
  });

  test("one question card: the command, the folder, and Allow once / Allow … for this session / Deny", () => {
    const question = inboxPermissionQuestion(event(), { agent: "Claude Code", folder: "~/work" });
    const [block] = parseInboxQuestionBlocks(question.body);
    expect(parseInboxQuestionBlocks(question.body)).toHaveLength(1);
    expect(block!.prompt).toBe("Claude Code wants to run a command");
    expect(block!.parsed.context).toContain("touch a.txt");
    expect(block!.parsed.context).toContain("in `~/work`");
    expect(parsedChoices(question.body)).toEqual(["Allow once", "Allow file edits for this session", "Deny"]);
  });

  test("a command that holds a fence, a directive close or backticks stays inside the one card", () => {
    const command = "cat <<'EOF'\n:::\n```js\nx\n```\nEOF\necho `date`";
    const question = inboxPermissionQuestion(event({ tool_input: { command } }), { agent: "Claude Code", folder: "~/work" });
    const blocks = parseInboxQuestionBlocks(question.body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.parsed.context).toContain("echo `date`");
    expect(parsedChoices(question.body)).toEqual(question.choices);
  });

  test("no suggestion: Allow once and Deny only", () => {
    const question = inboxPermissionQuestion(event({ permission_suggestions: [] }), { agent: "Claude Code", folder: "~/work" });
    expect(parsedChoices(question.body)).toEqual(["Allow once", "Deny"]);
    expect(question.sessionUpdate).toBeNull();
  });
});

describe("the session choice", () => {
  test("a Bash rule names its command, and goes back with destination session (never the person's settings files)", () => {
    const choice = inboxPermissionSessionChoice(
      event({ permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "bun run:*" }], behavior: "allow", destination: "localSettings" }] }),
    );
    expect(choice?.label).toBe("Allow `bun run` for this session");
    expect(choice?.update).toEqual({ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "bun run:*" }], behavior: "allow", destination: "session" });
  });

  test("a rule comes before accepting edits, which comes before a folder", () => {
    const rules = { type: "addRules", rules: [{ toolName: "WebFetch", ruleContent: "domain:example.com" }], behavior: "allow", destination: "projectSettings" };
    expect(inboxPermissionSessionChoice(event({ permission_suggestions: [...REAL.permission_suggestions, rules] }))?.label).toBe("Allow pages on example.com for this session");
    expect(inboxPermissionSessionChoice(event())?.label).toBe("Allow file edits for this session");
    expect(inboxPermissionSessionChoice(event({ permission_suggestions: [REAL.permission_suggestions[0]!] }), (p) => p.replace("/Users/x", "~"))?.label).toBe(
      "Allow work in `~/work` for this session",
    );
  });

  test("a deny rule or a mode that skips every prompt is never offered", () => {
    expect(inboxPermissionSessionChoice(event({ permission_suggestions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }] }))).toBeNull();
    expect(inboxPermissionSessionChoice(event({ permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "deny" }] }))).toBeNull();
  });
});

describe("the decision", () => {
  const e = event();
  const question = inboxPermissionQuestion(e, { agent: "Claude Code", folder: "~/work" });
  const input = { event: e, choices: parsedChoices(question.body), sessionUpdate: question.sessionUpdate };
  const answer = (selected: string[], extra: { other?: string; note?: string; skipped?: boolean } = {}) => ({ v: 1 as const, key: "q-1", kind: "single" as const, prompt: "p", selected, ...extra });

  test("Allow once echoes the tool input, and nothing more", () => {
    expect(inboxPermissionDecision(answer(["Allow once"]), input)).toEqual({ behavior: "allow", updatedInput: REAL.tool_input });
  });

  test("Allow for this session adds the session update", () => {
    expect(inboxPermissionDecision(answer(["Allow file edits for this session"]), input)).toEqual({
      behavior: "allow",
      updatedInput: REAL.tool_input,
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
  });

  test("Deny tells the agent not to retry and to go on; a reason, typed or noted, rides along", () => {
    const plain = inboxPermissionDecision(answer(["Deny"]), input);
    expect(plain).toEqual({ behavior: "deny", message: "The person denied this in the Plannotator Inbox. Do not retry it; go on with the next step without it." });
    const typed = inboxPermissionDecision(answer([], { other: "Not on main." }), input);
    expect(typed.behavior === "deny" && typed.message.endsWith("Their reason: Not on main.")).toBe(true);
    const noted = inboxPermissionDecision(answer(["Deny"], { note: "Use a branch." }), input);
    expect(noted.behavior === "deny" && noted.message.endsWith("Their reason: Use a branch.")).toBe(true);
  });

  test("a Skip, no answer or a pick the question does not have is a Deny, never an allow", () => {
    expect(inboxPermissionDecision(answer(["Allow once"], { skipped: true }), input).behavior).toBe("deny");
    expect(inboxPermissionDecision(null, input).behavior).toBe("deny");
    expect(inboxPermissionDecision(answer(["Allow everything"]), input).behavior).toBe("deny");
  });

  test("the hook's stdout is Claude Code's PermissionRequest shape", () => {
    expect(JSON.parse(inboxPermissionHookOutput({ behavior: "allow", updatedInput: { command: "ls" } }))).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command: "ls" } } },
    });
  });
});
