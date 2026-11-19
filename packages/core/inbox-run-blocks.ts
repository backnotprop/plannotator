/**
 * Plannotator Inbox: commands the person runs with one press (`:::run`) and
 * secrets they save on their own computer (`:::secret`).
 *
 * An agent writes a `:::run` block when a command must run on the person's
 * computer, as them:
 *
 *   :::run
 *   Run the payment tests
 *   They call the sandbox with your test key; about a minute.
 *   Folder: apps/payments
 *
 *   ```sh
 *   bun test payments
 *   ```
 *   :::
 *
 * The first non-empty line is the title. `Folder:` (optional) is where it
 * runs, relative to the thread's project folder. `Uses: NAME, OTHER`
 * (optional) names saved secrets a program reads from its environment itself.
 * Every other line outside the fence is the reason. A run gets a saved secret
 * only when it names it: `$NAME` in the command, or `Uses:`. The one fenced code block is the command, byte for
 * byte: what the card shows is what runs. A block with no fence, or with more
 * than one, is not a run block (the window draws it as text, each fence with
 * its own Copy).
 *
 * A `:::secret` block names a value the person keeps on their computer:
 *
 *   :::secret
 *   PAYMENTS_TEST_KEY
 *   The payment tests need your Stripe test-mode secret key.
 *   Where: https://dashboard.stripe.com/test/apikeys
 *   :::
 *
 * First line: the name, env-var style. `Where:` (optional): a URL or a place
 * in words. Other lines: the reason.
 *
 * Both grammars are the Inbox's only; plan review draws either as a callout.
 * Pure: no I/O. Never throws on any input.
 */

import { blockKeyHash8, findDirectiveBlocks } from "./question-block";
import { isNegativeWaitValue } from "./inbox-questions";

export const INBOX_RUN_DIRECTIVE = "run";
export const INBOX_SECRET_DIRECTIVE = "secret";

/** A run block's key on the wire: `r-` + 8 hex, `-2`… for a repeat in one message. */
export const INBOX_RUN_KEY_RE = /^r-[0-9a-f]{8}(?:-\d{1,3})?$/;
/** A secret's name: env-var style, upper case, 2 to 64 characters. */
export const INBOX_SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * Names a secret may not have: programs read them to decide what runs and how it starts (a shell, its startup
 * files, a library or a config that runs code, an interpreter's options, git's helpers, which certificates to
 * trust), or every command needs them as they are (PATH, HOME). A value saved under one could make a command do
 * something other than what the card shows, or break every run. The one list the parser, the card and the server
 * read. Proxy and package-index URLs stay allowed: they often carry the credential itself.
 */
const TRUST_NAMES = [
  "GOSUMDB", "GONOSUMDB", "GONOSUMCHECK", "GOINSECURE", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE", "AWS_CA_BUNDLE", "NODE_TLS_REJECT_UNAUTHORIZED", "SSLKEYLOGFILE",
];
const TRUST_NAME_SET: ReadonlySet<string> = new Set(TRUST_NAMES);
export const INBOX_SECRET_REFUSED_NAMES: ReadonlySet<string> = new Set([
  // The shell and the session.
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "PWD", "OLDPWD", "IFS", "CDPATH", "ENV", "BASH_ENV", "ZDOTDIR",
  "PROMPT_COMMAND", "PS1", "PS2", "PS4", "TMPDIR", "TERM", "LANG", "TZ", "DISPLAY", "SSH_AUTH_SOCK",
  // Programs a command may hand control to.
  "EDITOR", "VISUAL", "PAGER", "MANPAGER", "BROWSER", "SSH_ASKPASS", "SUDO_ASKPASS", "RSYNC_RSH",
  // Interpreters' and build tools' startup options and module paths.
  "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "RUBYOPT", "RUBYLIB", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS",
  "JAVA_HOME", "JAVA_OPTS", "MAVEN_OPTS", "MAVEN_ARGS", "GRADLE_OPTS", "GRADLE_USER_HOME", "SBT_OPTS",
  "CLASSPATH", "LUA_INIT", "LUA_PATH", "LUA_CPATH", "GEM_HOME", "GEM_PATH", "BUNDLE_GEMFILE", "GOFLAGS", "GOTOOLCHAIN",
  "RUSTC_WRAPPER", "RUSTFLAGS", "CC", "CXX", "LESSOPEN", "LESSCLOSE", "ELECTRON_RUN_AS_NODE", "MAKEFLAGS", "MAKEFILES",
  "PHPRC", "PHP_INI_SCAN_DIR",
  // Libraries and configs that load or run code.
  "OPENSSL_CONF", "OPENSSL_ENGINES", "OPENSSL_MODULES", "GCONV_PATH", "KUBECONFIG", "DOCKER_HOST", "DOCKER_CONFIG",
  "DOCKER_CONTEXT", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "CURL_HOME", "WGETRC",
  // Which code and certificates are trusted.
  ...TRUST_NAMES,
  // Windows: how a program is found and started.
  "COMSPEC", "PATHEXT", "SYSTEMROOT", "WINDIR", "PSMODULEPATH", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
]);
/**
 * Name prefixes refused the same way: the loader, interpreters, git, npm, bash functions, Bun, Deno, .NET, Cargo,
 * rustup, this Inbox. `COR_` is the .NET profiler's (CORS_* is not caught).
 */
