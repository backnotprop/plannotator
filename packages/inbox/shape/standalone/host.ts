/**
 * The standalone Shape page's ShapeHost (packages/ui/components/shape/types.ts):
 * the board reads and writes the Shapes server's Shape routes, the same ones
 * the Inbox mounts.
 *
 * - Change it and Ask: stored. Both wait for the agent: it picks them up with
 *   `plannotator shape read --notes` and answers an Ask with `plannotator
 *   shape answer`. There is no thread, so no session is asked here and no Ask
 *   AI answers: the board says the question waits for the agent (the
 *   Inbox's label, `askWaitsWhenEnded`).
 * - The event feed (`/api/shapes/events`, the page's one stream) tells an open
 *   board what changed: a version, "drawing", a delivery, an answer.
 * - Files and hover: the shape's project folder, through code-nav.
 * - Copy prompt: the command any session runs to pick up what waits.
 */
import type { ShapeNote, ShapeVersion } from '@plannotator/core/shape';
import type { ShapeHost, ShapeLoaded } from '@plannotator/ui/components/shape';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { shapeEventsBetween } from '../events';
import type { ShapeLoadedWire, ShapePageApi } from './api';

export interface StandaloneShapeHostOptions {
  api: ShapePageApi;
  /** Every change the event feed names (an empty list: read everything again). Returns the unsubscribe. */
  subscribe: (listener: (ids: string[]) => void) => () => void;
  /** The `plannotator` command (Copy prompt). */
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
      // Stored; the agent answers it with `plannotator shape answer`, and the event feed brings the answer here.
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
  };
}
