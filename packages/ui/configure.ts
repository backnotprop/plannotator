import { setImageSrcResolver, type ImageSrcResolver } from './components/ImageThumbnail';
import { setDocPreviewFetcher, type DocPreviewFetcher, type DocPreviewResult } from './components/InlineMarkdown';
import { setStorageBackend, type StorageBackend } from './utils/storage';
import { setUploadTransport, type UploadTransport, type UploadResult } from './utils/upload';
import { setIdentityProvider, type IdentityProvider } from './utils/identity';
import { setFileTreeBackend, type FileTreeBackend } from './hooks/useFileBrowser';
import { setDraftTransport, type DraftTransport } from './hooks/useAnnotationDraft';
import { setExternalAnnotationTransport, type ExternalAnnotationTransport } from './hooks/useExternalAnnotations';
import { setAITransport, type AITransport } from './hooks/useAIChat';
import { setSkillCatalogTransport, setSkillContentTransport, type SkillCatalogTransport, type SkillContentTransport } from './utils/skillCatalog';
import { setWebMcpPolicy, type WebMcpPolicy } from './webmcp/policy';
import { setMathRendererLoader, type MathRenderer, type MathRendererLoader } from './utils/math';
import { setIdentityGenerator, type IdentityGenerator } from './utils/generateIdentity';
import { setAlertIconRenderer, type AlertIconRenderer } from './components/blocks/AlertBlock';
import { configStore } from './config';
import type { ServerSyncFn } from './config/configStore';
import type { ExternalAnnotationEvent, VaultNode } from './types';

// One-stop type barrel: every seam contract a host implements is importable
// from this module, next to configurePlannotatorUI itself.
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
  if (config.serverSync) configStore.setServerSync(config.serverSync);
  if (config.webmcp) setWebMcpPolicy(config.webmcp);
  if (config.mathRendererLoader) setMathRendererLoader(config.mathRendererLoader);
  if (config.identityGenerator) setIdentityGenerator(config.identityGenerator);
  if (config.alertIconRenderer) setAlertIconRenderer(config.alertIconRenderer);
  // Re-hydrate AFTER storageBackend is installed (load-bearing order — gated last).
  if (config.loadSettingsFromBackend) configStore.loadFromBackend();
}