export const INBOX_SECRET_REFUSED_PREFIXES: readonly string[] = [
  "LD_", "DYLD_", "PYTHON", "PERL", "GIT_", "NPM_CONFIG_", "BASH_FUNC", "BUN_", "DENO_", "LC_", "XDG_", "DOTNET_",
  "COREHOST_", "COR_", "CORECLR_", "COMPLUS_", "CARGO_", "RUSTUP_", "PLANNOTATOR_",
];
/**
 * A name caught only by a prefix is still a secret's when it ends like one (GIT_TOKEN, CARGO_REGISTRY_TOKEN,
 * PYTHONANYWHERE_TOKEN): no startup variable of those families ends so. Never for this Inbox's own names.
 */
const SECRET_ENDING_RE = /_(?:TOKENS?|KEY|API_KEY|SECRET|PASSWORD)$/;

/** Whether a name may hold a secret (it has the shape, and no program reads it to start). */
export function inboxSecretNameRefused(name: string): boolean {
  if (INBOX_SECRET_REFUSED_NAMES.has(name)) return true;
  const prefix = INBOX_SECRET_REFUSED_PREFIXES.find((p) => name.startsWith(p));
  if (!prefix) return false;
  return prefix === "PLANNOTATOR_" || !SECRET_ENDING_RE.test(name);
}

/** Why a `Uses:` word gives the run nothing, for the card. */
export function inboxRunUnusableWords(words: readonly string[]): string | null {
  if (words.length === 0) return null;
  const refused = words.filter((w) => INBOX_SECRET_NAME_RE.test(w));
  const odd = words.filter((w) => !INBOX_SECRET_NAME_RE.test(w));
  const parts: string[] = [];
  const starts = refused.filter((w) => !TRUST_NAME_SET.has(w));
  const trusts = refused.filter((w) => TRUST_NAME_SET.has(w));
  if (starts.length > 0) parts.push(`${starts.join(", ")} can't hold a secret (programs read ${starts.length === 1 ? "it" : "them"} to decide how they start)`);
  if (trusts.length > 0) parts.push(`${trusts.join(", ")} can't hold a secret (${trusts.length === 1 ? "it changes" : "they change"} which servers programs trust)`);
  if (odd.length > 0) parts.push(`${odd.map((w) => `"${w}"`).join(", ")} ${odd.length === 1 ? "isn't a secret's name" : "aren't secrets' names"}`);
  return `Its Uses line names what this run can't get: ${parts.join("; ")}.`;
}

/** Why a refused name cannot hold a secret, for the card and the route's error. */
export function inboxSecretRefusedWords(name: string): string {
  if (TRUST_NAME_SET.has(name)) return `${name} can't hold a secret: it changes which servers programs trust, so a value saved under it could change who every command talks to.`;
  return `${name} can't hold a secret: programs read it to decide how they start, so a value saved under it could change what every command runs.`;
}

