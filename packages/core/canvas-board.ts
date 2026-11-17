/**
 * The thread canvas's board: the small HTML an agent writes (`plannotator canvas --file board.html`), checked, patched
 * and stored by id. Browser-safe and dependency-free: the CLI, the Inbox server and the window share it.
 *
 * The rules and every message match the clean-room tool fresh agents were tested against (instructions v3): one line
 * per problem, naming the part and what to change, and nothing saved when there is one. Layout is not here: a real
 * browser lays the board out (`@plannotator/ui/components/canvas/lift`) and its warnings come back from there.
 */

export const BOARD_TAGS = new Set(["div", "p", "span", "b", "i", "img", "aside", "a", "br"]);
const VOID = new Set(["img", "br"]);
const NO_ID_NEEDED = new Set(["b", "span", "br", "a"]);
export const BOARD_VARS = ["ink", "muted", "paper", "sunk", "rule", "blue", "blue-soft", "green", "green-soft", "amber", "amber-soft", "red", "red-soft"] as const;
export const BOARD_FRAMES = new Set(["phone", "tablet", "browser"]);
export const BOARD_ANCHORS = new Set(["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"]);
const PCT_RE = /^(100|\d{1,2})% (100|\d{1,2})%$/;
export const atOk = (v: string): boolean => BOARD_ANCHORS.has(v) || PCT_RE.test(v);
const STYLE_OK = new Set([
  "display", "flex", "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis", "gap", "row-gap", "column-gap",
  "align-items", "align-self", "justify-content", "width", "height", "min-width", "max-width", "min-height", "max-height",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "border", "border-top", "border-right", "border-bottom", "border-left", "border-width", "border-style", "border-color",
  "border-radius", "background", "background-color", "color", "font-size", "font-weight", "font-style", "text-align",
  "text-decoration", "opacity", "line-height", "white-space",
]);
const COORD_PROPS = new Set(["left", "top", "right", "bottom", "position", "transform", "translate", "inset", "float", "z-index", "x", "y"]);
const COORD_ATTRS = new Set(["x", "y", "left", "top", "cx", "cy", "x1", "y1", "x2", "y2", "data-x", "data-y", "data-left", "data-top", "data-pos", "data-position"]);
const COLOR_PROPS = new Set(["color", "background", "background-color", "border", "border-top", "border-right", "border-bottom", "border-left", "border-color"]);
const COLOR_KEYWORDS = new Set(["solid", "dashed", "dotted", "none", "transparent", "inherit", "currentcolor", "double"]);
const DISPLAY_OK = new Set(["flex", "block", "inline-flex", "inline", "inline-block", "none"]);
const ATTRS: Record<string, Set<string>> = {
  "*": new Set(["id", "style"]),
  img: new Set(["src", "alt"]),
  div: new Set(["data-frame"]),
  aside: new Set(["data-note"]),
  a: new Set(["data-arrow", "from", "to", "at"]),
};
const COORD_HINT = 'the canvas places parts by layout, never by coordinates. Put parts side by side in a flex row or stacked in a flex column; for a note beside a part use <aside id="..." data-note="target-id">';
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const VARS_LIST = BOARD_VARS.map((x) => `var(--${x})`).join(" ");
export const BOARD_MAX_CHARS = 60000;

export type BoardChild = BoardNode | string;
export interface BoardNode {
  tag: string;
  attrs: Record<string, string>;
  children: BoardChild[];
  line: number;
  parent: BoardNode | null;
}

const isNode = (c: BoardChild): c is BoardNode => typeof c !== "string";
const node = (tag: string, attrs: Record<string, string>, line: number): BoardNode => ({ tag, attrs, children: [], line, parent: null });

export function* walk(n: BoardNode): Generator<BoardNode> {
  yield n;
  for (const c of n.children) if (isNode(c)) yield* walk(c);
}

export const textOf = (n: BoardNode): string => n.children.map((c) => (isNode(c) ? textOf(c) : c)).join("");

// ---------- parsing (the subset of HTML a board is; the clean-room tool used Python's HTMLParser) ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", middot: "·", rarr: "→", larr: "←", times: "×", check: "✓" };
export const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

const ATTR_TOKEN = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export interface ParsedBoard {
  root: BoardNode;
  errors: string[];
}

