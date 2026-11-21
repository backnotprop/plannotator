/**
 * A space's face on the home (approval "plans-home"): the real top of its plan's main page, made with no AI and no
 * judgment, read from the main page's kind:
 * - a document: its newest version from its first paragraph (`faceParts`): the first sentence set larger as the lede,
 *   the rest in the sheet's type (the prototype's `.dd`), each block drawn by the renderer the plan page uses (ui's
 *   RenderedMarkdown) under the rules for a plan's own words (planContent.tsx); a moving picture in it is not drawn;
 * - an HTML page: the page itself in a frame that runs, loads and moves nothing (`planFaceSrcdoc`), at a desktop width,
 *   scaled; its prepared page is kept per plan and version, so a face let go and drawn again is not prepared again;
 * - a picture: the picture, drawn once into a canvas (still by construction: a GIF's or WebP's first frame);
 * - a diagram (Mermaid, Graphviz): drawn by the plan page's own renderer when the face nears the screen, then into a
 *   canvas (still), kept per plan, version and theme; one that does not draw shows its source as code;
 * - data (CSV, TSV): its first rows as cells.
 * A page above 512 KB, a picture above 2 MB: the card's ground for its kind.
 *
 * A new version replaces the face in place once it has come (the old one stays meanwhile): in a document the block
 * where the change landed (the first that differs from the face before) takes the card's `arrive` (it opens in place,
 * tinted for a moment); anything else cross-fades. Nothing moves otherwise, and nothing at all under reduced motion.
 * Every face is laid out at the card's `CARD_FACE_WIDTH` (plans.css reads it as `--ib-spc-face-w`).
 *
 * `SpaceThumb` is a row's 36x27 thumbnail of the same face, static and cheap: a document's top as plain words (no
 * Markdown renderer), data as a few cells, a picture or a diagram as the same still drawing; an HTML page keeps its
 * kind's shape (no frame in a row).
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { PlanSummary } from '@plannotator/core/plans';
import { RenderedMarkdown } from '@plannotator/ui/components/RenderedMarkdown';
import { ImageResolverContext, type ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { renderDiagram } from '@plannotator/ui/utils/diagram-render';
import { PlanContentRules, acceptPlanDiagramSvg, isMovingDataImage, mermaidMayLoad, planFaceSrcdoc, resolvePlanImage, resolvePlanLink } from './planContent';
import { faceParts, type FaceParts } from './spacesModel';
import { useFaceText } from './store';
import { CARD_FACE_WIDTH, arrive } from '@plannotator/ui/components/frame';
import { tableRows } from '../wallFaceText';

/** The width an HTML page is laid out at before the face scales it to the card's face width. */
const PAGE_WIDTH = 1024;

/**
 * A row's thumbnail is the same face drawn at the thumbnail's size: the card's small sheet (72% of 36 px) for a
 * document, its small panel (80%) for data.
 */
const THUMB_SCALE = { document: (36 * 0.72) / CARD_FACE_WIDTH, data: (36 * 0.8) / CARD_FACE_WIDTH };

const headOf = (plan: PlanSummary) => (plan.head_version_number >= 1 ? plan.head_version_number : null);

export function SpaceFace({ plan }: { plan: PlanSummary }) {
  const face = useFaceText(plan.id, headOf(plan));
  if (!face) return null;
  const kind = plan.primary_kind ?? 'markdown';
  if (kind === 'image') {
    const key = `${plan.id}:${plan.head_version_number}`;
    return face.picture ? <PictureFace keyOf={key} picture={pictureOf(key, () => loadPicture(face.picture!))} /> : null;
  }
  if (face.text === null) return null;
  if (kind === 'html') return <PageFace html={face.text} keyOf={`${plan.id}:${plan.head_version_number}`} />;
  if (kind === 'mermaid' || kind === 'graphviz') return <DiagramFace plan={plan} kind={kind} source={face.text} cut={face.cut} />;
  if (kind === 'data') return <DataFace text={face.text} />;
  return <DocumentFace text={face.text} title={plan.name} />;
}

