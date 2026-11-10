import { setImageSrcResolver, type ImageSrcResolver } from './components/ImageThumbnail';
import { setDocPreviewFetcher, type DocPreviewFetcher, type DocPreviewResult } from './components/InlineMarkdown';
import { setStorageBackend, type StorageBackend } from './utils/storage';
import { setUploadTransport, type UploadTransport, type UploadResult } from './utils/upload';
import { setIdentityProvider, type IdentityProvider } from './utils/identity';
import { setFileTreeBackend, type FileTreeBackend } from './hooks/useFileBrowser';
import { setDraftTransport, type DraftTransport } from './hooks/useAnnotationDraft';
import { setExternalAnnotationTransport, type ExternalAnnotationTransport } from './hooks/useExternalAnnotations';
import { setAITransport, type AITransport } from './hooks/useAIChat';
import { setSkillCatalogExportRegistration, setSkillCatalogTransport, setSkillContentTransport, type SkillCatalogTransport, type SkillContentTransport } from './utils/skillCatalog';
import { setWebMcpPolicy, type WebMcpPolicy } from './webmcp/policy';
import { setMathRendererLoader, type MathRenderer, type MathRendererLoader } from './utils/math';
import { setIdentityGenerator, type IdentityGenerator } from './utils/generateIdentity';
import { setAlertIconRenderer, type AlertIconRenderer } from './components/blocks/AlertBlock';
import { setSkillInstructionsDestination } from './components/SkillReferenceMenu';
import { setFenceThemeResolver, type FenceThemeResolver } from './utils/syntaxTheme';
import { setCodeHighlightWorker, setDeferOffscreenCodeHighlight, type CodeHighlightWorker } from './utils/codeHighlight';
import { configStore } from './config';
import type { ServerSyncFn } from './config/configStore';
import type { ExternalAnnotationEvent, VaultNode } from './types';
import { setComponentTooltips } from './components/HostTitle';
import { setRichCopyEnabled } from './utils/richCopyPolicy';
import { setCommentCardEnabled, setVisibleCommentDrafts, type CommentCardLayout } from './utils/commentCardPolicy';
import { setTouchSelectionToolbar } from './utils/touchToolbarPlacement';
import { setPageMarks } from './utils/pageMarks';
import { getPressAndDrag, setPressAndDrag } from './utils/pressAndDragPolicy';
import { setCrossRepoRefsWithoutRepo, setDigitHexIssueRefs, type CrossRepoRefsWithoutRepo } from './components/InlineMarkdown';
import { setRefCardTransport, type RefCardTransport } from './utils/refCard';

// One-stop type barrel: every seam contract a host implements is importable
// from this module, next to configurePlannotatorUI itself.
export type { CommentCardLayout } from './utils/commentCardPolicy';
export type {
  ImageSrcResolver,
  DocPreviewFetcher,
  DocPreviewResult,
  StorageBackend,
  UploadTransport,
  UploadResult,
  IdentityProvider,
  FileTreeBackend,
  VaultNode,
  DraftTransport,
  ExternalAnnotationTransport,
  ExternalAnnotationEvent,
  AITransport,
  SkillCatalogTransport,
  SkillContentTransport,
  ServerSyncFn,
  WebMcpPolicy,
  MathRenderer,
  MathRendererLoader,
  IdentityGenerator,
  AlertIconRenderer,
  FenceThemeResolver,
  RefCardTransport,
  CodeHighlightWorker,
};

type ExternalAnnotationBase = { id: string; source?: string };

