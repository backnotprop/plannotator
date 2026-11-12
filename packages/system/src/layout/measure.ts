export type TextSetting = {
  type: number;
  sans: string;
  mono: string;
};

export const DEFAULT_TEXT: TextSetting = {
  type: 14,
  sans: '"Inter Variable", "Inter", system-ui, sans-serif',
  mono: '"Geist Mono Variable", "Geist Mono", ui-monospace, monospace',
};

let text: TextSetting = DEFAULT_TEXT;

export const px = (n: number, type = text.type) => Math.max(n < 11 ? n : 11, (n * type) / 14);
export const lh = (n: number) => (n * text.type) / 14;

const make = (weight: string, size: number, face: 'sans' | 'mono', italic = false) =>
  `${italic ? 'italic ' : ''}${weight} ${px(size)}px ${face === 'sans' ? text.sans : text.mono}`;

export const FONTS = {
  title: '', q: '', plateName: '', plateRole: '', boxName: '', boxRole: '', mono: '', chipName: '', monoSm: '', rowName: '',
  rowRole: '', label: '', band: '', bandMeans: '', note: '', calloutTitle: '', calloutText: '', barName: '', port: '', tag: '',
  monoT: '', step: '', stepSub: '', laneName: '', laneSub: '',
};

function build(): void {
  Object.assign(FONTS, {
    title: make('600', 34, 'sans'),
    q: make('400', 16, 'sans'),
    plateName: make('600', 18, 'sans'),
    plateRole: make('400', 13.5, 'sans'),
    boxName: make('600', 15, 'sans'),
    boxRole: make('400', 12.5, 'sans'),
    mono: make('400', 11.5, 'mono'),
    chipName: make('600', 14, 'sans'),
    monoSm: make('400', 11, 'mono'),
    rowName: make('600', 14, 'sans'),
    rowRole: make('400', 12.5, 'sans'),
    label: make('400', 12.5, 'sans', true),
    band: make('600', 12.5, 'sans'),
    bandMeans: make('400', 12.5, 'sans', true),
    note: make('400', 13, 'sans'),
    calloutTitle: make('600', 17, 'sans'),
    calloutText: make('400', 13.5, 'sans'),
    barName: make('600', 15, 'sans'),
    port: make('500', 11.5, 'sans'),
    tag: make('500', 10, 'mono'),
    monoT: make('500', 10.5, 'mono'),
    step: make('600', 13.5, 'sans'),
    stepSub: make('400', 12.5, 'sans'),
    laneName: make('600', 14.5, 'sans'),
    laneSub: make('400', 11, 'mono'),
  });
}
build();

export function setText(next: TextSetting): TextSetting {
  const was = text;
  text = next;
  build();
  return was;
}
export const currentText = () => text;

let epoch = 0;
export const measureEpoch = () => epoch;

type Ctx = { font: string; measureText(t: string): { width: number } };
let ctx: Ctx | null | undefined;
const cache = new Map<string, number>();

function canvas(): Ctx | null {
  if (ctx !== undefined) return ctx;
  try {
    const c = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    ctx = c && typeof c.measureText === 'function' && c.measureText('MMMM').width > 0 ? (c as Ctx) : null;
  } catch {
    ctx = null;
  }
  return ctx;
}

function estimate(t: string, font: string): number {
  const m = /([\d.]+)px/.exec(font);
  const size = m ? Number(m[1]) : 13;
  const per = font.includes(text.mono) ? 0.6 : /^(italic )?(5|6)00/.test(font) ? 0.56 : 0.52;
  return [...t].length * size * per;
}

export function textWidth(t: string, font: string): number {
  const key = font + '\u0000' + t;
  const hit = cache.get(key);
  if (hit != null) return hit;
  const c = canvas();
  let v: number;
  if (c) {
    c.font = font;
    v = c.measureText(t).width;
  } else v = estimate(t, font);
  cache.set(key, v);
  return v;
}

