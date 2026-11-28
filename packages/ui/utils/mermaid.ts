/**
 * Mermaid runtime slot.
 *
 * ONE code path feeds `MermaidBlock`: `loadMermaidRuntime()`. It resolves at
 * once from a filled slot and otherwise imports the runtime lazily: the
 * runtime is fetched on the first diagram, a failed import is dropped from
 * the memo so the next call issues a fresh `import()`, and the block
 * re-attempts once and offers Retry.
 *
 * Since Mermaid 12 (ELK layout by default, about 1.8 MB more runtime than 11)
 * the lazy path IS Plannotator's own path: `packages/editor/App.tsx` no longer
 * imports `./mermaid-eager`, so a plan with no diagram never downloads the
 * runtime in a chunked build (the share portal, any host that bundles by
 * route), nor in the single-file builds, which carry it as a packed chunk
 * their server serves on request (build/pack-app.ts). A host that wants the runtime registered at
 * startup imports `./mermaid-eager`, which fills the slot at module
 * evaluation; the slot then short-circuits this loader.
 *
 * This module has NO static import of `mermaid`; the only place the
 * dependency is named at runtime is the default loader's `import('mermaid')`.
 */
import type { Mermaid, MermaidConfig } from 'mermaid';

/**
 * Width in px at which node labels wrap (#2064). Mermaid 12 lowered the
 * default from 200 to 120, and at Plannotator's 16 px label text that wraps
 * after about eight CJK characters and splits short Latin labels. 140 is the
 * owner-approved middle: long labels still wrap, short ones stay on one line.
 * The themed path (`buildMermaidConfig`) spreads this config, so both the
 * themed and the host-fallback `initialize` carry it.
 */
export const MERMAID_LABEL_WRAP_WIDTH = 140;

/**
 * Elements a label's own HTML may not keep: what navigates the tab or submits
 * when clicked (an image map, a form and its controls, a `<base>` that would
 * retarget links). Mermaid writes every label into the live page to measure it
 * before `diagram-render` sanitizes the drawn svg, so this is what Mermaid's
 * own label pass removes. The text inside a removed element is kept
 * (`<button>Go</button>` leaves "Go"). `style` is Mermaid's own default.
 * What only loads (a picture, media) is not listed: a label draws it as it did,
 * under the page's own policy.
 */
export const MERMAID_LABEL_FORBIDDEN_TAGS = [
  'style',
  'form', 'button', 'input', 'select', 'option', 'optgroup', 'datalist', 'textarea',
  'map', 'area', 'base',
];

/** See MERMAID_LABEL_FORBIDDEN_TAGS: the attributes that navigate or submit. */
// `for` and `accesskey`: a label's click (or a key) would otherwise press a control of the app that has that id.
export const MERMAID_LABEL_FORBIDDEN_ATTRS = ['action', 'formaction', 'ping', 'target', 'usemap', 'for', 'accesskey'];

/** Mermaid's own secure keys (its default `secure`), which a diagram's directive or front matter cannot change. */
const MERMAID_DEFAULT_SECURE_KEYS = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges'];

/**
 * Hoisted verbatim from the former module-scope `mermaid.initialize(...)` in
 * MermaidBlock. Nothing in it reads a CSS token or the resolved mode.
 * `securityLevel: 'strict'` is a deliberate security pin (see MermaidBlock.test.ts).
 */
