import type { Theme } from '@plannotator/diagrams';
import { contrastRatio, mixOklab, parseCssColor, parseOpaqueColor, toHex, type RgbColor } from '../../utils/cssColor';
import { ensureContrast } from '../../utils/mermaidTheme';
import { readThemeTokenValues } from '../../utils/themeTokens';

const TOKENS = [
  'background', 'foreground', 'card', 'muted', 'muted-foreground', 'border',
  'primary', 'primary-foreground', 'secondary', 'warning', 'destructive', 'success',
] as const;

type Tokens = Partial<Record<(typeof TOKENS)[number], string>>;
export type NativeDiagramPalette = NonNullable<ReturnType<typeof nativeDiagramPalette>>;
const WHITE: RgbColor = { r: 1, g: 1, b: 1, a: 1 };
const BLACK: RgbColor = { r: 0, g: 0, b: 0, a: 1 };

/** Theme values for the displayed image. Measurements, labels and routing belong to the source. */
export function nativeDiagramPalette(tokens: Tokens | undefined) {
  const paper = parseOpaqueColor(tokens?.background, WHITE);
  const foreground = paper && parseOpaqueColor(tokens?.foreground, paper);
  if (!paper || !foreground || !tokens) return null;
  const color = (name: keyof Tokens, fallback: RgbColor) => parseOpaqueColor(tokens[name], paper) ?? fallback;
  const card = color('card', paper);
  const tile = color('muted', card);
  const muted = color('muted-foreground', foreground);
  const primary = color('primary', foreground);
  const secondary = color('secondary', primary);
  const warning = color('warning', primary);
  const neutralHeader = toHex(mixOklab(tile, primary, 0.2));
  // Step circles reuse the dark header tone with white lettering, including on dark paper.
  const darkHeader = ensureContrast(mixOklab(BLACK, secondary, 0.35), paper, 3, [foreground]);
  const stepTone = ensureContrast(darkHeader, WHITE, 4.5, [BLACK]);
  const textOn = (surface: RgbColor, text: RgbColor) => toHex(ensureContrast(text, surface, 4.5, [foreground, paper]));
  const noteFill = mixOklab(card, warning, 0.10);
  const groupFill = mixOklab(paper, card, 0.55);
  const surfaces = [paper, card, tile, groupFill, noteFill];
  const status = (label: string, accent: RgbColor, dash: 'dashed' | 'dotted' | null) => {
    const fill = mixOklab(card, accent, 0.10);
    surfaces.push(fill);
    const stroke = ensureContrast(accent, fill, 4.5, [foreground, paper]);
    return { label, fill: toHex(fill), stroke: textOn(paper, stroke), dash };
  };
  // The renderer takes a complete status entry. Keep its legend labels and line patterns.
  const statuses = {
    live: status('Live', color('success', foreground), null),
    building: status('Being built', warning, 'dashed'),
    trial: status('In trial', primary, 'dashed'),
    planned: status('Planned', muted, 'dotted'),
    retiring: status('Retiring', color('destructive', primary), null),
  };
  // The renderer shares these inks across paper, panels, tiles and status fills.
  const across = (color: RgbColor, minimum: number) => surfaces.reduce(
    (result, surface) => ensureContrast(result, surface, minimum, [foreground, paper]), color,
  );
  const ink = across(foreground, 4.5);
  const secondaryText = toHex(across(muted, 4.5));
  const line = across(muted, 3);
  const stroke = ensureContrast(color('border', muted), card, 3, [muted, ink]);

  return {
    paper: toHex(paper), ink: toHex(ink), muted: secondaryText, faint: secondaryText,
    line: toHex(line), panel_fill: toHex(card), panel_stroke: toHex(stroke),
    tile_fill: toHex(tile), tile_stroke: toHex(stroke),
    group_fill: toHex(groupFill), group_stroke: toHex(line),
    note_fill: toHex(noteFill), note_stroke: toHex(ensureContrast(warning, card, 3, [ink])),
    tag_color: textOn(paper, primary), badge_fill: toHex(primary), badge_text: textOn(primary, color('primary-foreground', ink)),
    graph_fill: toHex(card), graph_grid: toHex(mixOklab(card, muted, 0.25)), graph_line: toHex(line),
    // The renderer chooses the pair with the higher contrast for each header, including literal author colors.
    header_text: toHex(BLACK), header_sub: toHex(BLACK), header_text_on_dark: toHex(WHITE), header_sub_on_dark: toHex(WHITE),
    tones: { default: neutralHeader, neutral: neutralHeader, accent: toHex(primary), dark: toHex(stepTone) },
    statuses,
  } satisfies Partial<Theme>;
}

export function readNativeDiagramPalette(element: Element): NativeDiagramPalette | null {
  return nativeDiagramPalette(readThemeTokenValues(TOKENS, element));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** An authored paper or primary ink defines the drawing's own palette. Individual accents can coexist with the host. */
export function nativeReviewSpec(spec: unknown, palette: NativeDiagramPalette | null): unknown {
  if (!palette || !isObject(spec)) return spec;
  if (spec.theme === undefined) return { ...spec, theme: palette };
  const authored = spec.theme;
  if (!isObject(authored) || authored.paper !== undefined || authored.ink !== undefined) return spec;
  // On a mixed-polarity canvas, literal colors can hide a body label, source arrow or
  // status pill. Keep the original drawing together when these author/host pairs clash.
  const incompatible = (foreground: unknown, background: unknown, minimum: number) => {
    if (typeof foreground !== 'string' || typeof background !== 'string') return false;
    const ink = parseCssColor(foreground);
    const fill = parseCssColor(background);
    return ink && fill && contrastRatio(ink, fill) < minimum;
  };
  const surfaces = ['paper', 'panel_fill', 'tile_fill', 'note_fill', 'graph_fill', 'group_fill'] as const;
  const fills: unknown[] = surfaces.map(key => authored[key] ?? palette[key]);
  const statusColors = isObject(authored.statuses) ? Object.values(authored.statuses).filter(isObject) : [];
  for (const status of statusColors) {
    fills.push(status.fill);
    if (incompatible(status.stroke, palette.paper, 4.5) || incompatible(status.stroke, status.fill, 4.5)) return spec;
  }
  for (const fill of fills) {
    if (incompatible(palette.ink, fill, 4.5) || incompatible(authored.muted ?? palette.muted, fill, 4.5)
      || incompatible(authored.faint ?? palette.faint, fill, 4.5) || incompatible(authored.line, fill, 3)) return spec;
  }
  const theme: Record<string, unknown> = { ...palette, ...authored };
  for (const key of ['tones', 'statuses'] as const) {
    // Keep malformed input intact so the renderer reports its original validation error.
    if (isObject(authored[key])) theme[key] = { ...palette[key], ...authored[key] };
  }
  return { ...spec, theme };
}
