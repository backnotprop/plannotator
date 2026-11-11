import { diffArrays } from "diff";

/** Tag-aware HTML diff: returns the NEW document with changed text wrapped in `<ins>`/`<del>` (class `plannotator-diff`). Removed tags are dropped to keep the DOM balanced. */

type TokenKind = "tag" | "word" | "space";

interface Token {
  kind: TokenKind;
  value: string;
}

/** Alternatives in priority order: script, style (opaque whole elements), comments, other tags, whitespace runs, words. */
// Tag matching must skip `>` inside quoted attribute values, or the tag splits mid-attribute.
const TAG_INNER = `(?:"[^"]*"|'[^']*'|[^>])*`;
const TOKEN_RE = new RegExp(
  `<script\\b${TAG_INNER}>[\\s\\S]*?<\\/script\\s*>|` +
    `<style\\b${TAG_INNER}>[\\s\\S]*?<\\/style\\s*>|` +
    `<!--[\\s\\S]*?-->|` +
    `<${TAG_INNER}>|` +
    `\\s+|[^<\\s]+`,
  "gi",
);

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

function isText(token: Token): boolean {
  return token.kind !== "tag";
}

function isAllWhitespace(tokens: Token[]): boolean {
  return tokens.every((t) => t.kind === "space");
}

export function htmlDiff(oldHtml: string, newHtml: string): string {
  const oldTokens = tokenize(oldHtml);
  const newTokens = tokenize(newHtml);

  const parts = diffArrays(oldTokens, newTokens, {
    comparator: (a: Token, b: Token) => a.value === b.value,
  });

  const out: string[] = [];

  for (const part of parts) {
    const tokens = part.value as Token[];

    if (!part.added && !part.removed) {
      for (const t of tokens) out.push(t.value);
      continue;
    }

    if (part.removed) {
      // Pure-whitespace removed runs are dropped to avoid empty <del> wrappers.
      let buffer: Token[] = [];
      const flush = () => {
        if (buffer.length === 0) return;
        if (!isAllWhitespace(buffer)) {
          out.push('<del class="plannotator-diff">');
          for (const t of buffer) out.push(t.value);
          out.push("</del>");
        }
        buffer = [];
      };
      for (const t of tokens) {
        if (isText(t)) {
          buffer.push(t);
        } else {
          // Removed tags are dropped: emitting them would unbalance the DOM.
          flush();
        }
      }
      flush();
      continue;
    }

    let buffer: Token[] = [];
    const flush = () => {
      if (buffer.length === 0) return;
      if (isAllWhitespace(buffer)) {
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
