import type { ShapeCheck } from './shape';

export const SHAPE_SCENE_VERSION = 1;

export const SHAPE_SCENE_COLORS = [
  'ink', 'ink2', 'grey', 'rule', 'paper', 'surface', 'sunk',
  'mark', 'mark-soft', 'alert', 'alert-soft', 'blue', 'blue-soft', 'amber', 'amber-soft', 'green', 'green-soft', 'plum', 'plum-soft',
] as const;
export type ShapeSceneColor = (typeof SHAPE_SCENE_COLORS)[number];

export const SHAPE_SCENE_UNITS = ['step', 'ms', 's', 'µs', 'us', 'ns'] as const;
export type ShapeSceneUnit = (typeof SHAPE_SCENE_UNITS)[number];

export interface ShapeSceneKey {
  at: number;
  x?: number;
  y?: number;
  to?: string;
  along?: string;
  p?: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  rotate?: number;
  opacity?: number;
  color?: ShapeSceneColor;
  /** New words for the piece (its text). Words change at the key; they do not tween. */
  text?: string;
  draw?: number;
  lit?: boolean;
  ease?: 'smooth' | 'linear' | 'jump';
}

export interface ShapeSceneBeat {
  at: number;
  say: string;
  line?: number;
}

export interface ShapeScene {
  scene: 1;
  title: string;
  source?: string;
  unit?: ShapeSceneUnit;
  end: number;
  seconds?: number;
  code?: { lang?: string; lines: string[] };
  beats: ShapeSceneBeat[];
  legend?: { color: ShapeSceneColor; label: string }[];
  tracks: Record<string, ShapeSceneKey[]>;
}

export const SHAPE_SCENE_LIMITS = { tracks: 160, keys: 3000, keysPerTrack: 200, beats: 80, say: 180, title: 120, text: 80, legendLabel: 60, lines: 60, lineChars: 110, legend: 8, id: 40 } as const;

const ID_RE = /^[A-Za-z0-9_.:-]+$/;
const SCENE_KEYS = ['scene', 'title', 'source', 'unit', 'end', 'seconds', 'code', 'beats', 'legend', 'tracks'];
const KEY_KEYS = ['at', 'x', 'y', 'to', 'along', 'p', 'scale', 'scaleX', 'scaleY', 'rotate', 'opacity', 'color', 'text', 'draw', 'lit', 'ease'];
const BEAT_KEYS = ['at', 'say', 'line'];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const RESERVED = '__proto__';