export interface PlannotatorUIConfig {
  imageSrcResolver?: ImageSrcResolver;
  storageBackend?: StorageBackend;
  uploadTransport?: UploadTransport;
  docPreviewFetcher?: DocPreviewFetcher;
  fileTreeBackend?: FileTreeBackend;
  identityProvider?: IdentityProvider;
  draftTransport?: DraftTransport;
  /**
   * Base-constraint transport. If your annotation type extends the base
   * constraint ({ id: string; source?: string }) with extra fields, call
   * setExternalAnnotationTransport<YourType>() directly for full type safety —
   * this front-door field intentionally pins the base constraint for ergonomics.
   */
  externalAnnotationTransport?: ExternalAnnotationTransport<ExternalAnnotationBase>;
  aiTransport?: AITransport;
  /** Skill-reference catalog request. Default: `GET /api/skills` on the page origin. */
  skillCatalogTransport?: SkillCatalogTransport;
  /** Human-only skill contents request for feedback injection. Default: `GET /api/skills/content?name=` on the page origin. */
  skillContentTransport?: SkillContentTransport;
  /**
   * Register the fetched skill catalog for the per-comment feedback export
   * (each comment's "Skills referenced" list). Default: true. A host that
   * composes one block per message itself passes false, so a comment's
   * `$name` stays plain text in its export.
   */
  skillReferenceExport?: boolean;
  /**
   * What a composer's "Includes skill instructions" line says a human-only
   * skill's instructions go with. Default: "your feedback". The Plannotator
   * Inbox, where a comment rides a reply, says "your reply".
   */
  skillInstructionsDestination?: string;
  serverSync?: ServerSyncFn;
  /**
   * WebMCP provider policy: `{ enabled, namePrefix }`. Default: enabled
   * whenever the browser exposes `document.modelContext`, with the
   * `plannotator.` prefix. There is no confirmation seam because the catalog
   * exposes nothing consequential: no tool decides, submits or closes.
   */
  webmcp?: WebMcpPolicy;
  /**
   * How the math renderer is loaded when no renderer is registered before the
   * first math node renders. Default: `import('katex')` (JS only; the
   * stylesheet stays the host's job). A host that wants KaTeX and its CSS on
   * one lazy chunk passes a loader that imports both. Hosts that want math
   * typeset on the first commit instead import `@plannotator/ui/utils/math-eager`.
   */
  mathRendererLoader?: MathRendererLoader;
  /**
   * Synchronous generator for the default "tater" display name, used only when
   * no `identityProvider` is installed. Default: a small built-in pool of the
   * same `adjective-noun-tater` shape. Plannotator registers the full
   * dictionary by importing `@plannotator/ui/utils/identity-tater`.
   */
  identityGenerator?: IdentityGenerator;
  /**
   * Resolve a GitHub alert title line's `<!-- icon: name -->` to a React node.
   * Default: null for every name, so alerts keep the type's own icon exactly as
   * today; the package bundles no icon set. A host with one registers a renderer.
   */
  alertIconRenderer?: AlertIconRenderer;
  /**
   * Pick the Shiki theme code fences render in, per (palette id, resolved
   * mode). Return `undefined` to keep the default resolution (the palette's
   * `SHIKI_THEME_MAP` entry, else `pierre-dark` / `pierre-light`). Applies to
   * every fence-style surface (Viewer fences, the code-file hover preview, the
   * plan diff view, code review suggestion snippets); the code-review diff
   * pane keeps its own pair. An unknown theme name renders plain text.
   */
  fenceTheme?: FenceThemeResolver;
  /**
   * Draw ui's own hover text (the annotation panel's and toolbar's buttons, a
   * question card's decision tag, a host-resolved local link's
   * `LocalLinkResolution.title`) as ui's `Tooltip` instead of a native
   * `title` (`components/HostTitle`). Default: false, native titles exactly
   * as before. The Plannotator Inbox passes true.
   */
  componentTooltips?: boolean;
  /**
   * Render a digit-only 6/8-digit `#123456` (word boundary, no leading zero)
   * as an issue ref instead of a hex colour swatch, when a ref link can be
   * built (a repo on a known forge). Default: false, swatches exactly as
   * before. The Plannotator Inbox passes true (#1932).
   */
  digitHexIssueRefs?: boolean;
  /**
   * Link an `owner/repo#123` ref where the text's caller names no repo of
   * its own (`InlineMarkdown` without `githubRepo`). `true`: on github.com.
   * `{ host }`: on that host, by `forgeRefLinks`' rule (GitLab's
   * `/-/issues/N`; a host it cannot form a link for leaves refs plain).
   * Default: false, such refs stay plain text exactly as before. A caller
   * that names its repo is unchanged, and bare `#123` still needs that repo.
   * May be called again later: mounted text re-renders with the new host.
   * The Plannotator Inbox passes the host most of its projects use.
   */
  crossRepoRefsWithoutRepo?: CrossRepoRefsWithoutRepo;
  /**
   * Make the selection toolbar's Copy button (Viewer and HtmlViewer) copy rich
   * text: text/html plus text/plain in one clipboard write, and show Copy
   * where `hideCopyButton` hid it (the Viewer on desktop). Default: false,
   * Copy exactly as before. Plannotator's plan review, annotate, code review
   * and Inbox pass true (#1972, `utils/richCopyPolicy`).
   */
  richCopy?: boolean;
  /**
   * Draw `CommentPopover` as the small comment card (no header line, no
   * blurred page behind, a chevron that closes and keeps the words, a solid
   * "Comment" button at the row's right end). Import
   * `@plannotator/ui/comment-card.css` with it. An object turns it on and
   * names, as CSS selectors, the host's pane (where a docked card spans) and
   * the things at its foot the card never covers. Default: false, the popover
   * exactly as before. The Plannotator Inbox turns it on
   * (`utils/commentCardPolicy`).
   */
  commentCard?: boolean | CommentCardLayout;
  /**
   * Keep a closed text-selection comment that holds words visible: a pale
   * highlight and a floating "Draft" badge under the words' end, a press on
   * either reopening the box (Viewer). Default: false, a closed box leaves no
   * mark, as before. The Plannotator Inbox passes true.
   */
  visibleCommentDrafts?: boolean;
  /**
   * On a touch screen (main pointer a finger), put the selection toolbar
   * (`AnnotationToolbar`) below the selection, where iOS Safari's own edit
   * menu does not go, keep it inside the visible screen with an 8px margin
   * and the safe-area insets, and give its buttons 44px targets
   * (`utils/touchToolbarPlacement`).
   * Default: false, the toolbar placed and sized exactly as before. With it
   * on, nothing changes with a mouse or trackpad. Plannotator's plan review,
   * annotate, code review and Inbox pass true.
   */
  touchSelectionToolbar?: boolean;
  /**
   * Mark the page's root while a part a theme.css or comments.css `:has()` on
   * `html` or `body` keys on is there: `<body data-pn-popout>` while a popout
   * dialog is open, `<html data-pn-selection-chooser>` while the diff's
   * selection chooser shows (`utils/pageMarks`). For a host that rewrites
   * those `:has()` selectors to the marks in its build: on a long page each
   * such `:has()` costs a style pass over the whole document on every DOM
   * change. Default: false, nothing is marked. The Plannotator Inbox passes
   * true (build/inbox-page-marks.ts).
   */
  pageMarks?: boolean;
  /**
   * web-highlighter's `pressAndDrag`: a text selection released outside the
   * document (over a side panel, a toolbar, outside the window) still becomes
   * a highlight, and `useAnnotationHighlighter` checks the selection at a
   * release anywhere on the page, not only inside the document
   * (`utils/pressAndDragPolicy`). Read when a document's highlighter is made,
   * so set it before documents mount. It needs a web-highlighter that has the
   * option; with 0.8.2 nothing changes. Default: false, every selection
   * exactly as before. Plannotator's own apps do not pass it.
   */
  pressAndDrag?: boolean;
  /**
   * web-highlighter's `pressAndDragThreshold`: how far, in CSS px, a press
   * must move to count as a drag. Used only with `pressAndDrag`. Default: the
   * library's own (4).
   */
  pressAndDragThreshold?: number;
  /**
   * Fetch an issue / PR / MR hover card's data (`components/RefHoverCard`).
   * Default: none, so no card is drawn and nothing is requested. The
   * Plannotator Inbox passes one over its `/api/inbox/ref` route.
   */
  refCardTransport?: RefCardTransport;
  /**
   * Highlight a code fence only when it comes near the screen (a screen
   * above or below it), and the rest in idle time, nearest first
   * (`utils/codeHighlight`). A fence on screen is still highlighted before
   * it is drawn; one farther away keeps its plain text (the same characters
   * and size) until then. For a host that shows many fences at once (a long
   * thread), where highlighting all of them at once blocks the page for
   * seconds. Default: false, every fence highlighted when it mounts, as
   * before. The Plannotator Inbox passes true.
   */
  deferOffscreenCodeHighlight?: boolean;
  /**
   * With `deferOffscreenCodeHighlight`: make a waiting fence's markup off the
   * main thread (`utils/codeHighlight` `CodeHighlightWorker`, e.g. a Web
   * Worker with its own Shiki core). Only the markup is written on the page.
   * Default: none, every fence's tokens made on the page. The Plannotator
   * Inbox passes one (`packages/inbox/codeHighlightWorker.ts`).
   */
  codeHighlightWorker?: CodeHighlightWorker;
  /** Re-hydrate settings from the installed (SYNCHRONOUS) storageBackend after install. */
  loadSettingsFromBackend?: boolean;
}