/** A row's thumbnail: the same face, static and small. */
export const SpaceThumb = memo(function SpaceThumb({ plan }: { plan: PlanSummary }) {
  const face = useFaceText(plan.id, headOf(plan));
  const kind = plan.primary_kind ?? 'markdown';
  const theme = useThemeKey();
  if (!face || kind === 'html') return null;
  if (kind === 'image') return face.picture ? <StillPicture picture={pictureOf(`${plan.id}:${plan.head_version_number}`, () => loadPicture(face.picture!))} own /> : null;
  if (face.text === null) return null;
  if (kind === 'mermaid' || kind === 'graphviz') {
    const key = `${plan.id}:${plan.head_version_number}:${theme}`;
    return face.cut ? null : <StillPicture picture={pictureOf(key, () => drawDiagram(kind, face.text!, theme))} />;
  }
  if (kind === 'data') return <DataFace text={face.text} small />;
  return <DocumentThumb text={face.text} title={plan.name} />;
});

/** A face whose content changed in place: a short cross-fade of the face (not on the first draw; none if reduced). */
function useArrival(key: string) {
  const box = useRef<HTMLDivElement>(null);
  const was = useRef(key);
  useEffect(() => {
    if (was.current === key) return;
    was.current = key;
    const el = box.current;
    if (el && !reducedMotion() && typeof el.animate === 'function') el.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
  }, [key]);
  return box;
}

const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A plan's pictures in a face are its own `data:` pictures that do not move (a moving one is not drawn). */
const resolveFaceImage: ImageResolver = (src) => (isMovingDataImage(src.trim()) ? { kind: 'unavailable', title: '' } : resolvePlanImage(src));

/** Which block of the new face differs first from the face before (-1: the lede; null: none, or nothing to compare). */
export function landedBlock(before: FaceParts | null, after: FaceParts): number | null {
  if (!before) return null;
  if (before.heading !== after.heading || before.lede !== after.lede) return -1;
  const at = after.blocks.findIndex((block, i) => block !== before.blocks[i]);
  return at >= 0 ? at : null;
}

function DocumentFace({ text, title }: { text: string; title: string }) {
  const parts = useMemo(() => faceParts(text, title), [text, title]);
  const was = useRef<FaceParts | null>(null);
  const [landed, setLanded] = useState<{ at: number; n: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const at = landedBlock(was.current, parts);
    was.current = parts;
    if (at !== null && !reducedMotion()) setLanded((l) => ({ at, n: (l?.n ?? 0) + 1 }));
  }, [parts]);
  // The card's `arrive` on the block where it landed, once per arrival.
  useLayoutEffect(() => {
    if (landed) arrive(box.current?.querySelector<HTMLElement>(`[data-face-block="${landed.at === -1 ? 'lede' : landed.at}"]`));
  }, [landed]);
  const mark = (i: number) => (landed && landed.at === i ? { 'data-face-landed': '' } : {});
  return (
    <div className="ib-spc-face" data-space-face="document" ref={box}>
      <PlanContentRules>
        <ImageResolverContext.Provider value={resolveFaceImage}>
          {parts.heading && <h3 className="ib-spc-fh" dir="auto">{parts.heading}</h3>}
          {parts.lede && (
            <p className="ib-spc-lede" dir="auto" data-face-block="lede" {...mark(-1)}>
              {parts.lede}
            </p>
          )}
          {parts.blocks.map((block, i) => (
            <div key={i} className="ib-spc-fb" data-face-block={i} {...mark(i)}>
              <RenderedMarkdown markdown={block} resolveLocalLink={resolvePlanLink} resolveImage={resolveFaceImage} />
            </div>
          ))}
        </ImageResolverContext.Provider>
      </PlanContentRules>
    </div>
  );
}