const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/;
let graphemes: Intl.Segmenter | undefined;
const splitGraphemes = (w: string): string[] => {
  if (!graphemes && typeof Intl !== 'undefined' && Intl.Segmenter) graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return graphemes ? [...graphemes.segment(w)].map((x) => x.segment) : [...w];
};
type Tok = { t: string; sp: boolean };
function tokens(t: string): Tok[] {
  const out: Tok[] = [];
  for (const w of String(t).split(/\s+/).filter(Boolean)) {
    if (CJK.test(w)) splitGraphemes(w).forEach((g, i) => out.push({ t: g, sp: i === 0 && out.length > 0 }));
    else out.push({ t: w, sp: out.length > 0 });
  }
  return out;
}

export type Wrapped = { lines: string[]; width: number };

export function wrap(t: string | null | undefined, font: string, maxW: number): Wrapped {
  if (t == null || t === '') return { lines: [], width: 0 };
  const lines: string[] = [];
  let cur = '';
  const fits = (s: string) => textWidth(s, font) <= maxW;
  for (const tok of tokens(t)) {
    const next = cur ? cur + (tok.sp ? ' ' : '') + tok.t : tok.t;
    if (!cur || fits(next)) cur = next;
    else {
      lines.push(cur);
      cur = tok.t;
    }
    while (!fits(cur) && [...cur].length > 1) {
      const gs = splitGraphemes(cur);
      let k = gs.length - 1;
      while (k > 1 && !fits(gs.slice(0, k).join(''))) k--;
      lines.push(gs.slice(0, k).join(''));
      cur = gs.slice(k).join('');
    }
  }
  if (cur) lines.push(cur);
  return { lines, width: Math.max(...lines.map((l) => textWidth(l, font))) };
}

export function fitName(t: string, font: string, maxW: number, maxLines = 2): { lines: string[]; cut: boolean } {
  const lines: string[] = [];
  let cur = '';
  for (const tok of tokens(t)) {
    const next = cur ? cur + (tok.sp ? ' ' : '') + tok.t : tok.t;
    if (!cur || textWidth(next, font) <= maxW) cur = next;
    else {
      lines.push(cur);
      cur = tok.t;
    }
  }
  if (cur) lines.push(cur);
  const more = lines.length > maxLines;
  const out = lines.slice(0, maxLines);
  let cut = more;
  const ell = (l: string) => {
    let gs = splitGraphemes(l);
    while (gs.length > 1 && textWidth(gs.join('').trimEnd() + '…', font) > maxW) gs = gs.slice(0, -1);
    return gs.join('').trimEnd() + '…';
  };
  for (let i = 0; i < out.length; i++) {
    if (textWidth(out[i]!, font) > maxW || (more && i === out.length - 1)) {
      out[i] = ell(out[i]!);
      cut = true;
    }
  }
  return { lines: out, cut };
}

export function longestWord(t: string | null | undefined, font: string): number {
  if (!t) return 0;
  return Math.max(0, ...tokens(t).map((tok) => textWidth(tok.t, font)));
}

export function balance(t: string, font: string, maxW: number, maxLines = 2): Wrapped {
  const one = textWidth(t, font);
  if (one <= maxW) return { lines: [t], width: one };
  let lo = 40;
  let hi = maxW;
  let best = wrap(t, font, maxW);
  if (best.lines.length > maxLines) return best;
  while (hi - lo > 4) {
    const mid = (lo + hi) / 2;
    const r = wrap(t, font, mid);
    if (r.lines.length <= best.lines.length) {
      best = r;
      hi = mid;
    } else lo = mid;
  }
  return best;
}

export async function fontsReady(setting: TextSetting = text): Promise<void> {
  const fonts = typeof document !== 'undefined' ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
  if (fonts && typeof fonts.load === 'function') {
    const faces = [
      `400 13px ${setting.sans}`, `500 13px ${setting.sans}`, `600 13px ${setting.sans}`, `italic 400 13px ${setting.sans}`,
      `400 13px ${setting.mono}`, `500 13px ${setting.mono}`,
    ];
    try {
      await Promise.all(faces.map((f) => fonts.load(f)));
      await fonts.ready;
    } catch {
    }
  }
  cache.clear();
  epoch++;
}
