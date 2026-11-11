/**
 * Test-only: the cascade of inbox.css for one element. happy-dom does not apply the space-toggle (a custom property set to `initial` makes `var(--token, fallback)` fall back) and drops rules it cannot resolve.
 * Not a general CSS engine.
 */

interface Declaration {
  prop: string;
  value: string;
  important: boolean;
}

interface Rule {
  selectors: string[];
  decls: Declaration[];
  layered: boolean;
  order: number;
}

export interface Winner {
  selector: string;
  value: string;
  important: boolean;
  inline: boolean;
}

export interface Cascade {
  /** The declaration that wins `prop` on `el`. Cached per element: build a new cascade after the DOM changes. */
  winner(el: Element, prop: string): Winner | undefined;
  resolved(el: Element, prop: string): string | undefined;
}

const INHERITED = new Set(['color', 'font-weight', 'font-size', 'letter-spacing', 'text-transform', 'line-height']);

function stripComments(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const ch = css[i]!;
    if (ch === '"' || ch === "'") {
      const end = skipString(css, i);
      out += css.slice(i, end);
      i = end;
    } else if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function skipString(s: string, i: number): number {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q) j += s[j] === '\\' ? 2 : 1;
  return j + 1;
}

function splitTop(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\') { i++; continue; }
    if (ch === '"' || ch === "'") { i = skipString(s, i) - 1; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === sep && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

function closeOf(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\') { i++; continue; }
    if (ch === '"' || ch === "'") { i = skipString(s, i) - 1; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return s.length;
}

function parseDecls(body: string): Declaration[] {
  const decls: Declaration[] = [];
  for (const raw of splitTop(body, ';')) {
    const colon = raw.indexOf(':');
    if (colon === -1) continue;
    const prop = raw.slice(0, colon).trim();
    if (!prop) continue;
    let value = raw.slice(colon + 1).trim();
    let important = false;
    const bang = /!\s*important\s*$/i.exec(value);
    if (bang) {
      important = true;
      value = value.slice(0, bang.index).trim();
    }
    decls.push({ prop: prop.startsWith('--') ? prop : prop.toLowerCase(), value, important });
  }
  return decls;
}

function parseBlock(css: string, layered: boolean, rules: Rule[]): void {
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    const semi = css.indexOf(';', i);
    if (open === -1) return;
    if (semi !== -1 && semi < open && css.slice(i, semi).trim().startsWith('@')) {
      i = semi + 1; // @import, @layer a, b; and the like
      continue;
    }
    const prelude = css.slice(i, open).trim();
    const close = closeOf(css, open);
    const body = css.slice(open + 1, close);
    i = close + 1;
    if (prelude.startsWith('@')) {
      const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase();
      if (name === 'supports') parseBlock(body, layered, rules);
      else if (name === 'layer') parseBlock(body, true, rules);
      // @media, @keyframes, @font-face, @property, @container: not applied.
      continue;
    }
    rules.push({ selectors: splitTop(prelude, ',').map((s) => s.trim()).filter(Boolean), decls: parseDecls(body), layered, order: rules.length });
  }
}

type Spec = [number, number, number];

function addSpec(a: Spec, b: Spec): Spec {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function compareSpec(a: Spec, b: Spec): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function specificity(selector: string): Spec {
  let spec: Spec = [0, 0, 0];
  let i = 0;
  const s = selector;
  const ident = () => {
    while (i < s.length && /[\w\-\\ -￿]/.test(s[i]!)) i += s[i] === '\\' ? 2 : 1;
  };
  const argsAt = () => {
    const open = i;
    let depth = 0;
    for (; i < s.length; i++) {
      if (s[i] === '\\') { i++; continue; }
      if (s[i] === '(') depth++;
      else if (s[i] === ')' && --depth === 0) { i++; break; }
    }
    return s.slice(open + 1, i - 1);
  };
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '#') { i++; ident(); spec = addSpec(spec, [1, 0, 0]); }
    else if (ch === '.') { i++; ident(); spec = addSpec(spec, [0, 1, 0]); }
    else if (ch === '[') { while (i < s.length && s[i] !== ']') i++; i++; spec = addSpec(spec, [0, 1, 0]); }
    else if (ch === ':' && s[i + 1] === ':') { i += 2; ident(); if (s[i] === '(') argsAt(); spec = addSpec(spec, [0, 0, 1]); }
    else if (ch === ':') {
      i++;
      const start = i;
      ident();
      const name = s.slice(start, i).toLowerCase();
      if (s[i] === '(') {
        const args = argsAt();
        if (name === 'where') continue;
        if (name === 'is' || name === 'not' || name === 'has') {
          let best: Spec = [0, 0, 0];
          for (const arg of splitTop(args, ',')) {
            const sp = specificity(arg.trim());
            if (compareSpec(sp, best) > 0) best = sp;
          }
          spec = addSpec(spec, best);
          continue;
        }
      }
      spec = addSpec(spec, [0, 1, 0]);
    } else if (/[a-zA-Z]/.test(ch)) { ident(); spec = addSpec(spec, [0, 0, 1]); }
    else i++;
  }
  return spec;
}

function safeMatches(el: Element, selector: string): boolean {
  if (selector.includes('::')) return false;
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

function substitute(value: string, lookup: (name: string) => string | undefined | null): string | undefined {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf('var(', i);
    if (at === -1) { out += value.slice(i); break; }
    out += value.slice(i, at);
    let depth = 0;
    let end = at + 3;
    for (; end < value.length; end++) {
      if (value[end] === '(') depth++;
      else if (value[end] === ')' && --depth === 0) break;
    }
    const inner = value.slice(at + 4, end);
    const comma = splitTop(inner, ',');
    const name = comma[0]!.trim();
    const fallback = comma.length > 1 ? comma.slice(1).join(',') : undefined;
    const got = lookup(name);
    let piece: string | undefined;
    if (got === null) piece = `var(${name})`; // never set by this stylesheet: the palette's own
    else if (got !== undefined) piece = got;
    else if (fallback !== undefined) piece = substitute(fallback.trim(), lookup);
    if (piece === undefined) return undefined;
    out += piece;
    i = end + 1;
  }
  return out;
}

export function loadCascade(cssText: string): Cascade {
  const rules: Rule[] = [];
  parseBlock(stripComments(cssText), false, rules);
  const declared = new Set<string>();
  const byProp = new Map<string, Rule[]>();
  for (const r of rules) {
    for (const d of r.decls) {
      if (d.prop.startsWith('--')) declared.add(d.prop);
      const list = byProp.get(d.prop) ?? [];
      if (list[list.length - 1] !== r) list.push(r);
      byProp.set(d.prop, list);
    }
  }
  const cache = new WeakMap<Element, Map<string, Winner | undefined>>();

  function winner(el: Element, prop: string): Winner | undefined {
    const mine = cache.get(el) ?? new Map<string, Winner | undefined>();
    cache.set(el, mine);
    if (mine.has(prop)) return mine.get(prop);
    const w = computeWinner(el, prop);
    mine.set(prop, w);
    return w;
  }

  function computeWinner(el: Element, prop: string): Winner | undefined {
    let best: { w: Winner; tier: number; spec: Spec; order: number } | undefined;
    const consider = (w: Winner, tier: number, spec: Spec, order: number) => {
      if (!best || tier > best.tier || (tier === best.tier && (compareSpec(spec, best.spec) > 0 || (compareSpec(spec, best.spec) === 0 && order > best.order)))) {
        best = { w, tier, spec, order };
      }
    };
    for (const rule of byProp.get(prop) ?? []) {
      const decl = [...rule.decls].reverse().find((d) => d.prop === prop);
      if (!decl) continue;
      let spec: Spec | undefined;
      let sel = '';
      for (const s of rule.selectors) {
        if (!safeMatches(el, s)) continue;
        const sp = specificity(s);
        if (!spec || compareSpec(sp, spec) > 0) { spec = sp; sel = s; }
      }
      if (!spec) continue;
      // Tiers: layered normal < unlayered normal < inline normal < unlayered important < layered important.
      const tier = decl.important ? (rule.layered ? 4 : 3) : rule.layered ? 0 : 1;
      consider({ selector: sel, value: decl.value, important: decl.important, inline: false }, tier, spec, rule.order);
    }
    const inline = (el as HTMLElement).style?.getPropertyValue?.(prop);
    if (inline) consider({ selector: '[style]', value: inline, important: false, inline: true }, 2, [1, 0, 0], Infinity);
    return best?.w;
  }

  function custom(el: Element | null, name: string, seen: Set<string> = new Set()): string | undefined | null {
    if (!el) return name.startsWith('--ib-') ? undefined : null;
    const w = winner(el, name);
    if (!w) return custom(el.parentElement, name, seen);
    if (w.value.trim() === 'initial') return undefined;
    if (w.value.trim() === 'inherit') return custom(el.parentElement, name, seen);
    if (seen.has(name)) return undefined;
    const next = new Set(seen).add(name);
    return substitute(w.value, (n) => (declared.has(n) ? custom(el, n, next) : external(n)))?.trim();
  }

  function external(name: string): undefined | null {
    return name.startsWith('--ib-') ? undefined : null;
  }

  function resolved(el: Element, prop: string): string | undefined {
    const w = winner(el, prop);
    const parent = el.parentElement;
    if (!w) return INHERITED.has(prop) && parent ? resolved(parent, prop) : undefined;
    const value = substitute(w.value, (n) => (declared.has(n) ? custom(el, n) : external(n)))?.trim();
    if (value === undefined || value === 'inherit' || (prop === 'color' && value.toLowerCase() === 'currentcolor')) {
      return INHERITED.has(prop) && parent ? resolved(parent, prop) : undefined;
    }
    return value;
  }

  return { winner, resolved };
}