/** A document's top as plain words on a small sheet: the lede and the first lines (no renderer). */
function DocumentThumb({ text, title }: { text: string; title: string }) {
  const parts = useMemo(() => faceParts(text, title), [text, title]);
  const lines = parts.blocks.slice(0, 4).flatMap((block) => block.split('\n').slice(0, 3));
  return (
    <div className="ib-spc-face ib-spc-thumbface" aria-hidden="true" style={{ transform: `scale(${THUMB_SCALE.document})` }}>
      {parts.heading && <b className="ib-spc-fh">{parts.heading}</b>}
      {parts.lede && <p className="ib-spc-lede">{parts.lede}</p>}
      {lines.map((line, i) => {
        const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
        const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
        if (/^\s*\|?\s*:?-{2,}/.test(line) || /^\s*`{3,}/.test(line)) return null;
        return heading ? (
          <b key={i} className="ib-spc-fh">
            {heading[1]}
          </b>
        ) : (
          <span key={i} className={item ? 'ib-spc-tli' : /^\s*\|/.test(line) ? 'ib-spc-tcells' : 'ib-spc-tp'}>
            {item ? item[1] : line.replace(/\|/g, '  ')}
          </span>
        );
      })}
    </div>
  );
}

/** An HTML page's prepared, still page, kept per plan and version (a face let go comes back without parsing again). */
const pageDocs = new Map<string, string | null>();
const PAGE_DOCS_KEPT = 24;
function stillPageOf(key: string, html: string): string | null {
  if (pageDocs.has(key)) {
    const kept = pageDocs.get(key)!;
    pageDocs.delete(key);
    pageDocs.set(key, kept);
    return kept;
  }
  const page = planFaceSrcdoc(html);
  pageDocs.set(key, page);
  while (pageDocs.size > PAGE_DOCS_KEPT) pageDocs.delete(pageDocs.keys().next().value!);
  return page;
}

function PageFace({ html, keyOf }: { html: string; keyOf: string }) {
  const box = useArrival(keyOf);
  const srcDoc = useMemo(() => stillPageOf(keyOf, html), [keyOf, html]);
  if (srcDoc === null) return null;
  return (
    <div className="ib-spc-pageface" data-space-face="page" ref={box}>
      <iframe title="" srcDoc={srcDoc} sandbox="" referrerPolicy="no-referrer" tabIndex={-1} aria-hidden="true" loading="lazy" style={{ width: PAGE_WIDTH, height: PAGE_WIDTH * 0.75, transform: `scale(${CARD_FACE_WIDTH / PAGE_WIDTH})` }} />
    </div>
  );
}

/** Decoded pictures (a picture page's, a drawn diagram's), kept per plan, version (and theme); the newest few. */
const pictures = new Map<string, Promise<HTMLImageElement | null>>();
const PICTURES_KEPT = 48;
function pictureOf(key: string, load: () => Promise<HTMLImageElement | null>): Promise<HTMLImageElement | null> {
  let kept = pictures.get(key);
  if (kept) {
    pictures.delete(key);
  } else {
    kept = load().catch(() => null);
  }
  pictures.set(key, kept);
  while (pictures.size > PICTURES_KEPT) pictures.delete(pictures.keys().next().value!);
  return kept;
}

/** Tests: forget the kept faces. */
export function resetSpaceFacesForTests(): void {
  pageDocs.clear();
  pictures.clear();
}

async function loadPicture(url: string): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined') return null;
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  return img.naturalWidth > 0 ? img : null;
}

/** The window's theme as a key (a diagram is drawn in its colours). */
function useThemeKey(): string {
  const { colorTheme, resolvedMode } = useTheme();
  return `${colorTheme}:${resolvedMode}`;
}

/** A CSS value with every `var(--x)` of the window's own put in (a drawn diagram leaves the page as a picture). */
function withVariables(css: string, root: CSSStyleDeclaration): string {
  let out = css;
  for (let round = 0; round < 4 && out.includes('var('); round++) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (_, name: string, fallback: string | undefined) => root.getPropertyValue(name).trim() || fallback?.trim() || 'currentColor');
  }
  return out;
}

/**
 * A diagram drawn by the plan page's renderer, as a still picture (null: it does not draw, or is refused). Mermaid
 * draws in the live page, so a source that could load something (`mermaidMayLoad`, the plan page's rule) is never
 * handed to it: the face shows the source, a row the kind's shape. Graphviz lays out in its engine and is parsed inert
 * (no `image=`, and `acceptPlanDiagramSvg` checks the result), so it needs no source rule.
 */
async function drawDiagram(kind: 'mermaid' | 'graphviz', source: string, themeKey: string): Promise<HTMLImageElement | null> {
  if (typeof document === 'undefined' || typeof XMLSerializer === 'undefined') return null;
  if (kind === 'mermaid' && mermaidMayLoad(source)) return null;
  const [colorTheme, mode] = themeKey.split(':');
  const result = await renderDiagram(kind, `ib-face-${Math.random().toString(36).slice(2, 10)}`, source, { colorTheme: colorTheme ?? 'plannotator', mode: mode === 'light' ? 'light' : 'dark' }, { accept: acceptPlanDiagramSvg });
  if (!result.ok) return null;
  const svg = result.svgNode;
  const box = svg.viewBox?.baseVal;
  const width = box && box.width > 0 ? box.width : Number.parseFloat(svg.getAttribute('width') ?? '') || 600;
  const height = box && box.height > 0 ? box.height : Number.parseFloat(svg.getAttribute('height') ?? '') || 400;
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.style.maxWidth = '';
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const markup = withVariables(new XMLSerializer().serializeToString(svg), getComputedStyle(document.documentElement));
  return loadPicture(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`);
}

/** A picture drawn once into a canvas, fitted whole: nothing in it can move. */
/** `own`: the plan's own picture (not one drawn here in the theme's colours): dimmed in dark on the home. */
function StillPicture({ picture, pad = 0, own = false }: { picture: Promise<HTMLImageElement | null>; pad?: number; own?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let live = true;
    let img: HTMLImageElement | null = null;
    const draw = () => {
      if (!img) return;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      el.width = Math.round(box.width * dpr);
      el.height = Math.round(box.height * dpr);
      const ctx = el.getContext('2d');
      if (!ctx) return;
      const room = { w: el.width - 2 * pad * dpr, h: el.height - 2 * pad * dpr };
      const scale = Math.min(room.w / img.naturalWidth, room.h / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.drawImage(img, (el.width - w) / 2, (el.height - h) / 2, w, h);
    };
    void picture.then((got) => {
      if (!live) return;
      if (!got) return setFailed(true);
      img = got;
      draw();
    });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(draw);
    ro?.observe(el);
    return () => {
      live = false;
      ro?.disconnect();
    };
  }, [picture, pad]);
  if (failed) return null;
  return <canvas ref={canvas} className={own ? 'ib-spc-still ib-spc-own' : 'ib-spc-still'} aria-hidden="true" />;
}

function PictureFace({ picture, keyOf }: { picture: Promise<HTMLImageElement | null>; keyOf: string }) {
  const box = useArrival(keyOf);
  return (
    <div className="ib-spc-picface" data-space-face="image" ref={box}>
      <StillPicture picture={picture} own />
    </div>
  );
}

function DiagramFace({ plan, kind, source, cut }: { plan: PlanSummary; kind: 'mermaid' | 'graphviz'; source: string; cut: boolean }) {
  const theme = useThemeKey();
  const key = `${plan.id}:${plan.head_version_number}:${theme}`;
  const box = useArrival(`${plan.id}:${plan.head_version_number}`);
  const picture = useMemo(() => (cut ? null : pictureOf(key, () => drawDiagram(kind, source, theme))), [key, cut, kind, source, theme]);
  const [drawn, setDrawn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setDrawn(null);
    void picture?.then((img) => live && setDrawn(!!img));
    if (!picture) setDrawn(false);
    return () => {
      live = false;
    };
  }, [picture]);
  if (drawn === false) return <DiagramSource kind={kind} source={source} />;
  return (
    <div className="ib-spc-picface ib-spc-diagram" data-space-face="diagram" ref={box}>
      {picture && <StillPicture picture={picture} pad={6} />}
    </div>
  );
}

/** A diagram that does not draw: its source, as the plan page shows a diagram that cannot be drawn. */
function DiagramSource({ kind, source }: { kind: 'mermaid' | 'graphviz'; source: string }) {
  const markdown = `\`\`\`${kind === 'graphviz' ? 'dot' : 'mermaid'}-source\n${source.split('\n').slice(0, 30).join('\n')}\n\`\`\``;
  return (
    <div className="ib-spc-face" data-space-face="diagram-source">
      <PlanContentRules>
        <RenderedMarkdown markdown={markdown} resolveLocalLink={resolvePlanLink} resolveImage={resolvePlanImage} />
      </PlanContentRules>
    </div>
  );
}

/** A table's first rows as cells, the row numbers in the first column (a spreadsheet's top). */
function DataFace({ text, small = false }: { text: string; small?: boolean }) {
  const box = useArrival(text);
  const tab = useMemo(() => (text.split('\n', 1)[0] ?? '').includes('\t'), [text]);
  const rows = useMemo(() => tableRows(text, tab, small ? 6 : 11, small ? 4 : 5), [text, tab, small]);
  if (!rows.length) return null;
  const [head, ...body] = rows;
  const cells: ReactNode = (
    <table className="ib-spc-cells">
      <thead>
        <tr>
          <th />
          {head!.map((cell, i) => (
            <th key={i} dir="auto">
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((row, r) => (
          <tr key={r}>
            <td>{r + 1}</td>
            {head!.map((_, c) => (
              <td key={c} dir="auto">
                {row[c] ?? ''}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <div className={small ? 'ib-spc-dataface ib-spc-thumbface' : 'ib-spc-dataface'} data-space-face="data" ref={box} style={small ? ({ transform: `scale(${THUMB_SCALE.data})` } as CSSProperties) : undefined}>
      {cells}
    </div>
  );
}