export function configurePlannotatorUI(config: PlannotatorUIConfig): void {
  if (config.imageSrcResolver) setImageSrcResolver(config.imageSrcResolver);
  if (config.storageBackend) setStorageBackend(config.storageBackend);
  if (config.uploadTransport) setUploadTransport(config.uploadTransport);
  if (config.docPreviewFetcher) setDocPreviewFetcher(config.docPreviewFetcher);
  if (config.fileTreeBackend) setFileTreeBackend(config.fileTreeBackend);
  if (config.identityProvider) setIdentityProvider(config.identityProvider);
  if (config.draftTransport) setDraftTransport(config.draftTransport);
  if (config.externalAnnotationTransport) setExternalAnnotationTransport(config.externalAnnotationTransport);
  if (config.aiTransport) setAITransport(config.aiTransport);
  if (config.skillCatalogTransport) setSkillCatalogTransport(config.skillCatalogTransport);
  if (config.skillContentTransport) setSkillContentTransport(config.skillContentTransport);
  if (config.skillReferenceExport !== undefined) setSkillCatalogExportRegistration(config.skillReferenceExport);
  if (config.skillInstructionsDestination) setSkillInstructionsDestination(config.skillInstructionsDestination);
  if (config.serverSync) configStore.setServerSync(config.serverSync);
  if (config.webmcp) setWebMcpPolicy(config.webmcp);
  if (config.mathRendererLoader) setMathRendererLoader(config.mathRendererLoader);
  if (config.identityGenerator) setIdentityGenerator(config.identityGenerator);
  if (config.alertIconRenderer) setAlertIconRenderer(config.alertIconRenderer);
  if (config.fenceTheme) setFenceThemeResolver(config.fenceTheme);
  if (config.componentTooltips !== undefined) setComponentTooltips(config.componentTooltips);
  if (config.digitHexIssueRefs !== undefined) setDigitHexIssueRefs(config.digitHexIssueRefs);
  if (config.crossRepoRefsWithoutRepo !== undefined) setCrossRepoRefsWithoutRepo(config.crossRepoRefsWithoutRepo);
  if (config.richCopy !== undefined) setRichCopyEnabled(config.richCopy);
  if (config.commentCard !== undefined) setCommentCardEnabled(config.commentCard);
  if (config.visibleCommentDrafts !== undefined) setVisibleCommentDrafts(config.visibleCommentDrafts);
  if (config.touchSelectionToolbar !== undefined) setTouchSelectionToolbar(config.touchSelectionToolbar);
  if (config.pageMarks !== undefined) setPageMarks(config.pageMarks);
  if (config.pressAndDrag !== undefined || config.pressAndDragThreshold !== undefined) {
    setPressAndDrag(
      config.pressAndDrag ?? getPressAndDrag().on,
      config.pressAndDragThreshold ?? getPressAndDrag().threshold,
    );
  }
  if (config.refCardTransport) setRefCardTransport(config.refCardTransport);
  if (config.deferOffscreenCodeHighlight !== undefined) setDeferOffscreenCodeHighlight(config.deferOffscreenCodeHighlight);
  if (config.codeHighlightWorker) setCodeHighlightWorker(config.codeHighlightWorker);
  // Re-hydrate AFTER storageBackend is installed (load-bearing order — gated last).
  if (config.loadSettingsFromBackend) configStore.loadFromBackend();
}
