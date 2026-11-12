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
import * as webmcpPolicy from './webmcp/policy';
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
const realSetWebMcpPolicy = webmcpPolicy.setWebMcpPolicy;
const realResetWebMcpPolicy = webmcpPolicy.resetWebMcpPolicy;
const realGetWebMcpPolicy = webmcpPolicy.getWebMcpPolicy;

const setImageSrcResolver = mock((_: ImageSrcResolver) => {});
const setDocPreviewFetcher = mock((_: DocPreviewFetcher) => {});
const setStorageBackend = mock((_: StorageBackend) => {});
const setUploadTransport = mock((_: UploadTransport) => {});
const setIdentityProvider = mock((_: IdentityProvider) => {});
const setFileTreeBackend = mock((_: FileTreeBackend) => {});
const setDraftTransport = mock((_: DraftTransport) => {});
const setExternalAnnotationTransport = mock((_: ExternalAnnotationTransport<{ id: string; source?: string }>) => {});
const setAITransport = mock((_: AITransport) => {});
const setWebMcpPolicy = mock((_: webmcpPolicy.WebMcpPolicy) => {});

const setServerSync = spyOn(configStore, 'setServerSync');
const loadFromBackend = spyOn(configStore, 'loadFromBackend').mockImplementation(() => {});

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
    mock.module('./webmcp/policy', () => ({
      ...webmcpPolicy,
      setWebMcpPolicy,
      resetWebMcpPolicy: realResetWebMcpPolicy,
      getWebMcpPolicy: realGetWebMcpPolicy,
    }));
  });

  afterAll(() => {
    mock.restore();
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
    mock.module('./webmcp/policy', () => ({
      ...webmcpPolicy,
      setWebMcpPolicy: realSetWebMcpPolicy,
      resetWebMcpPolicy: realResetWebMcpPolicy,
      getWebMcpPolicy: realGetWebMcpPolicy,
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
      webmcp: { enabled: false, namePrefix: 'host.' },
      loadSettingsFromBackend: true,
    });

    expect(setWebMcpPolicy).toHaveBeenCalledWith({ enabled: false, namePrefix: 'host.' });
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

    expect(setStorageBackend.mock.invocationCallOrder[0]).toBeLessThan(
      loadFromBackend.mock.invocationCallOrder[0],
    );
  });

  it('skips setters for omitted fields', async () => {
    const { configurePlannotatorUI } = await import('./configure');

    [
      setImageSrcResolver, setDocPreviewFetcher, setStorageBackend, setUploadTransport,
      setIdentityProvider, setFileTreeBackend, setDraftTransport, setExternalAnnotationTransport,
      setAITransport, setServerSync, loadFromBackend, setWebMcpPolicy,
    ].forEach((m) => m.mockClear());

    configurePlannotatorUI({ storageBackend });

    expect(setStorageBackend).toHaveBeenCalledTimes(1);
    expect(setWebMcpPolicy).not.toHaveBeenCalled();
    expect(setImageSrcResolver).not.toHaveBeenCalled();
    expect(setAITransport).not.toHaveBeenCalled();
    expect(loadFromBackend).not.toHaveBeenCalled();
  });
});