export function parseBoard(src: string, lineOffset = 0): ParsedBoard {
  const root = node("#root", {}, 0);
  const stack: BoardNode[] = [root];
  const errors: string[] = [];
  let i = 0;
  let line = 1;
  const advance = (to: number) => {
    for (let k = i; k < to; k++) if (src.charCodeAt(k) === 10) line++;
    i = to;
  };
  const top = () => stack[stack.length - 1];
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      top().children.push(decodeEntities(src.slice(i)));
      advance(src.length);
      break;
    }
    if (lt > i) {
      top().children.push(decodeEntities(src.slice(i, lt)));
      advance(lt);
    }
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      advance(end === -1 ? src.length : end + 3);
      continue;
    }
    if (src[i + 1] === "!" || src[i + 1] === "?") {
      const end = src.indexOf(">", i);
      errors.push(`line ${line + lineOffset}: <!${src.slice(i + 2, Math.min(end === -1 ? src.length : end, i + 22))}> is not part of a board; write only the parts`);
      advance(end === -1 ? src.length : end + 1);
      continue;
    }
    const close = /^<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>/.exec(src.slice(i));
    if (close) {
      const tag = close[1].toLowerCase();
      const ln = line + lineOffset;
      advance(i + close[0].length);
      if (VOID.has(tag)) continue;
      if (top().tag === tag) {
        stack.pop();
        continue;
      }
      const open = stack.slice(1).map((n) => n.tag);
      if (open.includes(tag)) {
        const t = top();
        errors.push(`line ${ln}: </${tag}> closes before <${t.tag} id="${t.attrs.id ?? "?"}"> (line ${t.line}) is closed; close inner tags first`);
        while (top().tag !== tag) stack.pop();
        stack.pop();
      } else errors.push(`line ${ln}: </${tag}> has no matching <${tag}>`);
      continue;
    }
    const open = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(src.slice(i));
    if (!open) {
      // A lone "<" in words.
      top().children.push("<");
      advance(i + 1);
      continue;
    }
    // Find the end of the tag, skipping quoted values.
    let j = i + open[0].length;
    let quote: string | null = null;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
    }
    const ln = line + lineOffset;
    const tag = open[1].toLowerCase();
    let body = src.slice(i + open[0].length, j);
    const selfClosing = /\/\s*$/.test(body);
    if (selfClosing) body = body.replace(/\/\s*$/, "");
    const attrs: Record<string, string> = {};
    const seen = new Set<string>();
    let twice = false;
    for (const m of body.matchAll(ATTR_TOKEN)) {
      const k = m[1].toLowerCase();
      if (seen.has(k)) twice = true;
      seen.add(k);
      if (!(k in attrs)) attrs[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
    }
    const n = node(tag, attrs, ln);
    if (twice) errors.push(`line ${ln}: <${tag}> has the same attribute twice`);
    n.parent = top();
    top().children.push(n);
    advance(Math.min(j + 1, src.length));
    if (!VOID.has(tag) && !selfClosing) stack.push(n);
  }
  for (const n of stack.slice(1)) errors.push(`line ${n.line}: <${n.tag} id="${n.attrs.id ?? "?"}"> is never closed`);
  return { root, errors };
}

// ---------- style ----------

export function parseStyle(s: string): [string, string | null][] {
  const out: [string, string | null][] = [];
  for (const part of s.split(";")) {
    if (!part.trim()) continue;
    const at = part.indexOf(":");
    if (at === -1) {
      out.push([part.trim().toLowerCase(), null]);
      continue;
    }
    out.push([part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim()]);
  }
  return out;
}

export const styleString = (pairs: [string, string][]): string => pairs.map(([k, v]) => `${k}:${v}`).join(";");

export function checkStyle(where: string, s: string): string[] {
  const errs: string[] = [];
  for (const [k, v] of parseStyle(s)) {
    if (v === null) {
      errs.push(`${where}: style "${k}" is not "property:value"`);
      continue;
    }
    if (COORD_PROPS.has(k)) {
      errs.push(`${where}: style "${k}:${v}" positions by coordinates; ${COORD_HINT}`);
      continue;
    }
    if (k.startsWith("grid") || (k === "display" && v.includes("grid"))) {
      errs.push(`${where}: grid is not supported; use flex rows and columns (display:flex;flex-direction:row|column)`);
      continue;
    }
    if (k === "font-family") {
      errs.push(`${where}: font-family is set by the canvas; remove it`);
      continue;
    }
    if (!STYLE_OK.has(k)) {
      errs.push(`${where}: style "${k}" is not supported. Supported: display, flex*, gap, align-items, justify-content, width, height, min-/max- sizes, padding*, margin*, border*, border-radius, background, color, font-size, font-weight, font-style, text-align, opacity, line-height`);
      continue;
    }
    if (k === "display" && !DISPLAY_OK.has(v)) errs.push(`${where}: display:${v} is not supported; use flex`);
    if (k.startsWith("margin") && /(^|\s)-\d/.test(v)) errs.push(`${where}: negative margin "${v}" overlaps parts by offset; ${COORD_HINT}`);
    if (k === "font-size") {
      const m = /^(\d+(?:\.\d+)?)px$/.exec(v);
      if (!m || !(Number(m[1]) >= 12 && Number(m[1]) <= 32)) errs.push(`${where}: font-size "${v}" must be 12px to 32px`);
    }
    if (v.includes("url(") || v.includes("gradient")) errs.push(`${where}: "${v}" is not supported; use a board colour, and <img> for pictures`);
    for (const m of v.matchAll(/var\(\s*--([\w-]+)\s*\)/g)) {
      if (!(BOARD_VARS as readonly string[]).includes(m[1])) errs.push(`${where}: var(--${m[1]}) is not a board colour. Board colours: ${VARS_LIST}`);
    }
    if (COLOR_PROPS.has(k) && /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(v)) {
      errs.push(`${where}: colour in "${k}:${v}" is not a board colour; use ${VARS_LIST}`);
    } else if (COLOR_PROPS.has(k)) {
      let rest = v.toLowerCase().replace(/var\(\s*--[\w-]+\s*\)/g, " ");
      rest = rest.replace(/-?\d+(\.\d+)?(px|%|em)?/g, " ");
      const bad = rest.split(/\s+/).filter((t) => t && !COLOR_KEYWORDS.has(t));
      if (bad.length) errs.push(`${where}: colour "${bad.join(" ")}" in "${k}:${v}" is not a board colour; use ${VARS_LIST}`);
    }
    if (["width", "height", "min-width", "min-height", "max-width", "max-height"].includes(k)) {
      const m = /^(\d+(?:\.\d+)?)px$/.exec(v);
      if (m && Number(m[1]) > 2000) errs.push(`${where}: ${k}:${v} is too large (max 2000px)`);
    }
  }
  return errs;
}

