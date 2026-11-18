/**
 * `:::run` and `:::secret`: what is a block, which bytes are its command, and which commands are refused for a
 * character the person cannot see. What regresses: a card running bytes other than the fence's, a second fence
 * slipping into the command, a hidden or direction character getting a Run button, the agent's examples no
 * longer parsing, and a report losing the exit code or the output's tail.
 */
import { describe, expect, test } from "bun:test";
import { inboxRunHiddenChar, inboxRunNames, inboxRunShowHidden, parseInboxRunBlocks, parseInboxSecretBlocks } from "./inbox-run-blocks";
import { INBOX_RUN_EXAMPLE, INBOX_RUN_REPORT_HEADING, INBOX_SECRET_EXAMPLE, inboxRunReportText, inboxSecretSavedText } from "./inbox-run-guide";

const run = (inner: string) => `Before.\n\n:::run\n${inner}\n:::\n\nAfter.`;

describe(":::run blocks", () => {
  test("the agent's example parses: title, why, folder and the command byte for byte", () => {
    const [block] = parseInboxRunBlocks(INBOX_RUN_EXAMPLE);
    expect(block).toMatchObject({ title: "Run the payment tests", folder: "apps/payments", command: "bun test payments", startLine: 1 });
    expect(block!.why).toContain("about a minute");
    expect(block!.key).toMatch(/^r-[0-9a-f]{8}$/);
  });

  test("the command keeps its lines, quotes, tabs and trailing spaces exactly", () => {
    const command = "set -e\n\tcd 'a b' && echo \"$HOME\"  \nprintf '%s\\n' done";
    const [block] = parseInboxRunBlocks(run(`Do it\n\n\`\`\`bash\n${command}\n\`\`\``));
    expect(block!.command).toBe(command);
  });

  test("a block with no fence, or with two, is not a run block (it stays text)", () => {
    expect(parseInboxRunBlocks(run("Do it\nno fence here"))).toEqual([]);
    expect(parseInboxRunBlocks(run("Do it\n```\necho one\n```\n```\necho two\n```"))).toEqual([]);
    expect(parseInboxRunBlocks(run("```\necho no title\n```"))).toEqual([]);
  });

  test("a :::run inside a code fence is not a block; the same command twice gets -2", () => {
    expect(parseInboxRunBlocks("```\n:::run\nX\n```sh\nls\n```\n:::\n```")).toEqual([]);
    const two = parseInboxRunBlocks(`${run("A\n```\nls\n```")}\n\n${run("B\n```\nls\n```")}`);
    expect(two.map((b) => b.key)).toEqual([two[0]!.key, `${two[0]!.key}-2`]);
  });

  test("the names a command uses, each once", () => {
    expect(inboxRunNames('curl -H "Bearer $API_TOKEN" ${API_TOKEN} $home $X')).toEqual(["API_TOKEN"]);
  });
});

describe("hidden characters", () => {
  test("plain commands, tabs and line breaks pass", () => {
    expect(inboxRunHiddenChar("echo hi\n\tls -la | grep x")).toBeNull();
    expect(inboxRunHiddenChar("echo 'café ✓ 日本'")).toBeNull();
  });

  test.each([
    ["a right-to-left override", "echo safe‮# txt.exe", "a text-direction mark", "U+202E"],
    ["a zero-width space", "rm -rf ./build​ /", "a zero-width space", "U+200B"],
    ["an escape sequence", "echo \u001b[2Kclean", "an escape character", "U+001B"],
    ["a carriage return", "echo ok\rrm -rf ~", "a carriage return", "U+000D"],
    ["a no-break space", "ls -la", "a no-break space", "U+00A0"],
    ["a tag character", "echo \u{E0041}", "an invisible character", "U+E0041"],
    ["a variation selector", "echo a️", "an invisible character", "U+FE0F"],
  ])("refuses %s, naming it and where it is", (_label, command, what, code) => {
    const found = inboxRunHiddenChar(command);
    expect(found).toMatchObject({ what, code, line: 1 });
    expect(inboxRunShowHidden(command)).toContain(`⟨${code}⟩`);
  });

  test("names the line and character of the first one", () => {
    expect(inboxRunHiddenChar("echo a\necho b⁦c")).toMatchObject({ line: 2, column: 7 });
  });
});

describe(":::secret blocks", () => {
  test("the agent's example parses: name, why, where as a link", () => {
    expect(parseInboxSecretBlocks(INBOX_SECRET_EXAMPLE)).toEqual([
      { key: "s-PAYMENTS_TEST_KEY", name: "PAYMENTS_TEST_KEY", why: "The payment tests need your test-mode secret key.", where: "https://dashboard.stripe.com/test/apikeys", where_url: "https://dashboard.stripe.com/test/apikeys", startLine: 1 },
    ]);
  });

  test("a first line that is not an env-style name is not a secret block", () => {
    expect(parseInboxSecretBlocks(":::secret\nmy key please\n:::")).toEqual([]);
    expect(parseInboxSecretBlocks(":::secret\n`$DEPLOY_TOKEN`\nWhere: the team vault\n:::")[0]).toMatchObject({ name: "DEPLOY_TOKEN", where: "the team vault", where_url: null });
  });
});

describe("what the agent gets", () => {
  const base = { title: "Run tests", command: "bun test", folder: "~/p", signal: null, waited_for_input: false } as const;

  test("a finished run: the exit code, the time and the output's last lines, in a fence the output cannot close", () => {
    const tail = Array.from({ length: 80 }, (_, i) => `line ${i}`);
    tail[79] = "```";
    const text = inboxRunReportText({ ...base, outcome: "exited", exit_code: 1, duration_ms: 3_200, tail, total_lines: 400 });
    expect(text.startsWith(`${INBOX_RUN_REPORT_HEADING}: "Run tests", in ~/p.`)).toBe(true);
    expect(text).toContain("It exited with code 1 after 3.2 s.");
    expect(text).toContain("The last 60 of 400 lines of output");
    expect(text).not.toContain("line 19\n");
    expect(text).toContain("line 20\n");
    expect(text).toContain("````text\n");
  });

  test("a stop that waited for typing says so; a failed start says why and has no output", () => {
    expect(inboxRunReportText({ ...base, outcome: "stopped", exit_code: null, duration_ms: 12_000, tail: ["Password:"], total_lines: 1, waited_for_input: true })).toContain("pressed Stop after 12 s; it was waiting for someone to type something");
    const failed = inboxRunReportText({ ...base, outcome: "failed_to_start", exit_code: null, duration_ms: 0, tail: [], total_lines: 0, error: "no such folder" });
    expect(failed).toContain("It did not start: no such folder.");
    expect(failed).not.toContain("```");
  });

  test("a save names the secret and how to use it, never a value", () => {
    expect(inboxSecretSavedText("API_TOKEN", false)).toBe("Saved API_TOKEN on this computer. Every :::run in this project now has it as $API_TOKEN; its value is never shown to you.");
  });
});
