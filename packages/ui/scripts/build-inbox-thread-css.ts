/**
 * Generate `@plannotator/ui/inbox-thread.css` at `prepack` from `packages/inbox/inbox.css`, the only source,
 * in its order. Comments go. A rule on the page itself (`html`, `body`, `#root`, `:root`) goes unless it only
 * sets `--ib-*` tokens. Every other selector is scoped with `:where(.pn-inbox)`, which adds no specificity, and
 * a `@keyframes` name gains the `ib-` prefix with its uses. Anything else (an unknown at-rule, nested CSS,
 * `body > x`, a keyframe name held in a custom property) fails the build. tests/inbox-thread-css.test.ts checks
 * the result from the outside.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type AtRule, type Container, type Declaration, type Root, type Rule } from "postcss";

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const INBOX_CSS_PATH = resolve(uiDir, "../inbox/inbox.css");
const SCOPE = ":where(.pn-inbox)";
const GROUP_AT_RULES = new Set(["media", "supports", "container", "layer"]);
const VERBATIM_AT_RULES = new Set(["keyframes", "property"]);

export const parseSheet = (css: string): Root => postcss.parse(css);

/** A selector's compounds and combinators, with what is inside `()`, `[]` and strings emptied. `:where(.pn-inbox)` reads `.pn-inbox`. */
export function topLevel(selector: string): string[] {
  let flat = selector.replaceAll(SCOPE, ".pn-inbox").replace(/\\.|"[^"]*"|'[^']*'/g, "_");
  for (let was = ""; was !== flat; ) {
    was = flat;
    flat = flat.replace(/\([^()]*\)|\[[^[\]]*\]/g, "");
  }
  return flat.replace(/\s*([>+~])\s*/g, " $1 ").trim().split(/\s+/);
}

/** `selector` scoped to `.pn-inbox`, or null when it styles the page itself and has to go. */
function scopeSelector(selector: string, onlyTokens: boolean): string | null {
  const tokens = topLevel(selector);
  if (tokens.some((token, i) => /\.pn-inbox(?![\w-])/.test(token) && !/^[+~]$/.test(tokens[i + 1] ?? ""))) return selector;
  let lead = 0;
  while (lead < tokens.length && /^(?::root|html|body|#root)(?![\w-])/.test(tokens[lead]!)) lead++;
  if (lead === tokens.length) return onlyTokens ? selector : null;
  if (/^[>+~]$/.test(tokens[lead]!)) throw new Error(`Cannot scope ${selector}: only a descendant combinator can follow the page's element`);
  if (lead === 0) return `${SCOPE} ${selector}`;
  const words = postcss.list.space(selector);
  return [...words.slice(0, lead), SCOPE, ...words.slice(lead)].join(" ");
}

/** Move `@keyframes` names into `ib-`, with their uses. A name held in a custom property cannot be followed, so it fails. */
function renameKeyframes(root: Root): Map<string, string> {
  const renamed = new Map<string, string>();
  root.walkAtRules("keyframes", (rule) => {
    if (!/^[\w-]+$/.test(rule.params)) throw new Error(`@keyframes ${rule.params}: not a name this script can rename`);
    if (rule.params.startsWith("ib-")) return;
    renamed.set(rule.params, `ib-${rule.params}`);
    rule.params = `ib-${rule.params}`;
  });
  root.walkDecls((decl) => {
    for (const [from, to] of renamed) {
      const name = new RegExp(`(?<![\\w-])${from}(?![\\w-])`, "g");
      if (/^(?:-[a-z]+-)?animation(?:-name)?$/i.test(decl.prop)) decl.value = decl.value.replace(name, to);
      else if (decl.prop.startsWith("--") && name.test(decl.value)) throw new Error(`${decl.prop} holds @keyframes ${from}, which ships as ${to}: name it in animation directly`);
    }
  });
  return renamed;
}

/** One line per rule. A `--x: ;` keeps its space, the Soft switches depend on it. */
const flatten = (text: string) => text.trim().replace(/\s*\n\s*/g, " ");
const oneSpaced = (text: string) => flatten(text).replace(/\s+/g, " ");

/** What a block holds. The opening brace is past the selector, which may quote one. */
function inside(node: AtRule | Rule): string {
  const text = node.toString();
  return flatten(text.slice(text.indexOf("{", node.type === "rule" ? node.selector.length : 0) + 1, text.lastIndexOf("}")));
}

function render(parent: Container, within: string[], dropped: { selector: string; within: string[] }[], indent: string): string {
  const parts = (parent.nodes ?? []).map((node) => {
    if (node.type === "rule") {
      if (node.nodes.some((child) => child.type !== "decl")) throw new Error(`Nested rule in ${node.selector.slice(0, 80)}: not handled here`);
      const onlyTokens = (node.nodes as Declaration[]).every((decl) => decl.prop.startsWith("--ib-"));
      const selectors = node.selectors.map(oneSpaced).filter(Boolean).flatMap((selector) => {
        const scoped = scopeSelector(selector, onlyTokens);
        if (scoped === null) dropped.push({ selector, within });
        return scoped ?? [];
      });
      return selectors.length > 0 ? `${indent}${selectors.join(", ")} { ${inside(node)} }\n` : "";
    }
    if (node.type !== "atrule") throw new Error(`Unexpected text outside a rule: ${node.toString().slice(0, 80)}`);
    const prelude = oneSpaced(`@${node.name}${node.raws.afterName ?? ""}${node.params}`);
    if (node.nodes && VERBATIM_AT_RULES.has(node.name)) return `${indent}${prelude} { ${inside(node)} }\n`;
    if (!node.nodes || !GROUP_AT_RULES.has(node.name)) throw new Error(`@${node.name} in the source: decide what it does in a host page, then handle it here (${prelude})`);
    const children = render(node, [...within, prelude], dropped, `${indent}  `);
    return children ? `${indent}${prelude} {\n${children}${indent}}\n` : "";
  });
  return parts.join("");
}

/** The generated sheet for a source sheet. Pure and deterministic. */
export function renderInboxThreadCss(source: string) {
  const root = parseSheet(source);
  root.walkComments((comment) => void comment.remove());
  root.walk((node) => {
    // Text as written keeps its comments: { value, raw } goes for the parsed value, and spacing raws lose theirs.
    const raws = node.raws as Record<string, unknown>;
    for (const [key, raw] of Object.entries(raws)) {
      if (typeof raw === "object") delete raws[key];
      else if (typeof raw === "string") raws[key] = raw.replace(/\/\*[\s\S]*?\*\//g, " ");
    }
  });
  const renamedKeyframes = renameKeyframes(root);
  const dropped: { selector: string; within: string[] }[] = [];
  return { css: render(root, [], dropped, ""), dropped, renamedKeyframes };
}

if (import.meta.main) {
  const { css, dropped, renamedKeyframes } = renderInboxThreadCss(readFileSync(INBOX_CSS_PATH, "utf8"));
  writeFileSync(resolve(uiDir, "inbox-thread.css"), css, "utf8");
  console.log(`wrote inbox-thread.css (${css.length} chars, ${dropped.length} selectors dropped, ${renamedKeyframes.size} keyframes renamed)`);
}