/** Validate a scene. Every problem names its field, the way `checkShapeBoard` does. */
export function checkShapeScene(input: unknown, field = 'scene'): ShapeCheck<ShapeScene> {
  const errors: string[] = [];
  const fail = (at: string, why: string) => {
    if (errors.length < 30) errors.push(`${at}: ${why}`);
  };
  if (!isRecord(input)) return { ok: false, errors: [`${field}: must be an object { scene: 1, title, end, beats, tracks }`] };
  if (input.scene !== 1) fail(`${field}.scene`, 'must be 1 (the format version)');
  const only = (v: Record<string, unknown>, keys: readonly string[], at: string, what: string) => {
    for (const key of Object.keys(v)) if (!keys.includes(key)) fail(`${at}.${key}`, `is not part of ${what} (${keys.join(', ')})`);
  };
  only(input, SCENE_KEYS, field, 'a scene');
  const text = (v: unknown, at: string, max: number, required: boolean): string | undefined => {
    if (v === undefined || v === null) {
      if (required) fail(at, 'is required');
      return undefined;
    }
    if (typeof v !== 'string') return fail(at, 'must be text'), undefined;
    const t = v.trim();
    if (required && !t) fail(at, 'is empty');
    if (t.length > max) fail(at, `is ${t.length} characters; at most ${max}`);
    return t || undefined;
  };
  const color = (v: unknown, at: string): ShapeSceneColor | undefined => {
    if (v === undefined) return undefined;
    const name = typeof v === 'string' ? v.trim().replace(/^var\(--(.*)\)$/, '$1') : '';
    if ((SHAPE_SCENE_COLORS as readonly string[]).includes(name)) return name as ShapeSceneColor;
    fail(at, `must be a board colour: ${SHAPE_SCENE_COLORS.join(', ')}`);
    return undefined;
  };
  const num = (v: unknown, at: string, lo: number, hi: number, what = 'a number'): number | undefined => {
    if (v === undefined) return undefined;
    if (!isNum(v) || v < lo || v > hi) return fail(at, `must be ${what} from ${lo} to ${hi}`), undefined;
    return v;
  };

  const title = text(input.title, `${field}.title`, SHAPE_SCENE_LIMITS.title, true);
  const source = text(input.source, `${field}.source`, 200, false);
  let unit: ShapeSceneUnit | undefined;
  if (input.unit !== undefined) {
    if ((SHAPE_SCENE_UNITS as readonly unknown[]).includes(input.unit)) unit = input.unit as ShapeSceneUnit;
    else fail(`${field}.unit`, `must be one of ${SHAPE_SCENE_UNITS.join(', ')}`);
  }
  const end = isNum(input.end) && input.end > 0 ? input.end : (fail(`${field}.end`, 'must be a number above 0: the length of the timeline'), 1);
  const seconds = num(input.seconds, `${field}.seconds`, 1, 120);

  let code: ShapeScene['code'];
  if (input.code !== undefined) {
    if (!isRecord(input.code) || !Array.isArray(input.code.lines) || !input.code.lines.length) fail(`${field}.code`, 'must be { lang?, lines: ["…", …] }');
    else {
      only(input.code, ['lang', 'lines'], `${field}.code`, 'code');
      if (input.code.lines.length > SHAPE_SCENE_LIMITS.lines) fail(`${field}.code.lines`, `has ${input.code.lines.length} lines; at most ${SHAPE_SCENE_LIMITS.lines}`);
      const lines = input.code.lines.slice(0, SHAPE_SCENE_LIMITS.lines).map((l, i) => {
        if (typeof l !== 'string') return fail(`${field}.code.lines[${i}]`, 'must be text'), '';
        if (l.length > SHAPE_SCENE_LIMITS.lineChars) fail(`${field}.code.lines[${i}]`, `is ${l.length} characters; at most ${SHAPE_SCENE_LIMITS.lineChars}`);
        return l.replace(/\t/g, '    ').replace(/\s+$/, '');
      });
      const lang = text(input.code.lang, `${field}.code.lang`, 20, false);
      code = { ...(lang ? { lang } : {}), lines };
    }
  }

  const beats: ShapeSceneBeat[] = [];
  if (!Array.isArray(input.beats) || !input.beats.length) fail(`${field}.beats`, 'must be a list of moments, at least one: [{ at, say }]');
  else {
    if (input.beats.length > SHAPE_SCENE_LIMITS.beats) fail(`${field}.beats`, `has ${input.beats.length}; at most ${SHAPE_SCENE_LIMITS.beats}`);
    let prev = -Infinity;
    input.beats.slice(0, SHAPE_SCENE_LIMITS.beats).forEach((b, i) => {
      const at = `${field}.beats[${i}]`;
      if (!isRecord(b)) return fail(at, 'must be { at, say, line? }');
      only(b, BEAT_KEYS, at, 'a beat');
      if (!isNum(b.at) || b.at < 0 || b.at > end) return fail(`${at}.at`, `must be a time from 0 to end (${end})`);
      if (b.at <= prev) fail(`${at}.at`, `must come after the beat before it (${prev}); beats are in time order, one per moment`);
      prev = b.at;
      const say = text(b.say, `${at}.say`, SHAPE_SCENE_LIMITS.say, true) ?? '';
      let line: number | undefined;
      if (b.line !== undefined) {
        if (!code) fail(`${at}.line`, 'needs the scene to have code');
        else if (!Number.isInteger(b.line) || (b.line as number) < 1 || (b.line as number) > code.lines.length) fail(`${at}.line`, `must be a code line from 1 to ${code.lines.length}`);
        else line = b.line as number;
      }
      beats.push({ at: b.at, say, ...(line ? { line } : {}) });
    });
  }

  let legend: ShapeScene['legend'];
  if (input.legend !== undefined) {
    if (!Array.isArray(input.legend) || input.legend.length > SHAPE_SCENE_LIMITS.legend) fail(`${field}.legend`, `must be a list of { color, label }, at most ${SHAPE_SCENE_LIMITS.legend}`);
    else {
      legend = [];
      input.legend.forEach((l, i) => {
        const at = `${field}.legend[${i}]`;
        if (!isRecord(l)) return fail(at, 'must be { color, label }');
        only(l, ['color', 'label'], at, 'a legend entry');
        const c = color(l.color, `${at}.color`);
        const label = text(l.label, `${at}.label`, SHAPE_SCENE_LIMITS.legendLabel, true);
        if (c && label) legend!.push({ color: c, label });
      });
    }
  }

  const tracks: Record<string, ShapeSceneKey[]> = {};
  if (!isRecord(input.tracks)) fail(`${field}.tracks`, 'must be { pieceName: [{ at, … }, …] }: keyframes for each piece that moves or changes');
  else {
    const entries = Object.entries(input.tracks);
    if (entries.length > SHAPE_SCENE_LIMITS.tracks) fail(`${field}.tracks`, `has ${entries.length} pieces; at most ${SHAPE_SCENE_LIMITS.tracks}`);
    let total = 0;
    const named = (id: unknown, at: string): string | undefined => (typeof id === 'string' && ID_RE.test(id.trim()) ? id.trim() : (fail(at, 'must be the data-part name of a piece in the drawing'), undefined));
    for (const [id, list] of entries.slice(0, SHAPE_SCENE_LIMITS.tracks)) {
      const tf = `${field}.tracks.${id}`;
      if (id === RESERVED || !ID_RE.test(id) || id.length > SHAPE_SCENE_LIMITS.id) {
        fail(tf, `the name must be a piece's data-part: letters, digits, _ . : -, at most ${SHAPE_SCENE_LIMITS.id}`);
        continue;
      }
      if (!Array.isArray(list) || !list.length) {
        fail(tf, 'must be a list of keyframes, at least one: [{ at, … }]');
        continue;
      }
      if (list.length > SHAPE_SCENE_LIMITS.keysPerTrack) fail(tf, `has ${list.length} keyframes; at most ${SHAPE_SCENE_LIMITS.keysPerTrack}`);
      total += list.length;
      const keys: ShapeSceneKey[] = [];
      let prev = -Infinity;
      list.slice(0, SHAPE_SCENE_LIMITS.keysPerTrack).forEach((k, i) => {
        const at = `${tf}[${i}]`;
        if (!isRecord(k)) return fail(at, 'must be { at, … }');
        only(k, KEY_KEYS, at, 'a keyframe');
        if (!isNum(k.at) || k.at < 0 || k.at > end) return fail(`${at}.at`, `must be a time from 0 to end (${end})`);
        if (k.at < prev) fail(`${at}.at`, `must not come before the keyframe before it (${prev}); keyframes are in time order`);
        prev = k.at;
        const out: ShapeSceneKey = { at: k.at };
        for (const axis of ['x', 'y'] as const) {
          if (k[axis] === undefined) continue;
          if (!isNum(k[axis])) fail(`${at}.${axis}`, 'must be a number');
          else out[axis] = k[axis] as number;
        }
        const placed = (k.x !== undefined || k.y !== undefined ? 1 : 0) + (k.to !== undefined ? 1 : 0) + (k.along !== undefined ? 1 : 0);
        if (placed > 1) fail(at, 'give one place: x/y, or to, or along with p');
        if (k.to !== undefined) {
          const t = named(k.to, `${at}.to`);
          if (t) out.to = t;
        }
        if (k.along !== undefined) {
          const a = named(k.along, `${at}.along`);
          if (a) out.along = a;
          if (k.p === undefined) fail(`${at}.p`, 'is required with along: how far along, 0 (start) to 1 (end)');
        }
        if (k.p !== undefined) {
          if (k.along === undefined) fail(`${at}.p`, 'goes with along');
          const p = num(k.p, `${at}.p`, 0, 1);
          if (p !== undefined) out.p = p;
        }
        for (const prop of ['scale', 'scaleX', 'scaleY'] as const) {
          const v = num(k[prop], `${at}.${prop}`, 0, 20);
          if (v !== undefined) out[prop] = v;
        }
        const r = num(k.rotate, `${at}.rotate`, -3600, 3600, 'degrees');
        if (r !== undefined) out.rotate = r;
        const op = num(k.opacity, `${at}.opacity`, 0, 1);
        if (op !== undefined) out.opacity = op;
        const c = color(k.color, `${at}.color`);
        if (c) out.color = c;
        if (k.text !== undefined) {
          if (typeof k.text !== 'string' && !isNum(k.text)) fail(`${at}.text`, 'must be text');
          else if (String(k.text).length > SHAPE_SCENE_LIMITS.text) fail(`${at}.text`, `is ${String(k.text).length} characters; at most ${SHAPE_SCENE_LIMITS.text}`);
          else out.text = String(k.text);
        }
        const draw = num(k.draw, `${at}.draw`, 0, 1);
        if (draw !== undefined) out.draw = draw;
        if (k.lit !== undefined) {
          if (typeof k.lit !== 'boolean') fail(`${at}.lit`, 'must be true or false');
          else out.lit = k.lit;
        }
        if (k.ease !== undefined) {
          if (k.ease === 'smooth' || k.ease === 'linear' || k.ease === 'jump') out.ease = k.ease;
          else fail(`${at}.ease`, 'must be "smooth", "linear" or "jump"');
        }
        if (!Object.keys(k).some((key) => key !== 'at' && key !== 'ease' && KEY_KEYS.includes(key))) fail(at, 'changes nothing: give a place (x/y, to, along) or a look (color, opacity, scale, scaleX, scaleY, rotate, text, draw, lit)');
        keys.push(out);
      });
      tracks[id] = keys;
    }
    if (total > SHAPE_SCENE_LIMITS.keys) fail(`${field}.tracks`, `has ${total} keyframes; at most ${SHAPE_SCENE_LIMITS.keys}`);
  }

  if (errors.length || !title) return { ok: false, errors: errors.length ? errors : [`${field}.title: is required`] };
  return {
    ok: true,
    value: {
      scene: 1,
      title,
      ...(source ? { source } : {}),
      ...(unit ? { unit } : {}),
      end,
      ...(seconds !== undefined ? { seconds } : {}),
      ...(code ? { code } : {}),
      beats,
      ...(legend?.length ? { legend } : {}),
      tracks,
    },
  };
}