export interface ParsedInboxRun {
  key: string;
  title: string;
  /** The reason, or null. Markdown. */
  why: string | null;
  /** `Folder:` as written, or null (the project folder). */
  folder: string | null;
  /** The command, exactly the fence's lines joined with `\n`. */
  command: string;
  /** `Uses:` names: saved secrets the program reads from its environment itself. [] when none. */
  uses: string[];
  /** Words on `Uses:` that cannot be a secret here: not a name, or one programs start from. The card says so. */
  uses_unusable: string[];
  /** 1-based line of the block's opening `:::run`, as the Viewer's block has it. */
  startLine: number;
}

export interface ParsedInboxSecret {
  key: string;
  name: string;
  why: string | null;
  /** `Where:` as written, or null. */
  where: string | null;
  /** `Where:` when it is an http(s) URL. */
  where_url: string | null;
  /** The name is one no secret may have (inboxSecretNameRefused): the card says so and offers no field. */
  refused: boolean;
  startLine: number;
}

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const FOLDER_RE = /^folder\s*:\s*(.*)$/i;
const USES_RE = /^uses\s*:\s*(.*)$/i;
const WHERE_RE = /^where\s*:\s*(.*)$/i;

/** Direction marks and invisible characters, taken out of words the card draws (a title, a reason, a place). */
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE_WORDS_RE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\u00ad\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2800\u3164\uffa0\ufe00-\ufe0f]|[\u{E0000}-\u{E01EF}]/gu;
/** Words as the card may draw them: no direction mark or invisible character. */
export const inboxRunPlainWords = (text: string): string => text.replace(INVISIBLE_WORDS_RE, "");