export const whereOf = (n: BoardNode): string => {
  const id = n.attrs.id ? ` id="${n.attrs.id}"` : "";
  return n.line ? `<${n.tag}${id}> (line ${n.line})` : `<${n.tag}${id}>`;
};

/** How a picture's src is checked and rewritten: the CLI resolves a path and copies the file; tests pass a stub. */
export interface BoardPictures {
  /** `src` as written, and the folder a relative path is read from. An error line's tail, or the src to store. */
  resolve(src: string, baseDir: string): { ok: true; src: string } | { ok: false; error: string };
}

const TAG_HINTS: Record<string, string> = {
  svg: "draw shapes with <i> boxes and text characters", table: "use flex rows", button: "draw it as a <div> with a border",
  input: "draw it as a <div> with a border", h1: "use <p> with font-size and font-weight", h2: "use <p> with font-size and font-weight",
  h3: "use <p> with font-size and font-weight", style: 'put styles inline in style="..."', script: "boards are static",
  ul: "use a flex column of <p>", li: "use <p>", section: "use <div>", header: "use <div>", nav: "use <div>",
};

/** Element-level checks that do not need the whole board. */
export function checkNodes(nodes: BoardNode[], pictures: BoardPictures, baseDir: string): string[] {
  const errs: string[] = [];
  for (const top of nodes) {
    for (const n of walk(top)) {
      const w = whereOf(n);
      if (!BOARD_TAGS.has(n.tag)) {
        const hint = TAG_HINTS[n.tag] ?? "";
        errs.push(`${w}: <${n.tag}> is not allowed. Allowed: div p span b i img aside a br${hint ? `; ${hint}` : ""}`);
        continue;
      }
      const allowed = new Set([...ATTRS["*"], ...(ATTRS[n.tag] ?? [])]);
      for (const [k, v] of Object.entries(n.attrs)) {
        if (COORD_ATTRS.has(k)) errs.push(`${w}: attribute ${k}="${v}" is a coordinate; ${COORD_HINT}`);
        else if (k === "class") errs.push(`${w}: class is not used; put styles inline in style="..."`);
        else if (!allowed.has(k)) errs.push(`${w}: attribute "${k}" is not used on <${n.tag}>. Allowed here: ${[...allowed].sort().join(" ")}`);
      }
      if ("style" in n.attrs) errs.push(...checkStyle(w, n.attrs.style));
      const id = n.attrs.id;
      if (id === undefined && !NO_ID_NEEDED.has(n.tag)) errs.push(`${w}: needs an id (every div, p, i, img and aside has one, so you can change it later)`);
      if (id !== undefined && !ID_RE.test(id)) errs.push(`${w}: id "${id}" must be lowercase letters, digits and dashes, starting with a letter`);
      if (n.tag === "img") {
        const src = n.attrs.src ?? "";
        if (!src) errs.push(`${w}: <img> needs src="/path/to/picture.png"`);
        else if (/^(data:|https?:)/.test(src)) errs.push(`${w}: src must be a file path, not a ${src.split(":")[0]} URL`);
        else {
          const r = pictures.resolve(src, baseDir);
          if (!("error" in r)) n.attrs.src = r.src;
          else errs.push(`${w}: ${r.error}`);
        }
      }
      if (n.tag === "a") {
        if (!("data-arrow" in n.attrs)) errs.push(`${w}: <a> is only for arrows: <a data-arrow from="id" to="id">label</a>`);
        else if (!n.attrs.from || !n.attrs.to) errs.push(`${w}: an arrow needs from="id" and to="id"`);
        else if (n.attrs.at && !atOk(n.attrs.at)) errs.push(`${w}: at="${n.attrs.at}" must be a region (${[...BOARD_ANCHORS].sort().join(" ")}) or a point in percent across and down the target, like at="30% 52%"`);
        if (n.children.some(isNode)) errs.push(`${w}: an arrow label is plain words only`);
      }
      if (n.tag === "div" && n.attrs["data-frame"] !== undefined && !BOARD_FRAMES.has(n.attrs["data-frame"])) {
        errs.push(`${w}: data-frame="${n.attrs["data-frame"]}" must be phone, tablet or browser`);
      }
      if (n.tag === "aside") {
        if (!n.attrs["data-note"]) errs.push(`${w}: <aside> is a note and needs data-note="target-id"`);
        if (n.children.some((c) => isNode(c) && !["b", "br", "span"].includes(c.tag))) errs.push(`${w}: a note holds words only (b, span, br allowed)`);
      }
    }
  }
  return errs;
}

