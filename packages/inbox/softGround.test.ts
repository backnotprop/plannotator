import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const THEMES = join(import.meta.dir, '../ui/themes');
const MIN_SEPARATION = 1.035;

type Rgb = [number, number, number];

function linear(value: string): Rgb | null {
  const v = value.trim().toLowerCase();
  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    return [0, 2, 4].map((i) => toLinear(parseInt(h.slice(i, i + 2), 16) / 255)) as Rgb;
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(v);
  if (rgb) {
    const parts = rgb[1]!.split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
    return parts.map((c) => toLinear(c / 255)) as Rgb;
  }
  const ok = /^oklch\(([^)]+)\)$/.exec(v);
  if (ok) {
    const [ls, cs, hs] = ok[1]!.split(/[\s/]+/).filter(Boolean);
    const L = ls!.endsWith('%') ? parseFloat(ls!) / 100 : parseFloat(ls!);
    const C = parseFloat(cs!);
    const H = ((parseFloat(hs ?? '0') || 0) * Math.PI) / 180;
    const a = C * Math.cos(H);
    const b = C * Math.sin(H);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const [l, m, s] = [l_ ** 3, m_ ** 3, s_ ** 3];
    const clamp = (x: number) => Math.min(1, Math.max(0, x));
    return [
      clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ];
  }
  return null;
}

function contrast(x: Rgb, y: Rgb): number {
  const lum = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi! + 0.05) / (lo! + 0.05);
}

function palettes(): { name: string; mode: 'light' | 'dark'; tokens: Record<string, string> }[] {
  const out: { name: string; mode: 'light' | 'dark'; tokens: Record<string, string> }[] = [];
  for (const file of readdirSync(THEMES).filter((f) => f.endsWith('.css'))) {
    const name = file.replace(/\.css$/, '');
    const css = readFileSync(join(THEMES, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const dark: Record<string, string> = {};
    const light: Record<string, string> = {};
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = rule[1]!.split(',').map((s) => s.trim());
      const decls: Record<string, string> = {};
      for (const d of rule[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls[d[1]!] = d[2]!.trim();
      if (selectors.includes(`.theme-${name}`)) Object.assign(dark, decls);
      if (selectors.includes(`.theme-${name}.light`)) Object.assign(light, decls);
    }
    out.push({ name, mode: 'dark', tokens: dark });
    out.push({ name, mode: 'light', tokens: { ...dark, ...light } });
  }
  return out;
}

function listedInCss(): Set<string> {
  const css = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /([^{}]+)\{\s*--ib-ground-panes:\s*color-mix\(in oklch, var\(--muted\) 55%, var\(--background\)\);\s*\}/.exec(css);
  expect(rule).not.toBeNull();
  const listed = new Set<string>();
  for (const sel of rule![1]!.split(/,\s*(?![^(]*\))/).map((s) => s.trim()).filter((s) => s.startsWith(':root'))) {
    const names = [...sel.matchAll(/\.theme-([\w-]+)/g)].map((m) => m[1]!);
    const modes = sel.includes(':root.light') ? ['light'] : ['light', 'dark'];
    for (const n of names) for (const m of modes) listed.add(`${n}/${m}`);
  }
  return listed;
}

test('every palette whose background is its card has a ground of its own under the panes, and only those', () => {
  const needs = new Set<string>();
  const all = palettes();
  expect(all.length).toBeGreaterThan(50);
  for (const p of all) {
    const bg = linear(p.tokens['--background'] ?? '');
    const card = linear(p.tokens['--card'] ?? '');
    expect(bg, `${p.name}/${p.mode} --background`).not.toBeNull();
    expect(card, `${p.name}/${p.mode} --card`).not.toBeNull();
    if (contrast(bg!, card!) < MIN_SEPARATION) needs.add(`${p.name}/${p.mode}`);
  }
  expect([...listedInCss()].sort()).toEqual([...needs].sort());
});