/** One `:::run` block's inner text, or null when it is not one (no title, no fence, more than one fence). */
export function parseInboxRunBlock(inner: string): Omit<ParsedInboxRun, "key" | "startLine"> | null {
  const lines = inner.replace(/\r\n?/g, "\n").split("\n");
  let title: string | null = null;
  let folder: string | null = null;
  let uses: string[] | null = null;
  const unusable: string[] = [];
  const why: string[] = [];
  let command: string | null = null;
  let fences = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const open = FENCE_RE.exec(raw);
    if (open) {
      const marker = open[1]!;
      const indent = /^[ \t]*/.exec(raw)![0].length;
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const close = FENCE_RE.exec(lines[j]!);
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length && close[2]!.trim() === "") break;
        body.push(lines[j]!.slice(Math.min(indent, /^[ \t]*/.exec(lines[j]!)![0].length)));
      }
      fences += 1;
      if (fences === 1) command = body.join("\n");
      i = j;
      continue;
    }
    const line = raw.trim();
    if (line === "") continue;
    if (title === null) {
      title = inboxRunPlainWords(line);
      continue;
    }
    const usesLine = USES_RE.exec(line);
    // `Uses: none` (no, -, empty) is no Uses line, as `Stopped: no` is no stop: nothing it cannot use, and not the why.
    if (usesLine && uses === null && (usesLine[1]!.trim() === "" || isNegativeWaitValue(usesLine[1]!))) continue;
    if (usesLine && uses === null) {
      uses = [];
      // Split where a person would (spaces, commas, semicolons, bars), so a word that is not a name is said as written.
      for (const word of usesLine[1]!.split(/[\s,;|]+/)) {
        const name = word.replace(/[.:]+$/, "").replace(/^(["'`])(.*)\1$/, "$2").replace(/^\$\{?|\}$/g, "");
        if (name === "" || /^(and|or)$/i.test(name)) continue;
        if (INBOX_SECRET_NAME_RE.test(name) && !inboxSecretNameRefused(name)) {
          if (!uses.includes(name)) uses.push(name);
        } else if (!unusable.includes(name)) unusable.push(name);
      }
      continue;
    }
    const folderLine = FOLDER_RE.exec(line);
    if (folderLine && folder === null) {
      const value = folderLine[1]!.trim().replace(/^`(.*)`$/, "$1").trim();
      folder = value === "" ? null : value;
      continue;
    }
    why.push(inboxRunPlainWords(line));
  }
  if (title === null || command === null || fences !== 1 || command.trim() === "") return null;
  return { title, why: why.length > 0 ? why.join("\n") : null, folder, command, uses: uses ?? [], uses_unusable: unusable };
}

/** Every `:::run` block of a message body, in order, keys de-duplicated. [] when none. */
export function parseInboxRunBlocks(markdown: string): ParsedInboxRun[] {
  if (typeof markdown !== "string" || !/:::\s*run/i.test(markdown)) return [];
  const out: ParsedInboxRun[] = [];
  const seen = new Map<string, number>();
  for (const block of findDirectiveBlocks(markdown, { frontmatter: false })) {
    if (block.directiveKind !== INBOX_RUN_DIRECTIVE) continue;
    const parsed = parseInboxRunBlock(block.inner);
    if (!parsed) continue;
    const base = `r-${blockKeyHash8(parsed.command)}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    out.push({ ...parsed, key: count === 1 ? base : `${base}-${count}`, startLine: block.startLine });
  }
  return out;
}

/** One `:::secret` block's inner text, or null when its first line is not a name. */
export function parseInboxSecretBlock(inner: string): Omit<ParsedInboxSecret, "key" | "startLine"> | null {
  const lines = inner.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const first = lines.shift();
  if (first === undefined) return null;
  const name = first.replace(/^`(.*)`$/, "$1").replace(/^\$\{?([^}]*)\}?$/, "$1").trim();
  if (!INBOX_SECRET_NAME_RE.test(name)) return null;
  let where: string | null = null;
  const why: string[] = [];
  for (const line of lines) {
    const label = WHERE_RE.exec(line);
    if (label && where === null) {
      where = inboxRunPlainWords(label[1]!.trim()) || null;
      continue;
    }
    why.push(inboxRunPlainWords(line));
  }
  const url = where !== null && /^https?:\/\/\S+$/i.test(where) ? where : null;
  return { name, why: why.length > 0 ? why.join("\n") : null, where, where_url: url, refused: inboxSecretNameRefused(name) };
}

/** Every `:::secret` block of a message body, in order; a name asked twice in one message is the first. */
export function parseInboxSecretBlocks(markdown: string): ParsedInboxSecret[] {
  if (typeof markdown !== "string" || !/:::\s*secret/i.test(markdown)) return [];
  const out: ParsedInboxSecret[] = [];
  for (const block of findDirectiveBlocks(markdown, { frontmatter: false })) {
    if (block.directiveKind !== INBOX_SECRET_DIRECTIVE) continue;
    const parsed = parseInboxSecretBlock(block.inner);
    if (!parsed || out.some((s) => s.name === parsed.name)) continue;
    out.push({ ...parsed, key: `s-${parsed.name}`, startLine: block.startLine });
  }
  return out;
}

/** The `$NAME`, `${NAME}` and `$env:NAME` a command names that look like a secret's name, in order, once each. */
export function inboxRunNames(command: string): string[] {
  const out: string[] = [];
  for (const match of command.matchAll(/\$(?:\{|env:)?([A-Z][A-Z0-9_]{1,63})\b\}?/gi)) {
    const name = match[1]!;
    if (INBOX_SECRET_NAME_RE.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The saved secrets a run may get: the names its command names and its `Uses:` line, never a refused one. A run
 * gets these and no other; the card shows them ("Uses NAME").
 */
export function inboxRunSecretNames(block: Pick<ParsedInboxRun, "command" | "uses">): string[] {
  const out: string[] = [];
  for (const name of [...inboxRunNames(block.command), ...block.uses]) if (!inboxSecretNameRefused(name) && !out.includes(name)) out.push(name);
  return out;
}

// ─────────────────────────────── Hidden characters ───────────────────────────────

export interface InboxRunHiddenChar {
  /** The character in words, for the card ("a text-direction mark"). */
  what: string;
  /** `U+202E`. */
  code: string;
  /** 1-based line and character of the first one. */
  line: number;
  column: number;
}

const NAMED: Record<number, string> = {
  0x0d: "a carriage return",
  0x1b: "an escape character",
  0x00: "a null character",
  0x7f: "a delete character",
  0xa0: "a no-break space",
  0xad: "a soft hyphen",
  0x200b: "a zero-width space",
  0x200c: "a zero-width non-joiner",
  0x200d: "a zero-width joiner",
  0x2060: "a word joiner",
  0xfeff: "a zero-width no-break space",
  0x2028: "a line separator",
  0x2029: "a paragraph separator",
  0x2800: "a blank braille character",
};

/** Characters that render as nothing or as something else: control and format characters, odd spaces, fillers. */
const HIDDEN_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}͏ᅟᅠㅤﾠ︀-️\u17b4\u17b5\u180b-\u180f\u2800]|[\u{E0100}-\u{E01EF}]/u;

const isBidi = (cp: number): boolean => (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x200e || cp === 0x200f || cp === 0x061c;

/**
 * The first character of a command that could make it do something other than what it shows, or null. A command
 * may hold line breaks, tabs and plain spaces; nothing else that is invisible, a control or a direction mark.
 */
export function inboxRunHiddenChar(command: string): InboxRunHiddenChar | null {
  let line = 1;
  let column = 0;
  for (const char of command) {
    const cp = char.codePointAt(0)!;
    if (cp === 0x0a) {
      line += 1;
      column = 0;
      continue;
    }
    column += 1;
    if (cp === 0x09 || cp === 0x20) continue;
    if (!HIDDEN_RE.test(char)) continue;
    const code = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
    const what = isBidi(cp) ? "a text-direction mark" : (NAMED[cp] ?? (/\p{Zs}/u.test(char) ? "an unusual space" : "an invisible character"));
    return { what, code, line, column };
  }
  return null;
}

/** The command with each hidden character shown as `⟨U+XXXX⟩`, for the refusal's view of it. */
export function inboxRunShowHidden(command: string): string {
  let out = "";
  for (const char of command) {
    const cp = char.codePointAt(0)!;
    out += cp !== 0x0a && cp !== 0x09 && cp !== 0x20 && HIDDEN_RE.test(char) ? `⟨U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟩` : char;
  }
  return out;
}

/** The refusal in words, for the card and the route's error. A folder's says where in the folder line. */
export function inboxRunHiddenWords(hidden: InboxRunHiddenChar, where: "command" | "folder" = "command"): string {
  if (where === "folder") {
    return `Its folder has ${hidden.what} (${hidden.code}) at character ${hidden.column}. Hidden characters can make a folder read as another one, so it can't be run from here.`;
  }
  return `This command has ${hidden.what} (${hidden.code}) at line ${hidden.line}, character ${hidden.column}. Hidden characters can make a command do something other than what it shows, so it can't be run or copied from here.`;
}

/** The first hidden character of a block that the card must refuse: its command's, else its folder's. */
export function inboxRunBlockHidden(block: Pick<ParsedInboxRun, "command" | "folder">): { hidden: InboxRunHiddenChar; words: string; where: "command" | "folder" } | null {
  const inCommand = inboxRunHiddenChar(block.command);
  if (inCommand) return { hidden: inCommand, words: inboxRunHiddenWords(inCommand), where: "command" };
  const inFolder = block.folder === null ? null : inboxRunHiddenChar(block.folder);
  return inFolder ? { hidden: inFolder, words: inboxRunHiddenWords(inFolder, "folder"), where: "folder" } : null;
}

const LOOKALIKE_SCRIPTS: readonly [RegExp, string][] = [
  [/\p{Script=Cyrillic}/u, "Cyrillic"],
  [/\p{Script=Greek}/u, "Greek"],
  [/\p{Script=Armenian}/u, "Armenian"],
  [/\p{Script=Cherokee}/u, "Cherokee"],
];

/**
 * Letters, anywhere in a command, from an alphabet with look-alikes of Latin ones (Cyrillic `а` for `a`): the
 * card says so in a quiet line, and the command still runs. Null for a command with none.
 */
export function inboxRunLookalikes(command: string): string | null {
  const found = LOOKALIKE_SCRIPTS.filter(([re]) => re.test(command)).map(([, name]) => name);
  return found.length === 0 ? null : `This command has ${found.join(" and ")} letters, which can look like Latin ones. Check it before you run it.`;
}
