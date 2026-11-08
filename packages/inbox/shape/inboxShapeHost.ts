/**
 * The Inbox's ShapeHost (packages/ui/components/shape/types.ts): the board's
 * reads and writes go to this Inbox's Shape routes (packages/server/shape-routes.ts).
 *
 * - Ask: to the session that drew the board, through the thread's Ask (the
 *   Inbox's "Ask this session", inbox-ask-live.ts), streamed into the board
 *   and stored as the answer. When no session can answer (it ended, or the
 *   Inbox is an older one with Ask off), the question is stored and waits: the agent answers it
 *   with `plannotator shape answer` when it next reads its notes.
 * - Change it: stored; it waits until the agent's `shape read --notes` picks
 *   it up, and the event feed clears "waits for the agent" then. With
 *   `wakeOnChange` (Code review on), it also asks the live session to pick it
 *   up now, through the same Ask, so the redraw comes while the person looks.
 * - Files and hover: the shape's project folder, through code-nav.
 * - Copy prompt: the command any session runs to pick up what waits.
 * - Open in: with Code review on, a referenced file gets the window's Open in
 *   (components/OpenIn.tsx), by the shape's id: the server holds the path to its project.
 */
import { createElement } from 'react';
import { shapeNoteWaits, type ShapeNote, type ShapeNoteInput, type ShapeVersion } from '@plannotator/core/shape';
import type { ShapeHost, ShapeLoaded } from '@plannotator/ui/components/shape';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { generateId } from '@plannotator/ui/utils/generateId';
import { InboxApiError, inboxApi, type ShapeLoadedWire } from '../api';
import { onAskChange } from '../ask/askEvents';
import { OpenInFile } from '../components/OpenIn';
import { shapeEventsBetween } from './events';

export { shapeEventsBetween };

const ASK_CONTEXT = { mode: 'annotate', annotate: { filePath: '', content: '' } } as const;

export interface InboxShapeHostOptions {
  /** Every change the event feed names (an empty list: read everything again). Returns the unsubscribe. */
  subscribe: (listener: (ids: string[]) => void) => () => void;
  /** The `plannotator` command this Inbox's agents run (Copy prompt), else `plannotator`. */
  command?: string | null;
  /** A Change it wakes the thread's live session (Code review on). Absent: it waits for the agent's next turn. */
  wakeOnChange?: () => boolean;
  /** How long a refused Change it waits for news before it tries again (`BUSY_RETRY_MS`). */
  busyRetryMs?: number;
  /** The fetch the Ask stream uses (tests). */
  fetch?: typeof fetch;
  /** Offer Open in on a board's file references and code (Settings → Capabilities → Code review). */
  openIn?: boolean;
}

/** The words the session gets for a question on a board. */
export function shapeAskPrompt(loaded: { shape: { id: string; title: string }; version: { n: number } }, input: ShapeNoteInput): string {
  const where = [input.view ? `the ${input.view} view` : null, input.quote ? `"${input.quote.replace(/\s+/g, ' ').slice(0, 300)}"` : null].filter(Boolean).join(', ');
  return `About the Shape board "${loaded.shape.title}" (${loaded.shape.id}, v${input.v}${where ? `, ${where}` : ''}): ${input.text}\n\nAnswer in one or two sentences. If it needs a change to the board, draw it as a new version.`;
}

/** The words that wake the session for a Change it: only the command, as the notes themselves say the rest. */
export function shapeChangePrompt(loaded: { shape: { id: string; title: string } }): string {
  return `The person left changes on the Shape board "${loaded.shape.title}" (${loaded.shape.id}). Run \`plannotator shape read ${loaded.shape.id} --notes\` and draw them as a new version. Then say what changed in one sentence.`;
}

/** Read an Ask stream (`/api/ai/query`): the answer's text so far, to `onText`; the whole answer at the end. */
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

/** How long a refused Change it waits for news before it tries again. */
const BUSY_RETRY_MS = 5_000;

export function createInboxShapeHost(options: InboxShapeHostOptions): ShapeHost {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const last = new Map<string, ShapeLoadedWire>();

  const load = async (id: string): Promise<ShapeLoadedWire> => {
    const loaded = await inboxApi.shape(id);
    last.set(id, loaded);
    return loaded;
  };

  /** Through the thread's Ask to the live session; null when none can answer now. */
  const askSession = async (loaded: ShapeLoadedWire, prompt: string, onText: (text: string) => void, busyPolicy?: 'wait', onBusy?: () => void): Promise<{ text: string; provider: string } | null> => {
    const thread = loaded.shape.thread;
    if (!thread || loaded.session.state === 'gone') return null;
    try {
      const model = await inboxApi.askRead(thread);
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
      // An older Inbox with Ask off (404), or the session went away mid-answer: the question waits instead.
      return null;
    }
  };

  /**
   * A Change it wakes the session once; one that comes while it is being woken wakes it once more, after, if the
   * agent has not read it by then. Refused because a turn holds the session (this thread's, or another thread's,
   * which this thread's read can't see): it tries again at the Ask's next news from any thread, or after a pause
   * if none comes. Never straight away: a refusal changes nothing, so a retry at once is a loop.
   */
  const waking = new Map<string, boolean>();
  const untilFree = new Set<string>();
  const wakeWhenFree = (id: string, thread: string) => {
    if (untilFree.has(id)) return;
    untilFree.add(id);
    let looking = false;
    const look = () => {
      if (looking) return;
      looking = true;
      inboxApi.askRead(thread).then(
        (model) => {
          looking = false;
          if (model.running || !untilFree.delete(id)) return;
          clearInterval(pause);
          stop();
          void wake(id);
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
  const wake = async (id: string): Promise<void> => {
    if (waking.has(id)) {
      waking.set(id, true);
      return;
    }
    waking.set(id, false);
    try {
      const loaded = await load(id);
      if (loaded.notes.some(shapeNoteWaits)) {
        await askSession(loaded, shapeChangePrompt(loaded), () => {}, 'wait', () => {
          if (loaded.shape.thread) wakeWhenFree(id, loaded.shape.thread);
        });
      }
    } catch {
      // Not woken: the note waits for the agent's next turn, as it always may.
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
    // No Ask AI fallback here: with the session gone, a question waits for the agent's `shape answer`.
    askWaitsWhenEnded: true,
  };
}
