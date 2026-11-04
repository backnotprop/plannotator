/**
 * The Inbox's ShapeHost (packages/ui/components/shape/types.ts): the board's
 * reads and writes go to this Inbox's Shape routes (packages/server/shape-routes.ts).
 *
 * - Ask: to the session that drew the board, through the thread's Ask (the
 *   Inbox's "Ask this session", inbox-ask-live.ts), streamed into the board
 *   and stored as the answer. When no session can answer (it ended, or the
 *   Inbox's Ask is off), the question is stored and waits: the agent answers it
 *   with `plannotator shape answer` when it next reads its notes.
 * - Change it: stored; it waits until the agent's `shape read --notes` picks
 *   it up, and the event feed clears "waits for the agent" then.
 * - Files and hover: the shape's project folder, through code-nav.
 * - Copy prompt: the command any session runs to pick up what waits.
 */
import type { ShapeNote, ShapeNoteInput, ShapeVersion } from '@plannotator/core/shape';
import type { ShapeEvent, ShapeHost, ShapeLoaded, ShapeSessionStatus } from '@plannotator/ui/components/shape';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { generateId } from '@plannotator/ui/utils/generateId';
import { inboxApi, type ShapeLoadedWire } from '../api';

const ASK_CONTEXT = { mode: 'annotate', annotate: { filePath: '', content: '' } } as const;

export interface InboxShapeHostOptions {
  /** Every change the event feed names (an empty list: read everything again). Returns the unsubscribe. */
  subscribe: (listener: (ids: string[]) => void) => () => void;
  /** The `plannotator` command this Inbox's agents run (Copy prompt), else `plannotator`. */
  command?: string | null;
  /** The fetch the Ask stream uses (tests). */
  fetch?: typeof fetch;
}

/** The words the session gets for a question on a board. */
export function shapeAskPrompt(loaded: { shape: { id: string; title: string }; version: { n: number } }, input: ShapeNoteInput): string {
  const where = [input.view ? `the ${input.view} view` : null, input.quote ? `"${input.quote.replace(/\s+/g, ' ').slice(0, 300)}"` : null].filter(Boolean).join(', ');
  return `About the Shape board "${loaded.shape.title}" (${loaded.shape.id}, v${input.v}${where ? `, ${where}` : ''}): ${input.text}\n\nAnswer in one or two sentences. If it needs a change to the board, draw it as a new version.`;
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

export function createInboxShapeHost(options: InboxShapeHostOptions): ShapeHost {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const last = new Map<string, ShapeLoadedWire>();

  const load = async (id: string): Promise<ShapeLoadedWire> => {
    const loaded = await inboxApi.shape(id);
    last.set(id, loaded);
    return loaded;
  };

  /** Through the thread's Ask to the live session; null when none can answer now. */
  const askSession = async (loaded: ShapeLoadedWire, input: ShapeNoteInput, onText: (text: string) => void): Promise<{ text: string; provider: string } | null> => {
    const thread = loaded.shape.thread;
    if (!thread || loaded.session.state === 'gone') return null;
    try {
      const model = await inboxApi.askRead(thread);
      if (!model.can_ask) return null;
      const posted = await inboxApi.askSend(thread, generateId('ask'), shapeAskPrompt(loaded, input));
      if (!posted.provider_id) return null;
      const session = await doFetch('/api/ai/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: ASK_CONTEXT, providerId: posted.provider_id }),
      });
      if (!session.ok) return null;
      const { sessionId } = (await session.json()) as { sessionId: string };
      const answer = await readAnswer(
        await doFetch('/api/ai/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, prompt: shapeAskPrompt(loaded, input) }) }),
        onText,
      );
      return answer ? { text: answer, provider: posted.provider_id } : null;
    } catch {
      // The Ask is off in this Inbox (404), or the session went away mid-answer: the question waits instead.
      return null;
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
      return (await inboxApi.shapeNote(id, { ...input })).note;
    },
    async ask(id, input, onText) {
      const question = (await inboxApi.shapeNote(id, { ...input, kind: 'ask' })).note;
      const loaded = last.get(id) ?? (await load(id));
      const answered = await askSession(loaded, input, onText);
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
    assetUrl(id, src) {
      const name = src.replace(/^files\//, '');
      return `/api/shapes/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`;
    },
    resumePrompt(id) {
      return `${options.command || 'plannotator'} shape read ${id} --notes`;
    },
    async copy(text) {
      await copyTextToClipboard(text);
    },
  };
}

/** What changed between two reads of a board, as the board's events. */
export function shapeEventsBetween(before: ShapeLoadedWire | null, now: ShapeLoadedWire): ShapeEvent[] {
  const out: ShapeEvent[] = [];
  if (!before) return out;
  if (now.version.n !== before.version.n) out.push({ type: 'version', shape: now.shape, version: now.version });
  const wasDrawing = before.shape.drawing?.until ?? null;
  const drawing = now.shape.drawing?.until ?? null;
  if (drawing !== wasDrawing && now.version.n === before.version.n) out.push({ type: 'drawing', until: drawing });
  if (now.shape.state !== before.shape.state) out.push({ type: 'state', shape: now.shape });
  const old = new Map(before.notes.map((n) => [n.id, n]));
  for (const note of now.notes) {
    const was = old.get(note.id);
    if (!was || was.delivered !== note.delivered || was.text !== note.text) out.push({ type: 'note', note });
  }
  if (now.session.state !== before.session.state || now.session.agent !== before.session.agent) out.push({ type: 'session', session: now.session as ShapeSessionStatus });
  return out;
}
