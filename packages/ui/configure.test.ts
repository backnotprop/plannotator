import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';

import * as ImageThumbnail from './components/ImageThumbnail';
import * as InlineMarkdown from './components/InlineMarkdown';
import * as storage from './utils/storage';
import * as upload from './utils/upload';
import * as identity from './utils/identity';
import * as useFileBrowser from './hooks/useFileBrowser';
import * as useAnnotationDraft from './hooks/useAnnotationDraft';
import * as useExternalAnnotations from './hooks/useExternalAnnotations';
import * as useAIChat from './hooks/useAIChat';
import { configStore } from './config';

import type { ImageSrcResolver } from './components/ImageThumbnail';
import type { DocPreviewFetcher } from './components/InlineMarkdown';
import type { StorageBackend } from './utils/storage';
import type { UploadTransport } from './utils/upload';
import type { IdentityProvider } from './utils/identity';
import type { FileTreeBackend } from './hooks/useFileBrowser';
import type { DraftTransport } from './hooks/useAnnotationDraft';
import type { ExternalAnnotationTransport } from './hooks/useExternalAnnotations';
import type { AITransport } from './hooks/useAIChat';

// Capture the REAL exports at module-evaluation time (top-level, before any
// mock.module() is installed). These are used to restore the module registry
// in afterAll so that any sibling test files run in the same Bun worker see
// the real exports when THEY evaluate after this file finishes.
const realSetImageSrcResolver = ImageThumbnail.setImageSrcResolver;
const realResetImageSrcResolver = ImageThumbnail.resetImageSrcResolver;
const realSetDocPreviewFetcher = InlineMarkdown.setDocPreviewFetcher;
const realResetDocPreviewFetcher = InlineMarkdown.resetDocPreviewFetcher;
const realSetStorageBackend = storage.setStorageBackend;
const realResetStorageBackend = storage.resetStorageBackend;
const realSetUploadTransport = upload.setUploadTransport;
const realResetUploadTransport = upload.resetUploadTransport;
const realSetIdentityProvider = identity.setIdentityProvider;
const realResetIdentityProvider = identity.resetIdentityProvider;
const realSetFileTreeBackend = useFileBrowser.setFileTreeBackend;
const realResetFileTreeBackend = useFileBrowser.resetFileTreeBackend;
const realSetDraftTransport = useAnnotationDraft.setDraftTransport;
const realResetDraftTransport = useAnnotationDraft.resetDraftTransport;
const realSetExternalAnnotationTransport = useExternalAnnotations.setExternalAnnotationTransport;
const realResetExternalAnnotationTransport = useExternalAnnotations.resetExternalAnnotationTransport;
const realSetAITransport = useAIChat.setAITransport;
const realResetAITransport = useAIChat.resetAITransport;

// Spy mocks — will be installed into the module registry in beforeAll.
const setImageSrcResolver = mock((_: ImageSrcResolver) => {});
const setDocPreviewFetcher = mock((_: DocPreviewFetcher) => {});
const setStorageBackend = mock((_: StorageBackend) => {});
const setUploadTransport = mock((_: UploadTransport) => {});
const setIdentityProvider = mock((_: IdentityProvider) => {});
const setFileTreeBackend = mock((_: FileTreeBackend) => {});
const setDraftTransport = mock((_: DraftTransport) => {});
const setExternalAnnotationTransport = mock((_: ExternalAnnotationTransport<{ id: string; source?: string }>) => {});
const setAITransport = mock((_: AITransport) => {});

// configStore is shared with sibling suites — spy on the real instance methods
// instead of replacing the ./config module.
const setServerSync = spyOn(configStore, 'setServerSync');
const loadFromBackend = spyOn(configStore, 'loadFromBackend').mockImplementation(() => {});

