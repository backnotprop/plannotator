/**
 * GFM's extended autolinks that `InlineMarkdown` did not have yet: a bare
 * `www.` address and a bare e-mail address, plus HTML character references
 * (`&amp;`, `&copy;`, `&#8212;`) in prose. Bare `http(s)://` URLs are
 * `InlineMarkdown`'s own (`trimUrlTail`).
 *
 * Pure string functions: `InlineMarkdown` decides where they apply (never in
 * code, never inside a link or a link's label) and renders the result as
 * React text or an `<a>`, so no markup is ever built from the input.
 */

/**
 * Characters a bare URL runs through, as `InlineMarkdown`'s bare https rule.
 * Sticky, read at a position: the scanner calls these once per chunk of a
 * long paragraph, so nothing here copies or rescans the rest of the text.
 */
const WWW_AT = /www\.[A-Za-z0-9_-]{1,63}(?:\.[A-Za-z0-9_-]{1,63}){1,16}[^\s<>"']*/y;

/** GFM: an extended autolink starts a line, or follows white space or `*`, `_`, `~`, `(`. */
export function autolinkMayFollow(previousChar: string): boolean {
  return previousChar === '' || /[\s*_~(]/.test(previousChar);
}

/**
 * The trailing characters GFM leaves out of an extended autolink: sentence
 * punctuation (`?!.,:*_~`, plus the quotes and brackets `trimUrlTail` drops),
 * a `)` with no `(` to close, and an entity-shaped tail like `&hl;`.
 */
export function trimAutolinkTail(url: string): string {
  for (;;) {
    const before = url;
    url = url.replace(/&[A-Za-z0-9]+;$/, '');
    const last = url[url.length - 1];
    if (last && /[?!.,:;*_~"'\]}>]/.test(last)) url = url.slice(0, -1);
    else if (last === ')') {
      let opens = 0, closes = 0;
      for (const c of url) {
        if (c === '(') opens++;
        else if (c === ')') closes++;
      }
      if (closes > opens) url = url.slice(0, -1);
    }
    if (url === before) return url;
  }
}

/**
 * A `www.` autolink at the start of `text` (the text shown), or null. The
 * domain's last two labels hold no `_` (GFM); the address must have a dot
 * after `www.`, so `www.` alone or `www.x` is text.
 */
export function matchWwwAutolink(text: string, at = 0): string | null {
  if (!text.startsWith('www.', at)) return null;
  WWW_AT.lastIndex = at;
  const m = WWW_AT.exec(text);
  if (!m) return null;
  const shown = trimAutolinkTail(m[0]);
  const domain = /^[A-Za-z0-9._-]+/.exec(shown)![0].replace(/\.+$/, '');
  const labels = domain.split('.');
  if (labels.length < 3) return null;
  if (labels.slice(-2).some((label) => label.includes('_') || label === '')) return null;
  return shown;
}

/** The address a `www.` autolink opens. */
export const wwwAutolinkHref = (shown: string): string => `https://${shown}`;

/** An address: a local part of at most 64 characters (RFC 5321), then a domain of dotted labels. */
const EMAIL_AT = /[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9_-]{1,63}(?:\.[A-Za-z0-9_-]{1,63}){1,16}/y;
/** Whether an address's `@` follows at `at`, read no further than a local part can run. */
const EMAIL_LOCAL_THEN_AT = /[A-Za-z0-9._+-]{1,64}@/y;
/** The characters an e-mail address's local part is made of. */
const EMAIL_LOCAL_CHAR = /[A-Za-z0-9._+-]/;

/**
 * An e-mail autolink at the start of `text`, or null. GFM's rule, with two
 * guards so code-ish text stays text: the last label must hold a letter (no
 * `pkg@1.2.3`), and an address followed by `:` or `/` is an scp-style remote
 * (`git@github.com:org/repo.git`), not mail.
 */
export function matchEmailAutolink(text: string, at = 0): string | null {
  EMAIL_LOCAL_THEN_AT.lastIndex = at;
  if (!EMAIL_LOCAL_THEN_AT.test(text)) return null;
  EMAIL_AT.lastIndex = at;
  const m = EMAIL_AT.exec(text);
  if (!m) return null;
  let shown = m[0];
  while (/[._-]$/.test(shown)) shown = shown.slice(0, -1);
  const labels = shown.slice(shown.indexOf('@') + 1).split('.');
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1];
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(tld) || tld.length < 2) return null;
  if (/[-_]$/.test(shown)) return null;
  const after = text[at + shown.length];
  if (after === '@' || ((after === ':' || after === '/') && /\S/.test(text[at + shown.length + 1] ?? ''))) return null;
  return shown;
}

/**
 * Where a `www.` or e-mail autolink starts in `text`, after index 0 and
 * before `end`, when it runs past `end` (or -1). `InlineMarkdown` reads text
 * in chunks that end at `_`, `@`, `#`, `~`…: an address holding one would be
 * cut there, so the chunk stops where the address starts instead and the
 * loop's own autolink check takes it whole. An e-mail address always holds
 * the `@` that ends its chunk.
 */
export function autolinkRunningPast(text: string, end: number): number {
  // Only an address that starts before `end` counts: read no further.
  const window = text.slice(0, end + 3);
  let www = window.indexOf('www.', 1);
  while (www !== -1 && www < end) {
    if (autolinkMayFollow(text[www - 1]!)) {
      const shown = matchWwwAutolink(text, www);
      if (shown && www + shown.length > end) return www;
    }
    www = window.indexOf('www.', www + 1);
  }
  if (text[end] === '@' || text[end] === '_') {
    let start = end;
    while (start > 0 && end - start < 64 && EMAIL_LOCAL_CHAR.test(text[start - 1]!)) start--;
    if (start > 0 && start < end && emailMayFollow(text[start - 1]!)) {
      const shown = matchEmailAutolink(text, start);
      if (shown && start + shown.length > end) return start;
    }
  }
  return -1;
}

/** An e-mail address follows white space, punctuation that opens, or `:` (as in `mailto:`). */
export function emailMayFollow(previousChar: string): boolean {
  return previousChar === '' || /[\s*_~(\[{"':;,]/.test(previousChar);
}

/** `www.` autolinks wholly inside a chunk of plain text. */
export function findWwwAutolinks(text: string, previousChar: string): { start: number; end: number; shown: string }[] {
  const found: { start: number; end: number; shown: string }[] = [];
  let at = text.indexOf('www.');
  while (at !== -1) {
    const before = at === 0 ? previousChar : text[at - 1]!;
    const shown = autolinkMayFollow(before) ? matchWwwAutolink(text, at) : null;
    if (shown) {
      found.push({ start: at, end: at + shown.length, shown });
      at = text.indexOf('www.', at + shown.length);
    } else {
      at = text.indexOf('www.', at + 1);
    }
  }
  return found;
}

/**
 * Named character references decoded in prose. The common ones agents and
 * people type; a name not listed stays as written (CommonMark leaves an
 * unknown `&name;` literal, and so do we).
 */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷',
  micro: 'µ', middot: '·', para: '¶', sect: '§', bull: '•', hellip: '…', prime: '′', Prime: '″',
  mdash: '—', ndash: '–', minus: '−', shy: '­', thinsp: ' ', ensp: ' ', emsp: ' ', zwj: '‍', zwnj: '‌',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  iexcl: '¡', iquest: '¿', cent: '¢', pound: '£', yen: '¥', euro: '€', curren: '¤', permil: '‰',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', lArr: '⇐', rArr: '⇒', hArr: '⇔', crarr: '↵',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', equiv: '≡', infin: '∞', sum: '∑', prod: '∏', radic: '√', part: '∂',
  forall: '∀', exist: '∃', empty: '∅', nabla: '∇', isin: '∈', notin: '∉', cap: '∩', cup: '∪', and: '∧', or: '∨', not: '¬',
  frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', ordf: 'ª', ordm: 'º',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', tau: 'τ', phi: 'φ', omega: 'ω',
  Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', Pi: 'Π',
  check: '✓', cross: '✗', star: '☆', starf: '★', hearts: '♥', spades: '♠', clubs: '♣', diams: '♦', dagger: '†', Dagger: '‡', loz: '◊',
  acute: '´', uml: '¨', cedil: '¸', macr: '¯', circ: 'ˆ', tilde: '˜',
  Agrave: 'À', Aacute: 'Á', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç', Eacute: 'É', Egrave: 'È', Ntilde: 'Ñ', Ouml: 'Ö', Oslash: 'Ø', Uuml: 'Ü', szlig: 'ß',
  agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ', oacute: 'ó', ocirc: 'ô', ouml: 'ö', oslash: 'ø', uacute: 'ú', ucirc: 'û', uuml: 'ü', yuml: 'ÿ',
};

const ENTITY_AT = /^&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/;

/**
 * The character reference at the start of `text`: the characters it stands
 * for and its length, or null (not one, or a name not in the table). A number
 * naming no character (0, a surrogate, past U+10FFFF) is U+FFFD, as
 * CommonMark has it.
 */
export function matchHtmlEntity(text: string): { text: string; length: number } | null {
  if (text[0] !== '&') return null;
  const m = ENTITY_AT.exec(text);
  if (!m) return null;
  if (m[3] !== undefined) {
    const named = Object.prototype.hasOwnProperty.call(NAMED, m[3]) ? NAMED[m[3]] : undefined;
    return named === undefined ? null : { text: named, length: m[0].length };
  }
  const code = m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2]!, 16);
  const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
  return { text: valid ? String.fromCodePoint(code) : '�', length: m[0].length };
}

/** Every character reference in `text` decoded (the others left as written). */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&[#A-Za-z0-9]{2,33};/g, (whole) => matchHtmlEntity(whole)?.text ?? whole);
}