const nearIds = (t: string, ids: Map<string, BoardNode>): string => {
  const stem = t.replace(/\d+$/, "");
  const c = [...ids.keys()].filter((i) => stem && i.startsWith(stem.slice(0, 4))).slice(0, 8);
  return c.length ? `. Ids like it: ${c.map((x) => `#${x}`).join(", ")}` : "";
};

export function checkBoard(root: BoardNode, deleted: ReadonlySet<string>): { errors: string[]; ids: Map<string, BoardNode> } {
  const errs: string[] = [];
  const ids = new Map<string, BoardNode>();
  for (const n of walk(root)) {
    if (n === root) continue;
    const i = n.attrs.id;
    if (i) {
      const was = ids.get(i);
      if (was) errs.push(`${whereOf(n)}: id "${i}" is already used by ${whereOf(was)}; ids must be unique`);
      else ids.set(i, n);
      if (deleted.has(i)) errs.push(`${whereOf(n)}: "${i}" was deleted by the person on the canvas; leave it out unless they ask for it back`);
    }
  }
  for (const n of walk(root)) {
    if (n.tag === "a" && n.attrs["data-arrow"] !== undefined) {
      for (const k of ["from", "to"] as const) {
        const t = (n.attrs[k] ?? "").replace(/^#+/, "");
        if (t && !ids.has(t)) errs.push(`${whereOf(n)}: arrow ${k}="${t}" names no part on the board${nearIds(t, ids)}`);
        if (t) n.attrs[k] = t;
      }
    }
    if (n.tag === "aside") {
      if (n.parent !== root) errs.push(`${whereOf(n)}: a note goes at the top level of the board, not inside another part`);
      const t = (n.attrs["data-note"] ?? "").replace(/^#+/, "");
      if (t) {
        n.attrs["data-note"] = t;
        if (!ids.has(t)) errs.push(`${whereOf(n)}: data-note="${t}" names no part on the board${nearIds(t, ids)}`);
        else if (ids.get(t)!.tag === "aside") errs.push(`${whereOf(n)}: a note points at a part, not at another note`);
      }
    }
  }
  for (const c of root.children) {
    if (typeof c === "string" && c.trim()) errs.push(`loose words at the top level: "${c.trim().slice(0, 40)}"; wrap them in <p id="...">`);
  }
  return { errors: errs, ids };
}

export function assignArrowIds(root: BoardNode, ids: Map<string, BoardNode>): void {
  for (const n of walk(root)) {
    if (n.tag === "a" && !n.attrs.id) {
      const base = `arrow-${n.attrs.from}-${n.attrs.to}`;
      let k = base;
      let j = 2;
      while (ids.has(k)) k = `${base}-${j++}`;
      n.attrs.id = k;
      ids.set(k, n);
    }
  }
}

// ---------- serializing ----------

const INLINE = new Set(["b", "span", "br"]);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");
const attrText = (n: BoardNode) => Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("");

function serInline(children: BoardChild[]): string {
  let out = "";
  for (const c of children) {
    if (typeof c === "string") out += esc(c);
    else out += VOID.has(c.tag) ? `<${c.tag}${attrText(c)}>` : `<${c.tag}${attrText(c)}>${serInline(c.children)}</${c.tag}>`;
  }
  return out.replace(/\s+/g, " ").trim();
}

function ser(n: BoardChild, ind = 0): string {
  const pad = " ".repeat(ind);
  if (typeof n === "string") return n.trim() ? pad + esc(n.trim()) : "";
  if (VOID.has(n.tag)) return `${pad}<${n.tag}${attrText(n)}>`;
  if (n.children.every((c) => typeof c === "string" || INLINE.has(c.tag))) return `${pad}<${n.tag}${attrText(n)}>${serInline(n.children)}</${n.tag}>`;
  const lines = [`${pad}<${n.tag}${attrText(n)}>`];
  for (const c of n.children) {
    const s = ser(c, ind + 1);
    if (s) lines.push(s);
  }
  lines.push(`${pad}</${n.tag}>`);
  return lines.join("\n");
}

export const serializeNode = (n: BoardNode): string => ser(n);
export const serializeBoard = (root: BoardNode): string => `${root.children.map((c) => ser(c)).filter(Boolean).join("\n")}\n`;

export function boardSummary(root: BoardNode): string {
  let parts = 0;
  let arrows = 0;
  let notes = 0;
  for (const n of walk(root)) {
    if (n === root) continue;
    if (n.attrs.id && n.tag !== "a") parts++;
    if (n.tag === "a") arrows++;
    if (n.tag === "aside") notes++;
  }
  return `${parts} parts with ids, ${arrows} arrow${arrows === 1 ? "" : "s"}, ${notes} note${notes === 1 ? "" : "s"}`;
}

export const findIds = (root: BoardNode): Map<string, BoardNode> => {
  const m = new Map<string, BoardNode>();
  for (const n of walk(root)) if (n !== root && n.attrs.id) m.set(n.attrs.id, n);
  return m;
};

// ---------- the person's standing on the board ----------

/** A part the person moved or resized: its box on the canvas, in canvas units. */
export interface BoardPin {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoardStanding {
  /** Parts the person moved or resized, by id. */
  pins: Record<string, BoardPin>;
  /** Parts the person deleted, in the order they were deleted. */
  deleted: string[];
  /** What each deleted part was (its board HTML), so the agent can offer it back. */
  deletedHtml: Record<string, string>;
}

export const emptyStanding = (): BoardStanding => ({ pins: {}, deleted: [], deletedHtml: {} });

// ---------- a whole board (--file) ----------

export type BoardWrite =
  | { ok: true; root: BoardNode; html: string; ids: Map<string, BoardNode>; pins: Record<string, BoardPin>; extra: string }
  | { ok: false; error: string };

const notSaved = (errs: string[], what: "board not saved" | "patch not applied, nothing changed") =>
  `error: ${what} (${errs.length} problem${errs.length === 1 ? "" : "s"}):\n${errs.slice(0, 30).map((e) => `- ${e}`).join("\n")}`;

/** Check a whole board. `version`: the canvas's latest agent version (0: none yet). */
export function writeBoard(src: string, standing: BoardStanding, version: number, pictures: BoardPictures, baseDir: string): BoardWrite {
  if (!src.trim()) return { ok: false, error: "error: the board is empty" };
  if (src.length > BOARD_MAX_CHARS) return { ok: false, error: `error: the board is ${src.length} characters; keep it under ${BOARD_MAX_CHARS} (split detail into a second board or simplify)` };
  if (/<\s*(html|head|body)\b/i.test(src)) return { ok: false, error: "error: write only the board parts, not a full page: remove <html>, <head> and <body>" };
  const { root, errors: perr } = parseBoard(src);
  const errs = [...perr, ...checkNodes(root.children.filter(isNode), pictures, baseDir)];
  const { errors: berrs, ids } = checkBoard(root, new Set(standing.deleted));
  errs.push(...berrs);
  if (errs.length) return { ok: false, error: notSaved(errs, "board not saved") };
  assignArrowIds(root, ids);
  let extra = "";
  const pins = { ...standing.pins };
  const pinIds = Object.keys(pins);
  if (pinIds.length) {
    const kept = pinIds.filter((p) => ids.has(p));
    const gone = pinIds.filter((p) => !ids.has(p));
    for (const g of gone) delete pins[g];
    if (kept.length) extra += `; kept the person's place and size for ${kept.map((k) => `#${k}`).join(", ")}`;
    if (gone.length) extra += `; the person had moved ${gone.map((k) => `#${k}`).join(", ")}, which your new board no longer has`;
  }
  if (version > 0) extra += "; replaced the whole board (use --patch for changes)";
  return { ok: true, root, html: serializeBoard(root), ids, pins, extra };
}

// ---------- a patch (--patch) ----------

const TEXT_RE = /^"((?:[^"\\]|\\.)*)"$/;
const ATTR_RE = /([a-z-]+)="((?:[^"\\]|\\.)*)"/g;
const SIZE_PROPS = new Set(["width", "height", "min-width", "min-height", "max-width", "max-height", "margin", "margin-top", "margin-left", "margin-right", "margin-bottom", "flex", "flex-basis", "flex-grow", "flex-shrink", "align-self"]);
const unq = (s: string) => s.replace(/\\(.)/g, "$1");