/** The values of one attribute on a drawn view's tags (never in a comment or in text). No DOM. */
function htmlAttr(html: string, attr: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<[A-Za-z][^>]*?\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi');
  for (const m of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(re)) out.push((m[1] ?? m[2] ?? m[3] ?? '').trim());
  return out;
}

/** The scene ids a drawn view's HTML plays (`data-scene="id"`). No DOM. */
export function shapeHtmlScenes(html: string): string[] {
  return htmlAttr(html, 'data-scene');
}

/** Each `data-scene` slot in a drawn view's HTML, with the tag it sits on (only a `<div>` can play). No DOM. */
export function shapeHtmlSceneSlots(html: string): { id: string; tag: string }[] {
  const out: { id: string; tag: string }[] = [];
  const re = /<([A-Za-z][\w:-]*)\b[^>]*?\sdata-scene\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const m of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(re)) out.push({ id: (m[2] ?? m[3] ?? m[4] ?? '').trim(), tag: m[1]!.toLowerCase() });
  return out;
}

/** The piece names a drawn view's HTML gives (`data-part="name"`). No DOM. */
export function shapeHtmlParts(html: string): string[] {
  return htmlAttr(html, 'data-part');
}

/** The pieces a scene names (its tracks, and every `to` and `along`), each with the field that names it. */
export function shapeScenePieceRefs(scene: ShapeScene, field: string): { id: string; at: string }[] {
  const out: { id: string; at: string }[] = [];
  for (const [id, keys] of Object.entries(scene.tracks)) {
    out.push({ id, at: `${field}.tracks.${id}` });
    keys.forEach((k, i) => {
      if (k.to) out.push({ id: k.to, at: `${field}.tracks.${id}[${i}].to` });
      if (k.along) out.push({ id: k.along, at: `${field}.tracks.${id}[${i}].along` });
    });
  }
  return out;
}
