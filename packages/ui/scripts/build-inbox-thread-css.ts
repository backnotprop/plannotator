/**
 * Generate the stylesheet of the Inbox thread parts that ships in the npm
 * package: `@plannotator/ui/inbox-thread.css`.
 *
 * `packages/inbox/inbox.css` stays the only source. This script derives one
 * gitignored file from it at `prepack`, the pattern of `bridge-script.asset.js`.
 * The whole sheet ships, not a subset, in the source's order. Only what would
 * reach a host page outside its `.pn-inbox` root changes:
 *
 * - Comments go.
 * - A rule that styles the page itself (`html`, `body`, `#root`, `:root`, with
 *   or without `:has(.pn-inbox)`) goes, unless it only sets `--ib-*` tokens.
 * - Every other selector is scoped to `.pn-inbox` with `:where(.pn-inbox)`. It
 *   adds no specificity, so the sheet's own cascade is the source's. This
 *   covers the bare `.ib-*` classes, the unprefixed `.tp-*` and `.pm-*`
 *   classes, ui's elements (`pre code.pn-code`, `kbd[data-keycap]`) and
 *   `body:has(.pn-inbox) input`, which names `.pn-inbox` but styles every
 *   input on the page.
 * - A `@keyframes` name without the `ib-` prefix gets it, with its uses: the
 *   names are global, so a host's own would collide.
 *
 * An at-rule this script does not know (a new `@font-face`, say) fails the
 * build rather than ship unexamined. tests/inbox-thread-css.test.ts runs this
 * over the real source and checks the result from the outside.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The source, never written here. */
export const INBOX_CSS_PATH = resolve(uiDir, "../inbox/inbox.css");
/** The generated sheet, gitignored and listed in `files`. */
export const INBOX_THREAD_CSS_PATH = resolve(uiDir, "inbox-thread.css");

/** Requires a `.pn-inbox` ancestor and adds no specificity. */
const SCOPE = ":where(.pn-inbox)";

/** At-rules that hold rules, each one walked. */
const GROUP_AT_RULES = new Set(["media", "supports", "container", "layer"]);
/** At-rules copied as they are: `@keyframes` names are handled below, `@property` names are `--ib-*`. */
const VERBATIM_AT_RULES = new Set(["keyframes", "property"]);

export type CssNode =
  | { kind: "rule"; selectors: string[]; body: string }
  | { kind: "group"; prelude: string; children: CssNode[] }
  | { kind: "verbatim"; prelude: string; body: string };

/** The index just past the string that opens at `start`. */
function endOfString(css: string, start: number): number {
  const quote = css[start];
  for (let i = start + 1; i < css.length; i++) {
    if (css[i] === "\\") i++;
    else if (css[i] === quote) return i + 1;
  }
  throw new Error(`Unterminated string at offset ${start}`);
}

/** The index just past an unquoted `url(…)` at `start`, or `start` when there is none. */
function endOfUnquotedUrl(css: string, start: number): number {
  if (!/^url\(\s*[^\s"']/i.test(css.slice(start, start + 16))) return start;
  const end = css.indexOf(")", start);
  if (end < 0) throw new Error(`Unterminated url() at offset ${start}`);
  return end + 1;
}

export function stripComments(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const end = endOfString(css, i);
      out += css.slice(i, end);
      i = end;
    } else if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end < 0) throw new Error(`Unterminated comment at offset ${i}`);
      // A space, so the tokens on either side stay apart.
      out += " ";
      i = end + 2;
    } else {
      const end = endOfUnquotedUrl(css, i);
      if (end > i) {
        out += css.slice(i, end);
        i = end;
      } else {
        out += ch;
        i++;
      }
    }
  }
  return out;
}

/** The index of the `}` that closes the block whose `{` is at `open`. */
function endOfBlock(css: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      i = endOfString(css, i);
      continue;
    }
    const pastUrl = endOfUnquotedUrl(css, i);
    if (pastUrl > i) {
      i = pastUrl;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) return i;
    i++;
  }
  throw new Error(`Unclosed block at offset ${open}`);
}