export const MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  /**
   * The DOMPurify config Mermaid sanitizes each label with, in place of its
   * default `{ FORBID_TAGS: ['style'] }` (see MERMAID_LABEL_FORBIDDEN_TAGS).
   * Listed in `secure`, so a `%%{init}%%` directive or front matter cannot
   * replace it.
   */
  dompurifyConfig: { FORBID_TAGS: MERMAID_LABEL_FORBIDDEN_TAGS, FORBID_ATTR: MERMAID_LABEL_FORBIDDEN_ATTRS },
  secure: [...MERMAID_DEFAULT_SECURE_KEYS, 'dompurifyConfig'],
  /**
   * Mermaid's own failure output is a "Syntax error in text" graphic drawn
   * into a temporary node on `document.body`, left there when it throws. The
   * block shows a failure itself (the source, with a note), so Mermaid draws
   * nothing for one; `diagram-render` also removes any leftover node.
   */
  suppressErrorRendering: true,
  theme: 'dark',
  themeVariables: {
    primaryColor: '#3b82f6',
    primaryTextColor: '#f8fafc',
    primaryBorderColor: '#475569',
    lineColor: '#64748b',
    secondaryColor: '#1e293b',
    tertiaryColor: '#0f172a',
    background: '#1e293b',
    mainBkg: '#1e293b',
    nodeBorder: '#475569',
    clusterBkg: '#1e293b',
    clusterBorder: '#475569',
    titleColor: '#f8fafc',
    edgeLabelBackground: '#1e293b',
    /**
     * Mermaid 12's neo look shadows every node from a fixed
     * `drop-shadow(1px 2px 2px rgba(185,185,185,1))` grey, which reads as a
     * halo. The token-driven mapping replaces it per palette
     * (`buildMermaidShadow` in `./mermaidTheme`); this static config is what a
     * host with no theme tokens renders with, so it carries the same
     * toned-down 0.7 geometry with a fixed colour. The value is what
     * `buildMermaidShadow(#1e293b, 0.7)` returns for THIS config's own slate
     * ground, which is dark — hence a light shadow, exactly as Mermaid's own
     * `insertLookDefs` uses a white flood colour on dark themes.
     */
    dropShadow: 'drop-shadow(0.79px 1.58px 1.58px rgba(210, 212, 217, 0.684))',
  },
  flowchart: {
    htmlLabels: true,
    curve: 'basis',
    wrappingWidth: MERMAID_LABEL_WRAP_WIDTH,
  },
  /**
   * Mermaid 11 drew state labels with the flowchart width; Mermaid 12 gives
   * state diagrams their own `wrappingWidth`, also 120, so it is pinned too.
   */
  state: {
    wrappingWidth: MERMAID_LABEL_WRAP_WIDTH,
  },
};

/**
 * With `configurePlannotatorUI({ diagramRemoteLoads: false })`
 * (`utils/diagramRemoteLoadsPolicy`): what Mermaid's label pass also drops,
 * so nothing in a label is fetched while Mermaid measures it in the live
 * page. Media and the attributes that only ever name a picture go here; a
 * label's `<img>` / svg `<image>` keep a `data:` picture through the
 * attribute hook `diagram-render` installs (MERMAID_NO_REMOTE_LABEL_MARK),
 * which also drops every other reference and every style declaration that
 * fetches.
 */
export const MERMAID_NO_REMOTE_LABEL_TAGS = ['picture', 'source', 'track', 'audio', 'video'];
export const MERMAID_NO_REMOTE_LABEL_ATTRS = ['srcset', 'imagesrcset', 'poster', 'background', 'lowsrc', 'dynsrc'];

/**
 * When the hook cannot reach Mermaid's own DOMPurify (a host bundle with two
 * copies of it), the label pass falls back to dropping every picture,
 * reference and style in a label instead (coloured spans lose their colour).
 */
export const MERMAID_NO_REMOTE_LABEL_FALLBACK_TAGS = ['img', 'image', 'svg'];
export const MERMAID_NO_REMOTE_LABEL_FALLBACK_ATTRS = ['src', 'href', 'xlink:href', 'style'];

/** The key in the label pass's DOMPurify config that the no-remote attribute hook acts on. */
export const MERMAID_NO_REMOTE_LABEL_MARK = 'PLANNOTATOR_DIAGRAM_LABEL_NO_REMOTE';

/**
 * Config keys a diagram's directive or front matter may not set when
 * diagrams load nothing from another host: Mermaid writes their values into
 * its stylesheet while it draws, before any sanitizer, so `url(` there loads.
 * Every other string key was tried with CSS that loads, in a directive, and
 * none loaded. Mermaid applies `secure` at every level of a directive, so
 * `themeVariables.fontFamily` set by a diagram is ignored too (the page's
 * font applies).
 */
export const MERMAID_NO_REMOTE_SECURE_KEYS = ['themeCSS', 'fontFamily', 'altFontFamily'];

/**
 * `config` as it is for the policy: unchanged (the same object) when diagrams
 * may load from other hosts; otherwise with the label pass and `secure`
 * extended (see the constants above). `labelHook: false` is the fallback for
 * a runtime the attribute hook does not reach.
 */