function parseTargets(s: string): { ts: string[]; bad: string[] } {
  const ts = s.split(",").map((t) => t.trim());
  return { ts: ts.map((t) => t.slice(1)), bad: ts.filter((t) => !/^#[a-z][a-z0-9-]*$/.test(t)) };
}

const ancestors = (n: BoardNode): BoardNode[] => {
  const out: BoardNode[] = [];
  let p = n.parent;
  while (p) {
    out.push(p);
    p = p.parent;
  }
  return out;
};

export type BoardPatch =
  | { ok: true; root: BoardNode; html: string; pins: Record<string, BoardPin>; applied: string[]; notes: string[]; ops: number }
  | { ok: false; error: string };

/**
 * Apply patch lines to the stored board, all or nothing. `thread` only names the read command in an error. A pinned
 * part's size may change (the tool says so: the agent does it only when the person asked); its place may not.
 */
export function patchBoard(boardHtml: string, patch: string, standing: BoardStanding, thread: string, pictures: BoardPictures, baseDir: string): BoardPatch {
  const { root } = parseBoard(boardHtml);
  const ids = findIds(root);
  const deleted = new Set(standing.deleted);
  const pins: Record<string, BoardPin> = Object.fromEntries(Object.entries(standing.pins).map(([k, v]) => [k, { ...v }]));
  const errs: string[] = [];
  const notes: string[] = [];
  const applied: string[] = [];
  const removedPinned = new Set<string>();
  let nops = 0;
  const lines = patch.split("\n");
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith("//")) return;
    nops++;
    const op = line.split(/\s+/, 1)[0].toLowerCase();
    const rest = line.slice(op.length).trim();
    const L = `line ${idx + 1}`;
    const targetOk = (t: string): boolean => {
      if (deleted.has(t)) {
        errs.push(`${L}: #${t} was deleted by the person on the canvas; leave it deleted unless they ask for it back`);
        return false;
      }
      if (!ids.has(t)) {
        errs.push(`${L}: no part #${t} on the board${nearIds(t, ids)}. See ids with: plannotator canvas read --thread ${thread} --html`);
        return false;
      }
      return true;
    };
    if (op === "set") {
      const m = /^(\S+)\s+(.*)$/.exec(rest);
      if (!m) return void errs.push(`${L}: set needs targets and attributes: set #a,#b style="..."`);
      const { ts, bad } = parseTargets(m[1]);
      if (bad.length) return void errs.push(`${L}: targets must be #ids separated by commas, got ${bad.join(" ")}`);
      const pairs = [...m[2].matchAll(ATTR_RE)].map((x) => [x[1], x[2]] as const);
      const leftover = m[2].replace(ATTR_RE, "").trim();
      if (leftover || !pairs.length) return void errs.push(`${L}: set takes name="value" pairs (style, src, alt, data-note, at); could not read "${leftover || m[2]}"`);
      for (const t of ts) {
        if (!targetOk(t)) continue;
        const n = ids.get(t)!;
        for (const [k, raw2] of pairs) {
          let v = unq(raw2);
          if (COORD_ATTRS.has(k)) {
            errs.push(`${L}: ${k}= is a coordinate; ${COORD_HINT}`);
            continue;
          }
          if (k === "id") {
            errs.push(`${L}: ids are stable; to rename a part remove it and add a new one`);
            continue;
          }
          if (k === "style") {
            const e = checkStyle(L, v);
            if (e.length) {
              errs.push(...e);
              continue;
            }
            const next = parseStyle(v) as [string, string][];
            if (pins[t]) {
              const sz = next.filter(([k2]) => SIZE_PROPS.has(k2)).map(([k2]) => k2);
              if (sz.length) {
                for (const [k2, v2] of next) {
                  const mm = /^(\d+(?:\.\d+)?)px$/.exec(v2);
                  if (k2 === "width" && mm) pins[t].w = Number(mm[1]);
                  if (k2 === "height" && mm) pins[t].h = Number(mm[1]);
                }
                notes.push(`#${t} is pinned by the person: your ${sz.join(", ")} replaces the size they gave it (do this only when they asked); it stays where they put it`);
              }
            }
            const old = parseStyle(n.attrs.style ?? "") as [string, string][];
            const d = new Map(old);
            const order = old.map(([k2]) => k2);
            for (const [k2, v2] of next) {
              if (!d.has(k2)) order.push(k2);
              d.set(k2, v2);
            }
            n.attrs.style = styleString(order.filter((k2) => !["", "unset"].includes(d.get(k2)!)).map((k2) => [k2, d.get(k2)!]));
            applied.push(`#${t} style: ${v}`);
          } else if ((k === "src" || k === "alt") && n.tag === "img") {
            if (k === "src") {
              if (/^(data:|https?:)/.test(v)) {
                errs.push(`${L}: src must be a file path, not a ${v.split(":")[0]} URL`);
                continue;
              }
              const r = pictures.resolve(v, baseDir);
              if ("error" in r) {
                errs.push(`${L}: ${r.error}`);
                continue;
              }
              v = r.src;
            }
            n.attrs[k] = v;
            applied.push(`#${t} ${k}: ${k === "src" ? "new picture" : `"${v}"`}`);
          } else if (["data-note", "at", "from", "to", "data-frame"].includes(k) && ATTRS[n.tag]?.has(k)) {
            n.attrs[k] = v.replace(/^#+/, "");
            applied.push(`#${t} ${k}: ${v}`);
          } else errs.push(`${L}: set cannot change "${k}" on <${n.tag}>; use style="...", or src/alt on a picture`);
        }
      }
    } else if (op === "text") {
      const m = /^(#\S+)\s+(.*)$/.exec(rest);
      if (!m) return void errs.push(`${L}: text needs one target and quoted words: text #id "new words"`);
      const { ts, bad } = parseTargets(m[1]);
      if (bad.length || ts.length !== 1) return void errs.push(`${L}: text changes one part: text #id "new words"`);
      const q = TEXT_RE.exec(m[2].trim());
      if (!q) return void errs.push(`${L}: put the words in double quotes: text #${ts[0]} "new words" (escape a quote inside as \\")`);
      const t = ts[0];
      if (!targetOk(t)) return;
      let n = ids.get(t)!;
      const kids = [...walk(n)].filter((c) => c !== n && c.attrs.id);
      if (kids.length) return void errs.push(`${L}: #${t} holds other parts (${kids.slice(0, 6).map((c) => `#${c.attrs.id}`).join(", ")}); text would erase them. Target the part that holds the words`);
      if (n.tag === "img") return void errs.push(`${L}: #${t} is a picture; set alt="..." instead`);
      // Keep a lone <b>/<span> wrapper (bold stays bold): replace the words inside it.
      for (;;) {
        const els = n.children.filter(isNode);
        const loose = n.children.filter((c): c is string => typeof c === "string").join("").trim();
        if (els.length === 1 && (els[0].tag === "b" || els[0].tag === "span") && !loose) n = els[0];
        else break;
      }
      n.children = [unq(q[1])];
      applied.push(`#${t} now reads "${unq(q[1])}"`);
    } else if (op === "add") {
      const m = /^(?:(after|before|into)\s+(#\S+)\s+)?(<[\s\S]*)$/.exec(rest);
      if (!m) return void errs.push(`${L}: add needs HTML on the same line: add after #id <div id="new">...</div> (or before, into; or just add <aside ...> for a top-level part)`);
      const [, where, tgt, frag] = m;
      const { root: froot, errors: perr0 } = parseBoard(frag);
      const perr = perr0.map((e) => e.replace(/^line \d+/, L));
      const fresh = froot.children.filter(isNode);
      for (const c of fresh) for (const x of walk(c)) x.line = 0;
      const e = [...perr, ...checkNodes(fresh, pictures, baseDir).map((x) => `${L}: ${x}`)];
      if (e.length) return void errs.push(...e);
      if (!fresh.length) return void errs.push(`${L}: nothing to add`);
      for (const c of fresh) {
        for (const x of walk(c)) {
          if (x.attrs.id && removedPinned.has(x.attrs.id)) errs.push(`${L}: re-adding #${x.attrs.id} would undo the person's move; keep the part and change it with set/text instead`);
        }
      }
      if (tgt) {
        const t = tgt.replace(/^#/, "");
        if (!targetOk(t)) return;
        const n = ids.get(t)!;
        if (where === "into") {
          if (VOID.has(n.tag) || n.tag === "aside" || n.tag === "a") return void errs.push(`${L}: cannot add into <${n.tag}>`);
          for (const c of fresh) c.parent = n;
          n.children.push(...fresh);
        } else {
          const par = n.parent!;
          const k = par.children.indexOf(n) + (where === "after" ? 1 : 0);
          for (const c of fresh) c.parent = par;
          par.children.splice(k, 0, ...fresh);
        }
      } else {
        for (const c of fresh) c.parent = root;
        root.children.push(...fresh);
      }
      applied.push(`added ${fresh.map((c) => `#${c.attrs.id ?? "?"}`).join(", ")} ${tgt ? `${where} #${tgt.replace(/^#/, "")}` : "at the top level"}`);
      for (const c of fresh) {
        for (const x of walk(c)) {
          const xid = x.attrs.id;
          if (xid && !ids.has(xid)) ids.set(xid, x);
          else if (xid) errs.push(`${L}: id "${xid}" is already used on the board; ids must be unique. Pick a new id`);
        }
      }
    } else if (op === "remove") {
      const { ts, bad } = parseTargets(rest);
      if (bad.length || !rest) return void errs.push(`${L}: remove takes #ids separated by commas: remove #a,#b`);
      for (const t of ts) {
        if (!targetOk(t)) continue;
        const n = ids.get(t)!;
        if (!n.parent || !n.parent.children.includes(n)) continue;
        n.parent.children.splice(n.parent.children.indexOf(n), 1);
        applied.push(`removed #${t}`);
        const gone = new Set<string>();
        for (const x of walk(n)) {
          const xid = x.attrs.id;
          if (!xid) continue;
          gone.add(xid);
          ids.delete(xid);
          if (pins[xid]) {
            removedPinned.add(xid);
            notes.push(`the person had moved #${xid}; it is removed now`);
          }
        }
        for (const x of [...walk(root)]) {
          if (!x.parent || !x.parent.children.includes(x)) continue;
          if (x.tag === "a" && (gone.has(x.attrs.from) || gone.has(x.attrs.to))) {
            x.parent.children.splice(x.parent.children.indexOf(x), 1);
            ids.delete(x.attrs.id);
            notes.push(`removed arrow #${x.attrs.id} with it`);
          } else if (x.tag === "aside" && gone.has(x.attrs["data-note"])) {
            x.parent.children.splice(x.parent.children.indexOf(x), 1);
            ids.delete(x.attrs.id);
            notes.push(`removed note #${x.attrs.id}, which pointed at it`);
          }
        }
      }
    } else if (op === "move") {
      const m = /^(#[a-z][a-z0-9-]*)\s+(after|before|into)\s+(#[a-z][a-z0-9-]*)\s*$/.exec(rest);
      if (!m) return void errs.push(`${L}: move reorders a part by id: move #part after|before|into #other. Parts are placed by layout, never by coordinates`);
      const a = m[1].slice(1);
      const where = m[2];
      const b = m[3].slice(1);
      const okA = targetOk(a);
      const okB = targetOk(b);
      if (!okA || !okB) return;
      if (pins[a]) return void errs.push(`${L}: #${a} was placed by the person; its place is theirs. If they asked you to move it, ask them to drag it, or remove the pin by asking them`);
      const n = ids.get(a)!;
      const t = ids.get(b)!;
      if ([t, ...ancestors(t)].includes(n)) return void errs.push(`${L}: cannot move #${a} into itself`);
      if (where === "into" && (VOID.has(t.tag) || t.tag === "aside" || t.tag === "a")) return void errs.push(`${L}: cannot move into <${t.tag}>`);
      n.parent!.children.splice(n.parent!.children.indexOf(n), 1);
      if (where === "into") {
        n.parent = t;
        t.children.push(n);
      } else {
        const par = t.parent!;
        const k = par.children.indexOf(t) + (where === "after" ? 1 : 0);
        n.parent = par;
        par.children.splice(k, 0, n);
      }
      applied.push(`moved #${a} ${where} #${b}`);
    } else if (op === "arrow") {
      const m = /^#([a-z][a-z0-9-]*)\s*->\s*#([a-z][a-z0-9-]*)(?:@([a-z-]+|\d{1,3}%,\d{1,3}%))?\s*(?:"((?:[^"\\]|\\.)*)")?\s*$/.exec(rest);
      if (!m) return void errs.push(`${L}: arrow #from -> #to "label" (label optional; #to@top-left or #to@30%,52% for a spot on a picture)`);
      const [, a, b, at0, label] = m;
      let ok = targetOk(a);
      ok = targetOk(b) && ok;
      let at = at0;
      if (at && at.includes("%")) at = at.replace(",", " ");
      if (at && !atOk(at)) {
        errs.push(`${L}: @${at} must be a region (${[...BOARD_ANCHORS].sort().join(" ")}) or percent across,down like @30%,52%`);
        ok = false;
      }
      if (!ok) return;
      const n = node("a", { "data-arrow": "", from: a, to: b, ...(at ? { at } : {}) }, 0);
      n.parent = root;
      if (label) n.children = [unq(label)];
      let k = `arrow-${a}-${b}`;
      let j = 2;
      while (ids.has(k)) k = `arrow-${a}-${b}-${j++}`;
      n.attrs.id = k;
      ids.set(k, n);
      root.children.push(n);
      applied.push(`arrow #${k} from #${a} to #${b}`);
    } else {
      let hint = "";
      if (["position", "place", "pos", "translate", "resize"].includes(op)) hint = " Parts are placed by layout, never by coordinates: reorder with move #part after #other, or change the container's flex style";
      else if (["replace", "update", "style"].includes(op)) hint = ' To change looks use set #id style="..."; to change words use text #id "..."';
      else if (op === "note") hint = ' A note is: add <aside id="n1" data-note="target-id">words</aside>';
      else if (op.startsWith("<")) hint = " To add HTML write: add after #id <div ...>";
      errs.push(`${L}: unknown op "${op}". Ops: set, text, add, move, remove, arrow.${hint}`);
    }
  });
  if (nops === 0) errs.push("the patch is empty; send one op per line on stdin");
  let ids2 = ids;
  if (!errs.length) {
    const checked = checkBoard(root, deleted);
    errs.push(...checked.errors);
    ids2 = checked.ids;
  }
  if (errs.length) return { ok: false, error: notSaved(errs, "patch not applied, nothing changed") };
  for (const p of Object.keys(pins)) if (!ids2.has(p)) delete pins[p];
  return { ok: true, root, html: serializeBoard(root), pins, applied, notes, ops: nops };
}

/** The reply to a saved write: `saved: board vN (...)`, then the layout's verdict (null: not laid out yet). */
export function savedReply(v: number, root: BoardNode, warnings: string[] | null, extra: string, patch?: { applied: string[]; notes: string[] }): string {
  const out = [`saved: board v${v} (${boardSummary(root)})${extra}.`];
  if (patch?.applied.length) out.push(`applied: ${patch.applied.join("; ")}`);
  if (warnings === null) {
    out.push("layout: not checked yet. The Inbox lays the board out in its window and none is open; it checks it when the person opens the Inbox. See its warnings later with: plannotator canvas read --thread <id>");
  } else if (warnings.length) {
    out.push("layout warnings (the board is saved, but it will look wrong; fix with a patch):");
    out.push(...warnings.map((w) => `- ${w}`));
  } else out.push("layout: no problems found.");
  if (patch?.notes.length) out.push(`note: ${patch.notes.join("; ")}`);
  return out.join("\n");
}

/** Remove the parts the person deleted from the stored board; what each was, for `read`. */
export function dropDeleted(boardHtml: string, gone: readonly string[]): { html: string; was: Record<string, string> } {
  const { root } = parseBoard(boardHtml);
  const ids = findIds(root);
  const was: Record<string, string> = {};
  for (const g of gone) {
    const n = ids.get(g);
    if (!n?.parent || !n.parent.children.includes(n)) continue;
    was[g] = serializeNode(n).replace(/\n\s*/g, "");
    n.parent.children.splice(n.parent.children.indexOf(n), 1);
    const inside = new Set([...walk(n)].map((x) => x.attrs.id).filter(Boolean));
    for (const x of [...walk(root)]) {
      if (!x.parent || !x.parent.children.includes(x)) continue;
      if ((x.tag === "a" && (inside.has(x.attrs.from) || inside.has(x.attrs.to))) || (x.tag === "aside" && inside.has(x.attrs["data-note"]))) {
        x.parent.children.splice(x.parent.children.indexOf(x), 1);
      }
    }
  }
  return { html: serializeBoard(root), was };
}