/** Commas outside brackets and strings part a selector list. */
export function splitSelectorList(prelude: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < prelude.length) {
    const ch = prelude[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = endOfString(prelude, i);
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(prelude.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(prelude.slice(start));
  return parts.map((part) => part.trim().replace(/\s+/g, " ")).filter(Boolean);
}

/** One line per rule; a value holds no bare newline. A `--x: ;` keeps its space, the Soft switches depend on it. */
const flatten = (text: string) => text.trim().replace(/\s*\n\s*/g, " ");

export function parseCss(css: string): CssNode[] {
  const nodes: CssNode[] = [];
  let i = 0;
  let start = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      i = endOfString(css, i);
    } else if (ch === ";") {
      const statement = css.slice(start, i).trim();
      if (statement) throw new Error(`Unexpected statement outside a rule: ${statement.slice(0, 80)}`);
      start = ++i;
    } else if (ch === "}") {
      throw new Error(`Unmatched } at offset ${i}`);
    } else if (ch === "{") {
      const prelude = flatten(css.slice(start, i)).replace(/\s+/g, " ");
      const close = endOfBlock(css, i);
      const body = css.slice(i + 1, close);
      if (prelude.startsWith("@")) {
        const name = /^@([\w-]+)/.exec(prelude)?.[1] ?? "";
        if (GROUP_AT_RULES.has(name)) {
          nodes.push({ kind: "group", prelude, children: parseCss(body) });
        } else if (VERBATIM_AT_RULES.has(name)) {
          nodes.push({ kind: "verbatim", prelude, body: flatten(body) });
        } else {
          throw new Error(`@${name} in the source: decide what it does in a host page, then handle it here (${prelude})`);
        }
      } else {
        if (blanked(body).includes("{")) throw new Error(`Nested rule in ${prelude.slice(0, 80)}: not handled here`);
        nodes.push({ kind: "rule", selectors: splitSelectorList(prelude), body: flatten(body) });
      }
      i = close + 1;
      start = i;
    } else {
      i++;
    }
  }
  const rest = css.slice(start).trim();
  if (rest) throw new Error(`Unexpected text at the end: ${rest.slice(0, 80)}`);
  return nodes;
}

/** `text` with strings emptied, so a `{` inside `content: "{"` does not count. */
function blanked(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = endOfString(text, i);
      out += '""';
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

export interface ComplexSelector {
  compounds: string[];
  /** `combinators[i]` joins `compounds[i]` and `compounds[i + 1]`: " ", ">", "+" or "~". */
  combinators: string[];
}

export function splitComplexSelector(selector: string): ComplexSelector {
  const compounds: string[] = [];
  const combinators: string[] = [];
  let depth = 0;
  let current = "";
  let pending: string | null = null;
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i]!;
    if (ch === "\\") {
      current += selector.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = endOfString(selector, i);
      current += selector.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    const space = /\s/.test(ch);
    if (depth === 0 && (space || ch === ">" || ch === "+" || ch === "~")) {
      if (current) {
        compounds.push(current);
        current = "";
      }
      pending = space ? (pending ?? " ") : ch;
      i++;
      continue;
    }
    if (pending !== null) {
      if (compounds.length === 0) throw new Error(`A selector cannot open with a combinator: ${selector}`);
      combinators.push(pending);
      pending = null;
    }
    current += ch;
    i++;
  }
  if (current) compounds.push(current);
  return { compounds, combinators };
}

/**
 * Does this compound itself require `.pn-inbox`? Only outside brackets: a
 * `:has(.pn-inbox)` asks about a descendant and a `:not(.pn-inbox)` excludes it.
 */
function requiresInboxRoot(compound: string): boolean {
  let flat = "";
  let depth = 0;
  let i = 0;
  while (i < compound.length) {
    if (depth === 0 && compound.startsWith(SCOPE, i)) {
      flat += ".pn-inbox";
      i += SCOPE.length;
      continue;
    }
    const ch = compound[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0) flat += ch;
    i++;
  }
  return /\.pn-inbox(?![\w-])/.test(flat);
}

/** True when whatever this selector matches is `.pn-inbox` or inside it. */
function isScoped({ compounds, combinators }: ComplexSelector): boolean {
  return compounds.some((compound, i) => {
    if (!requiresInboxRoot(compound)) return false;
    const next = combinators[i];
    return next === undefined || next === " " || next === ">";
  });
}