export function mermaidConfigForRemoteLoads(config: MermaidConfig, remoteLoads: boolean, labelHook = true): MermaidConfig {
  if (remoteLoads) return config;
  const label = (config.dompurifyConfig ?? {}) as { FORBID_TAGS?: string[]; FORBID_ATTR?: string[] };
  return {
    ...config,
    dompurifyConfig: {
      ...label,
      FORBID_TAGS: [...(label.FORBID_TAGS ?? []), ...MERMAID_NO_REMOTE_LABEL_TAGS, ...(labelHook ? [] : MERMAID_NO_REMOTE_LABEL_FALLBACK_TAGS)],
      FORBID_ATTR: [...(label.FORBID_ATTR ?? []), ...MERMAID_NO_REMOTE_LABEL_ATTRS, ...(labelHook ? [] : MERMAID_NO_REMOTE_LABEL_FALLBACK_ATTRS)],
      [MERMAID_NO_REMOTE_LABEL_MARK]: true,
    } as MermaidConfig['dompurifyConfig'],
    secure: [...(config.secure ?? []), ...MERMAID_NO_REMOTE_SECURE_KEYS],
  };
}

/**
 * Who filled the slot. The eager value doubles as a build marker: the literal
 * only reaches a bundle when `./mermaid-eager` is evaluated in it, which is
 * how `tests/entry-assets.test.ts` proves on the built HTML that Plannotator's
 * own bundles do NOT register the runtime eagerly.
 */
export type MermaidRuntimeSource = 'plannotator-mermaid-eager' | 'loader' | 'host';

export type MermaidRuntimeLoader = () => Promise<Mermaid>;

/** Default lazy loader: import the runtime and initialize it once. */
const defaultMermaidLoader: MermaidRuntimeLoader = () =>
  import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize(MERMAID_CONFIG);
    return mermaid;
  });

let runtime: Mermaid | null = null;
let runtimeSource: MermaidRuntimeSource | null = null;
let loader: MermaidRuntimeLoader = defaultMermaidLoader;
let pending: Promise<Mermaid> | null = null;

/**
 * Delay before the block's one automatic re-attempt after a failed lazy
 * import. Only chunked builds can fail here (the share portal, a host that
 * bundles by route); a single-file build resolves the import from itself and
 * a filled slot never loads.
 */
let retryDelayMs = 750;

/** Current runtime, or `null` while the slot is empty. */
export function getMermaidRuntime(): Mermaid | null {
  return runtime;
}

/** How the current runtime was registered, or `null` while the slot is empty. */
export function getMermaidRuntimeSource(): MermaidRuntimeSource | null {
  return runtimeSource;
}

/** Register an already-initialized runtime (what `./mermaid-eager` does). */
export function setMermaidRuntime(next: Mermaid, source: MermaidRuntimeSource = 'host'): void {
  runtime = next;
  runtimeSource = source;
  pending = null;
}

/** The block's retry delay for the lazy path. */
export function getMermaidRetryDelayMs(): number {
  return retryDelayMs;
}

/**
 * Resolve the runtime: at once from a filled slot, otherwise through the
 * loader. A rejected load is dropped from the memo so the next call (the
 * block's automatic re-attempt, a later mount, or the Retry button) issues a
 * fresh `import()` instead of replaying the cached rejection.
 */
export function loadMermaidRuntime(): Promise<Mermaid> {
  if (runtime) return Promise.resolve(runtime);
  if (!pending) {
    const attempt = loader().then(
      (loaded) => {
        setMermaidRuntime(loaded, 'loader');
        return loaded;
      },
      (err: unknown) => {
        if (pending === attempt) pending = null;
        throw err;
      },
    );
    pending = attempt;
  }
  return pending;
}

/** Test hook: empty the slot, stand in for the lazy import, shorten the retry delay. */
export function __setMermaidRuntimeLoaderForTests(
  next: MermaidRuntimeLoader | undefined,
  options?: { retryDelayMs?: number },
): void {
  runtime = null;
  runtimeSource = null;
  pending = null;
  loader = next ?? defaultMermaidLoader;
  retryDelayMs = options?.retryDelayMs ?? 750;
}
