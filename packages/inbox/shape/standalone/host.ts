import type { ShapeNote, ShapeVersion } from '@plannotator/core/shape';
import type { ShapeHost, ShapeLoaded } from '@plannotator/ui/components/shape';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { shapeEventsBetween } from '../events';
import type { ShapeLoadedWire, ShapePageApi } from './api';

export interface StandaloneShapeHostOptions {
  api: ShapePageApi;
  subscribe: (listener: (ids: string[]) => void) => () => void;
  command?: string;
  copy?: (text: string) => Promise<void> | void;
}

export function createStandaloneShapeHost(options: StandaloneShapeHostOptions): ShapeHost {
  const { api } = options;
  const last = new Map<string, ShapeLoadedWire>();

  const load = async (id: string): Promise<ShapeLoadedWire> => {
    const loaded = await api.shape(id);
    last.set(id, loaded);
    return loaded;
  };

  return {
    async load(id): Promise<ShapeLoaded> {
      const loaded = await load(id);
      return { shape: loaded.shape, version: loaded.version, seen: loaded.seen, notes: loaded.notes, session: loaded.session };
    },
    async version(id, n): Promise<ShapeVersion | null> {
      try {
        return (await api.shape(id, n)).version;
      } catch {
        return null;
      }
    },
    async note(id, input): Promise<ShapeNote> {
      return (await api.note(id, { ...input })).note;
    },
    async ask(id, input) {
      const question = (await api.note(id, { ...input, kind: 'ask' })).note;
      return { question, answer: null };
    },
    seen(id, n) {
      void api.seen(id, n).catch(() => {});
    },
    events(id, listener) {
      return options.subscribe((ids) => {
        if (ids.length && !ids.includes(id)) return;
        const before = last.get(id);
        void load(id)
          .then((now) => {
            for (const e of shapeEventsBetween(before ?? null, now)) listener(e);
          })
          .catch(() => {});
      });
    },
    async readFile(id, path) {
      try {
        return (await api.codeFile(id, path)).content;
      } catch {
        return null;
      }
    },
    async codeHover(id, request) {
      try {
        return await api.codeHover(id, { ...request });
      } catch {
        return null;
      }
    },
    assetUrl(id, src) {
      const name = src.replace(/^files\//, '');
      return `/api/shapes/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`;
    },
    resumePrompt(id) {
      return `${options.command || 'plannotator'} shape read ${id} --notes`;
    },
    async copy(text) {
      await (options.copy ?? copyTextToClipboard)(text);
    },
    askWaitsWhenEnded: true,
    sessionless: true,
  };
}
