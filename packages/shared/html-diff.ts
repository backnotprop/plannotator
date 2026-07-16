import { diffArrays } from "diff";

/**
 * Tag-aware HTML diff utility.
 *
 * Given two versions of an HTML document, {@link htmlDiff} returns a single merged
 * HTML string: the NEW document with changed TEXT wrapped in `<ins>...</ins>`
 * (added) and removed TEXT wrapped in `<del>...</del>` (deleted), so it can be
 * rendered to visually show what changed. Generated wrappers carry
 * `class="plannotator-diff"` so viewers can style diff output without touching
 * author-written `<ins>`/`<del>` markup (which passes through untagged).
 *
 * This is the classic "htmldiff" approach (à la the Ruby htmldiff / DaisyDiff
 * family): it diffs an ordered token stream where tokens are either complete
 * HTML tags or atomic words/whitespace runs, then reconstructs the NEW document
 * structure, dropping removed tags (to keep the DOM balanced) and wrapping only
 * contiguous text runs.
 *
 * The implementation is pure and runtime-agnostic (no Node/Bun globals), so both
 * the Bun and Pi servers can import it.
 */

/** Token classification produced by {@link tokenize}. */
type TokenKind = "tag" | "word" | "space";

interface Token {
  kind: TokenKind;
  value: string;
}

/**
 * Matches, in priority order:
 *   1. `<script ...>...</script>` (whole element, contents opaque)
 *   2. `<style ...>...</style>` (whole element, contents opaque)
 *   3. comments `<!-- ... -->`
 *   4. any other tag `<...>` (open/close/self-closing/doctype)
 *   5. a whitespace run
 *   6. a word: a run of non-whitespace, non-`<` characters
 *
 * The `i`/`s` flags make script/style/comment matching case-insensitive and let
 * `.` span newlines so multi-line opaque blocks are captured whole.
 */
// Tag matching must skip `>` inside quoted attribute values (title="a > b"),
// otherwise the tag splits mid-attribute and the diff corrupts the markup:
// `(?:"[^"]*"|'[^']*'|[^>])*` consumes quoted strings whole.
const TAG_INNER = `(?:"[^"]*"|'[^']*'|[^>])*`;
const TOKEN_RE = new RegExp(
  `<script\\b${TAG_INNER}>[\\s\\S]*?<\\/script\\s*>|` +
    `<style\\b${TAG_INNER}>[\\s\\S]*?<\\/style\\s*>|` +
    `<!--[\\s\\S]*?-->|` +
    `<${TAG_INNER}>|` +
    `\\s+|[^<\\s]+`,
  "gi",
);

/**
 * Split an HTML string into an ordered list of atomic tokens. A token is either
 * a complete HTML tag (including `<script>`/`<style>` elements captured whole so
 * their inner text is opaque and never diffed), a whitespace run, or a "word"
 * (a run of non-whitespace text characters). Entity refs like `&amp;` ride along
 * as part of a word.
 */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const matches = html.match(TOKEN_RE);
  if (!matches) return tokens;
  for (const value of matches) {
    let kind: TokenKind;
    if (value[0] === "<") {
      kind = "tag";
    } else if (/^\s+$/.test(value)) {
      kind = "space";
    } else {
      kind = "word";
    }
    tokens.push({ kind, value });
  }
  return tokens;
}

/** True for word/space tokens (i.e. everything that is not a tag). */
function isText(token: Token): boolean {
  return token.kind !== "tag";
}

/** True if every token in the run is whitespace (or the run is empty). */
function isAllWhitespace(tokens: Token[]): boolean {
  return tokens.every((t) => t.kind === "space");
}

/**
 * Compute a tag-aware HTML diff.
 *
 * @param oldHtml - the previous version of the document
 * @param newHtml - the current version of the document
 * @returns the NEW document with changed text wrapped in `<ins>`/`<del>` tags.
 *   When the inputs are identical, the output equals `newHtml` with no `<ins>` or
 *   `<del>` tags. Removed tags are dropped (never emitted) and `<ins>`/`<del>`
 *   are never placed around a tag, so the output stays structurally balanced.
 */
export function htmlDiff(oldHtml: string, newHtml: string): string {
  const oldTokens = tokenize(oldHtml);
  const newTokens = tokenize(newHtml);

  // Diff by exact string equality of token values. `diffArrays` works on arrays
  // of arbitrary items via the `comparator` option.
  const parts = diffArrays(oldTokens, newTokens, {
    comparator: (a: Token, b: Token) => a.value === b.value,
  });

  const out: string[] = [];

  for (const part of parts) {
    const tokens = part.value as Token[];

    if (!part.added && !part.removed) {
      // Equal run: emit verbatim.
      for (const t of tokens) out.push(t.value);
      continue;
    }

    if (part.removed) {
      // Removed run: drop tags entirely; wrap contiguous non-whitespace text in
      // a single <del>. Pure-whitespace removed runs are dropped silently to
      // avoid noisy <del> wrappers around invisible content.
      let buffer: Token[] = [];
      const flush = () => {
        if (buffer.length === 0) return;
        if (!isAllWhitespace(buffer)) {
          out.push('<del class="plannotator-diff">');
          for (const t of buffer) out.push(t.value);
          out.push("</del>");
        }
        // else: removed whitespace-only run is dropped.
        buffer = [];
      };
      for (const t of tokens) {
        if (isText(t)) {
          buffer.push(t);
        } else {
          // Tag in a removed run: drop it (emitting unbalanced removed tags
          // would corrupt the DOM).
          flush();
        }
      }
      flush();
      continue;
    }

    // part.added: emit tags as-is (they belong to the new structure); wrap
    // contiguous text runs in a single <ins>, keeping tags outside the wrapper.
    let buffer: Token[] = [];
    const flush = () => {
      if (buffer.length === 0) return;
      if (isAllWhitespace(buffer)) {
        // Added whitespace-only run: emit verbatim, no <ins> noise.
        for (const t of buffer) out.push(t.value);
      } else {
        out.push('<ins class="plannotator-diff">');
        for (const t of buffer) out.push(t.value);
        out.push("</ins>");
      }
      buffer = [];
    };
    for (const t of tokens) {
      if (isText(t)) {
        buffer.push(t);
      } else {
        flush();
        out.push(t.value);
      }
    }
    flush();
  }

  return out.join("");
}
