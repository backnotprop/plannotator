import { setImageSrcResolver, type ImageSrcResolver } from './components/ImageThumbnail';
import { setDocPreviewFetcher, type DocPreviewFetcher, type DocPreviewResult } from './components/InlineMarkdown';
import { setStorageBackend, type StorageBackend } from './utils/storage';
import { setUploadTransport, type UploadTransport, type UploadResult } from './utils/upload';
import { setIdentityProvider, type IdentityProvider } from './utils/identity';
import { setFileTreeBackend, type FileTreeBackend } from './hooks/useFileBrowser';
import { setDraftTransport, type DraftTransport } from './hooks/useAnnotationDraft';
import { setExternalAnnotationTransport, type ExternalAnnotationTransport } from './hooks/useExternalAnnotations';
import { setAITransport, type AITransport } from './hooks/useAIChat';
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
  ServerSyncFn,
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
  serverSync?: ServerSyncFn;
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
  if (config.serverSync) configStore.setServerSync(config.serverSync);
  // Re-hydrate AFTER storageBackend is installed (load-bearing order — gated last).
  if (config.loadSettingsFromBackend) configStore.loadFromBackend();
}