// Shape-correct fakes (only need to satisfy the front door's optional fields).
const imageSrcResolver: ImageSrcResolver = (path) => path;
const docPreviewFetcher: DocPreviewFetcher = async () => null;
const storageBackend: StorageBackend = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const uploadTransport: UploadTransport = { upload: async () => ({ path: '/tmp/x.png' }) };
const identityProvider: IdentityProvider = { getIdentity: () => 'tater', isCurrentUser: () => false };
const fileTreeBackend: FileTreeBackend = {
  loadTree: async () => new Response('{}'),
  loadVaultTree: async () => new Response('{}'),
  watchTrees: () => undefined,
};
const draftTransport: DraftTransport = {
  load: async () => ({ data: null, generation: null }),
  save: async () => {},
  remove: async () => {},
};
const externalAnnotationTransport: ExternalAnnotationTransport<{ id: string; source?: string }> = {
  subscribe: () => () => {},
  getSnapshot: async () => null,
  add: async () => {},
  remove: async () => {},
  update: async () => {},
  clear: async () => {},
};
const aiTransport: AITransport = {
  session: async () => new Response(),
  query: async () => new Response(),
  abort: async () => {},
  permission: () => {},
};
const serverSync = (_payload: Record<string, unknown>) => {};

describe('configurePlannotatorUI routing', () => {
  // Install mock.module() replacements HERE (in beforeAll, not at top-level)
  // so that sibling seam test files' top-level captures (which happen at module
  // evaluation time, BEFORE this beforeAll runs) see the real exports.
  //
  // Bun runs test files sequentially: file A's top-level → file A's tests
  // (including beforeAll/afterAll) → file B's top-level → file B's tests.
  // Because configure.test.ts runs before the seam test files (alphabetical),
  // the seam files evaluate AFTER this file's afterAll — so they see whatever
  // state this afterAll leaves the module registry in. We MUST restore with
  // captured real functions (not `{ ...storage }`) because spreading the live
  // namespace after mock.module() returns the mocked version.
  beforeAll(async () => {
    mock.module('./components/ImageThumbnail', () => ({
      ...ImageThumbnail,
      setImageSrcResolver,
      resetImageSrcResolver: realResetImageSrcResolver,
    }));
    mock.module('./components/InlineMarkdown', () => ({
      ...InlineMarkdown,
      setDocPreviewFetcher,
      resetDocPreviewFetcher: realResetDocPreviewFetcher,
    }));
    mock.module('./utils/storage', () => ({
      ...storage,
      setStorageBackend,
      resetStorageBackend: realResetStorageBackend,
    }));
    mock.module('./utils/upload', () => ({
      ...upload,
      setUploadTransport,
      resetUploadTransport: realResetUploadTransport,
    }));
    mock.module('./utils/identity', () => ({
      ...identity,
      setIdentityProvider,
      resetIdentityProvider: realResetIdentityProvider,
    }));
    mock.module('./hooks/useFileBrowser', () => ({
      ...useFileBrowser,
      setFileTreeBackend,
      resetFileTreeBackend: realResetFileTreeBackend,
    }));
    mock.module('./hooks/useAnnotationDraft', () => ({
      ...useAnnotationDraft,
      setDraftTransport,
      resetDraftTransport: realResetDraftTransport,
    }));
    mock.module('./hooks/useExternalAnnotations', () => ({
      ...useExternalAnnotations,
      setExternalAnnotationTransport,
      resetExternalAnnotationTransport: realResetExternalAnnotationTransport,
    }));
    mock.module('./hooks/useAIChat', () => ({
      ...useAIChat,
      setAITransport,
      resetAITransport: realResetAITransport,
    }));
  });

  afterAll(() => {
    mock.restore();
    // Restore using CAPTURED REAL FUNCTIONS (not `{ ...storage }` which would
    // spread the mocked namespace and leave spies in place for sibling files).
    mock.module('./components/ImageThumbnail', () => ({
      ...ImageThumbnail,
      setImageSrcResolver: realSetImageSrcResolver,
      resetImageSrcResolver: realResetImageSrcResolver,
    }));
    mock.module('./components/InlineMarkdown', () => ({
      ...InlineMarkdown,
      setDocPreviewFetcher: realSetDocPreviewFetcher,
      resetDocPreviewFetcher: realResetDocPreviewFetcher,
    }));
    mock.module('./utils/storage', () => ({
      ...storage,
      setStorageBackend: realSetStorageBackend,
      resetStorageBackend: realResetStorageBackend,
    }));
    mock.module('./utils/upload', () => ({
      ...upload,
      setUploadTransport: realSetUploadTransport,
      resetUploadTransport: realResetUploadTransport,
    }));
    mock.module('./utils/identity', () => ({
      ...identity,
      setIdentityProvider: realSetIdentityProvider,
      resetIdentityProvider: realResetIdentityProvider,
    }));
    mock.module('./hooks/useFileBrowser', () => ({
      ...useFileBrowser,
      setFileTreeBackend: realSetFileTreeBackend,
      resetFileTreeBackend: realResetFileTreeBackend,
    }));
    mock.module('./hooks/useAnnotationDraft', () => ({
      ...useAnnotationDraft,
      setDraftTransport: realSetDraftTransport,
      resetDraftTransport: realResetDraftTransport,
    }));
    mock.module('./hooks/useExternalAnnotations', () => ({
      ...useExternalAnnotations,
      setExternalAnnotationTransport: realSetExternalAnnotationTransport,
      resetExternalAnnotationTransport: realResetExternalAnnotationTransport,
    }));
    mock.module('./hooks/useAIChat', () => ({
      ...useAIChat,
      setAITransport: realSetAITransport,
      resetAITransport: realResetAITransport,
    }));
  });

  it('routes each provided seam to its underlying setter', async () => {
    const { configurePlannotatorUI } = await import('./configure');

    configurePlannotatorUI({
      imageSrcResolver,
      storageBackend,
      uploadTransport,
      docPreviewFetcher,
      fileTreeBackend,
      identityProvider,
      draftTransport,
      externalAnnotationTransport,
      aiTransport,
      serverSync,
      loadSettingsFromBackend: true,
    });

    expect(setImageSrcResolver).toHaveBeenCalledWith(imageSrcResolver);
    expect(setDocPreviewFetcher).toHaveBeenCalledWith(docPreviewFetcher);
    expect(setStorageBackend).toHaveBeenCalledWith(storageBackend);
    expect(setUploadTransport).toHaveBeenCalledWith(uploadTransport);
    expect(setIdentityProvider).toHaveBeenCalledWith(identityProvider);
    expect(setFileTreeBackend).toHaveBeenCalledWith(fileTreeBackend);
    expect(setDraftTransport).toHaveBeenCalledWith(draftTransport);
    expect(setExternalAnnotationTransport).toHaveBeenCalledWith(externalAnnotationTransport);
    expect(setAITransport).toHaveBeenCalledWith(aiTransport);
    expect(setServerSync).toHaveBeenCalledWith(serverSync);
    expect(loadFromBackend).toHaveBeenCalledTimes(1);

    // load-bearing order: storageBackend installed before loadFromBackend re-hydrates.
    expect(setStorageBackend.mock.invocationCallOrder[0]).toBeLessThan(
      loadFromBackend.mock.invocationCallOrder[0],
    );
  });

  it('skips setters for omitted fields', async () => {
    const { configurePlannotatorUI } = await import('./configure');

    [
      setImageSrcResolver, setDocPreviewFetcher, setStorageBackend, setUploadTransport,
      setIdentityProvider, setFileTreeBackend, setDraftTransport, setExternalAnnotationTransport,
      setAITransport, setServerSync, loadFromBackend,
    ].forEach((m) => m.mockClear());

    configurePlannotatorUI({ storageBackend });

    expect(setStorageBackend).toHaveBeenCalledTimes(1);
    expect(setImageSrcResolver).not.toHaveBeenCalled();
    expect(setAITransport).not.toHaveBeenCalled();
    expect(loadFromBackend).not.toHaveBeenCalled();
  });
});