/** The page's own element: a rule ending here styles the host, not the parts. */
const isPageCompound = (compound: string) => /^(?::root|html|body|#root)(?![\w-])/.test(compound);

/** The custom properties and properties a declaration block sets. */
function declaredNames(body: string): string[] {
  const flat = blanked(body).replace(/\([^()]*\)/g, "");
  return flat
    .split(";")
    .map((declaration) => declaration.split(":")[0]!.trim())
    .filter(Boolean);
}

export interface DroppedSelector {
  selector: string;
  /** The at-rules around it, outermost first. */
  within: string[];
  body: string;
}

/** `selector` scoped to `.pn-inbox`, or null when it styles the page itself and has to go. */
export function scopeSelector(selector: string, body: string): string | null {
  const parts = splitComplexSelector(selector);
  if (isScoped(parts)) return selector;
  const { compounds, combinators } = parts;
  let lead = 0;
  while (lead < compounds.length && isPageCompound(compounds[lead]!)) lead++;
  if (lead === compounds.length) {
    return declaredNames(body).every((name) => name.startsWith("--ib-")) ? selector : null;
  }
  if (lead === 0) return `${SCOPE} ${selector}`;
  if (combinators[lead - 1] !== " ") {
    throw new Error(`Cannot scope ${selector}: the page's element is not joined by a descendant combinator`);
  }
  const page = compounds.slice(0, lead);
  const rest = compounds.slice(lead);
  const restCombinators = combinators.slice(lead);
  let scopedRest = rest[0]!;
  rest.slice(1).forEach((compound, i) => {
    const combinator = restCombinators[i]!;
    scopedRest += combinator === " " ? ` ${compound}` : ` ${combinator} ${compound}`;
  });
  return `${page.join(" ")} ${SCOPE} ${scopedRest}`;
}

function collectKeyframes(nodes: readonly CssNode[], names: Set<string>): void {
  for (const node of nodes) {
    if (node.kind === "group") collectKeyframes(node.children, names);
    if (node.kind === "verbatim") {
      const name = /^@keyframes\s+(\S+)/.exec(node.prelude)?.[1];
      if (name) names.add(name);
    }
  }
}

function renameAnimations(body: string, renames: ReadonlyMap<string, string>): string {
  if (renames.size === 0) return body;
  return body.replace(/((?:^|[;\s])animation(?:-name)?\s*:)([^;]*)/g, (_whole, property: string, value: string) => {
    let next = value;
    for (const [from, to] of renames) {
      next = next.replace(new RegExp(`(?<![\\w-])${from}(?![\\w-])`, "g"), to);
    }
    return `${property}${next}`;
  });
}

function scopeNodes(
  nodes: readonly CssNode[],
  renames: ReadonlyMap<string, string>,
  within: readonly string[],
  dropped: DroppedSelector[],
): CssNode[] {
  const out: CssNode[] = [];
  for (const node of nodes) {
    if (node.kind === "rule") {
      const selectors: string[] = [];
      for (const selector of node.selectors) {
        const scoped = scopeSelector(selector, node.body);
        if (scoped === null) dropped.push({ selector, within: [...within], body: node.body });
        else selectors.push(scoped);
      }
      if (selectors.length > 0) out.push({ kind: "rule", selectors, body: renameAnimations(node.body, renames) });
    } else if (node.kind === "group") {
      const children = scopeNodes(node.children, renames, [...within, node.prelude], dropped);
      if (children.length > 0) out.push({ ...node, children });
    } else {
      const name = /^@keyframes\s+(\S+)/.exec(node.prelude)?.[1];
      const renamed = name === undefined ? undefined : renames.get(name);
      out.push(renamed === undefined ? node : { ...node, prelude: `@keyframes ${renamed}` });
    }
  }
  return out;
}

function renderNodes(nodes: readonly CssNode[], indent: string): string {
  return nodes
    .map((node) => {
      if (node.kind === "rule") return `${indent}${node.selectors.join(", ")} { ${node.body} }\n`;
      if (node.kind === "verbatim") return `${indent}${node.prelude} { ${node.body} }\n`;
      return `${indent}${node.prelude} {\n${renderNodes(node.children, `${indent}  `)}${indent}}\n`;
    })
    .join("");
}

export interface InboxThreadCss {
  css: string;
  /** Selectors that styled the page itself, so nothing of them ships. */
  dropped: DroppedSelector[];
  /** `@keyframes` names that gained the `ib-` prefix, source name to shipped name. */
  renamedKeyframes: ReadonlyMap<string, string>;
}

/** The generated sheet for a source sheet. Pure and deterministic. */
export function renderInboxThreadCss(source: string): InboxThreadCss {
  const tree = parseCss(stripComments(source));
  const keyframes = new Set<string>();
  collectKeyframes(tree, keyframes);
  const renamedKeyframes = new Map<string, string>();
  for (const name of keyframes) {
    if (!name.startsWith("ib-")) renamedKeyframes.set(name, `ib-${name}`);
  }
  const dropped: DroppedSelector[] = [];
  const css = renderNodes(scopeNodes(tree, renamedKeyframes, [], dropped), "");
  return { css, dropped, renamedKeyframes };
}

/** Generate from the real source into `path`; returns what was generated. */
export function writeInboxThreadCss(path: string = INBOX_THREAD_CSS_PATH): InboxThreadCss {
  const result = renderInboxThreadCss(readFileSync(INBOX_CSS_PATH, "utf8"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, result.css, "utf8");
  return result;
}

if (import.meta.main) {
  const { css, dropped, renamedKeyframes } = writeInboxThreadCss();
  console.log(`wrote ${INBOX_THREAD_CSS_PATH} (${css.length} chars, ${dropped.length} selectors dropped, ${renamedKeyframes.size} keyframes renamed)`);
}
