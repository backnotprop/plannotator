import { createElement } from 'react';
import { shapeNoteWaits, type ShapeNote, type ShapeNoteInput, type ShapeVersion } from '@plannotator/core/shape';
import type { ShapeHost, ShapeLoaded } from '@plannotator/ui/components/shape';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { generateId } from '@plannotator/ui/utils/generateId';
import { InboxApiError, inboxApi, type InboxAskModel, type ShapeLoadedWire } from '../api';
import { onAskChange } from '../ask/askEvents';
import { readAsk } from '../ask/askReads';
import { OpenInFile } from '../components/OpenIn';
import { shapeEventsBetween } from './events';

export { shapeEventsBetween };

const ASK_CONTEXT = { mode: 'annotate', annotate: { filePath: '', content: '' } } as const;

export interface InboxShapeHostOptions {
  subscribe: (listener: (ids: string[]) => void) => () => void;
  command?: string | null;
  wakeOnChange?: () => boolean;
  busyRetryMs?: number;
  fetch?: typeof fetch;
  openIn?: boolean;
}

export function shapeAskPrompt(loaded: { shape: { id: string; title: string }; version: { n: number } }, input: ShapeNoteInput): string {
  const where = [input.view ? `the ${input.view} view` : null, input.quote ? `"${input.quote.replace(/\s+/g, ' ').slice(0, 300)}"` : null].filter(Boolean).join(', ');
  return `About the Shape board "${loaded.shape.title}" (${loaded.shape.id}, v${input.v}${where ? `, ${where}` : ''}): ${input.text}\n\nAnswer in one or two sentences. If it needs a change to the board, draw it as a new version.`;
}

export function shapeChangePrompt(loaded: { shape: { id: string; title: string } }): string {
  return `The person left changes on the Shape board "${loaded.shape.title}" (${loaded.shape.id}). Run \`plannotator shape read ${loaded.shape.id} --notes\` and draw them as a new version. Then say what changed in one sentence.`;
}

async function readAnswer(response: Response, onText: (text: string) => void): Promise<string> {
  if (!response.ok || !response.body) throw new Error(`Ask failed (HTTP ${response.status}).`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let msg: { type?: string; delta?: string; text?: string; error?: string; message?: string };
      try {
        msg = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (msg.type === 'text_delta' && typeof msg.delta === 'string') text += msg.delta;
      else if (msg.type === 'text' && typeof msg.text === 'string') text = msg.text;
      else if (msg.type === 'error') throw new Error(msg.error ?? msg.message ?? 'The session could not answer.');
      else continue;
      onText(text);
    }
  }
  return text.trim();
}

const BUSY_RETRY_MS = 5_000;

export function createInboxShapeHost(options: InboxShapeHostOptions): ShapeHost {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const last = new Map<string, ShapeLoadedWire>();

  const load = async (id: string): Promise<ShapeLoadedWire> => {
    const loaded = await inboxApi.shape(id);
    last.set(id, loaded);
    return loaded;
  };

  const askSession = async (loaded: ShapeLoadedWire, prompt: string, onText: (text: string) => void, busyPolicy?: 'wait', onBusy?: () => void, known?: InboxAskModel): Promise<{ text: string; provider: string } | null> => {
    const thread = loaded.shape.thread;
    if (!thread || loaded.session.state === 'gone') return null;
    try {
      const model = known ?? (await readAsk(thread));
      if (!model.can_ask) return null;
      const posted = await inboxApi.askSend(thread, generateId('ask'), prompt);
      if (!posted.provider_id) return null;
      const session = await doFetch('/api/ai/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: ASK_CONTEXT, providerId: posted.provider_id }),
      });
      if (!session.ok) return null;
      const { sessionId } = (await session.json()) as { sessionId: string };
      const answer = await readAnswer(
        await doFetch('/api/ai/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, prompt, ...(busyPolicy ? { busyPolicy } : {}) }) }),
        onText,
      );
      return answer ? { text: answer, provider: posted.provider_id } : null;
    } catch (cause) {
      if (cause instanceof InboxApiError && cause.code === 'ask_busy') onBusy?.();
      return null;
    }
  };

  /** A refused Change it is never retried straight away (a refusal changes nothing, so that would loop): it waits for the Ask's next news or a pause. */
  const waking = new Map<string, boolean>();
  const untilFree = new Set<string>();
  const wakeWhenFree = (id: string, thread: string) => {
    if (untilFree.has(id)) return;
    untilFree.add(id);
    let looking = false;
    const look = () => {
      if (looking) return;
      looking = true;
      readAsk(thread).then(
        (model) => {
          looking = false;
          if (model.running || !untilFree.delete(id)) return;
          clearInterval(pause);
          stop();
          void wake(id, model);
        },
        () => {
          looking = false;
        },
      );
    };
    const stop = onAskChange(look);
    const pause = setInterval(look, options.busyRetryMs ?? BUSY_RETRY_MS);
    (pause as { unref?: () => void }).unref?.();
  };
  const wake = async (id: string, known?: InboxAskModel): Promise<void> => {
    if (waking.has(id)) {
      waking.set(id, true);
      return;
    }
    waking.set(id, false);
    try {
      const loaded = await load(id);
      if (loaded.notes.some(shapeNoteWaits)) {
        await askSession(
          loaded,
          shapeChangePrompt(loaded),
          () => {},
          'wait',
          () => {
            if (loaded.shape.thread) wakeWhenFree(id, loaded.shape.thread);
          },
          known,
        );
      }
    } catch {
    } finally {
      const again = waking.get(id);
      waking.delete(id);
      if (again) void wake(id);
    }
  };

  return {
    async load(id): Promise<ShapeLoaded> {
      const loaded = await load(id);
      return { shape: loaded.shape, version: loaded.version, seen: loaded.seen, notes: loaded.notes, session: loaded.session };
    },
    async version(id, n): Promise<ShapeVersion | null> {
      try {
        return (await inboxApi.shape(id, n)).version;
      } catch {
        return null;
      }
    },
    async note(id, input): Promise<ShapeNote> {
      const note = (await inboxApi.shapeNote(id, { ...input })).note;
      if (input.kind === 'change' && options.wakeOnChange?.()) void wake(id);
      return note;
    },
    async ask(id, input, onText) {
      const question = (await inboxApi.shapeNote(id, { ...input, kind: 'ask' })).note;
      const loaded = last.get(id) ?? (await load(id));
      const answered = await askSession(loaded, shapeAskPrompt(loaded, input), onText);
      if (!answered) return { question, answer: null };
      const answer = (await inboxApi.shapeAnswer(id, { re: question.id, text: answered.text, from: { host: 'inbox-ask', id: answered.provider } })).note;
      return { question, answer };
    },
    seen(id, n) {
      void inboxApi.shapeSeen(id, n).catch(() => {});
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
        return (await inboxApi.shapeCodeFile(id, path)).content;
      } catch {
        return null;
      }
    },
    async codeHover(id, request) {
      try {
        return await inboxApi.shapeCodeHover(id, { ...request });
      } catch {
        return null;
      }
    },
    assetUrl: inboxApi.shapeFileUrl,
    resumePrompt(id) {
      return `${options.command || 'plannotator'} shape read ${id} --notes`;
    },
    async copy(text) {
      await copyTextToClipboard(text);
    },
    ...(options.openIn ? { fileAction: (id: string, file: { path: string; line?: number }) => createElement(OpenInFile, { scope: { shape: id }, path: file.path, line: file.line }) } : {}),
    askWaitsWhenEnded: true,
  };
}
