/**
 * The Messages pill composer. Picks made on the cards ride above it as
 * chips (Messages' attachment tray); Send is one reply per agent session,
 * the real Send's routing (sendTargetsOf).
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@halftone/design-system/primitives/button/button';
import { Tooltip } from '@halftone/design-system/primitives/tooltip';
import { Caption } from '@halftone/design-system/typography/caption';
import { inboxApi } from '@inbox/api';
import { answerWords } from '@inbox/folding';
import { sendTargetsOf } from '@inbox/sendTargets';
import { inboxAgentName, type InboxQuestion, type InboxThread } from '@plannotator/core/inbox-types';
import { Glyph } from './marks';

function newKey(): string {
  return `proto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function Composer({ thread, onSent, compact }: { thread: InboxThread; onSent: () => void; compact: boolean }) {
  const [words, setWords] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);

  const live = thread.messages.filter((m) => m.author.kind === 'agent' && !thread.resolved_at);
  const picks: InboxQuestion[] = live.flatMap((m) => (m.questions ?? []).filter((q) => q.state === 'picked' && q.kind !== 'action'));
  const open = live.flatMap((m) => (m.questions ?? []).filter((q) => q.state === 'open' && q.kind !== 'action'));
  const latest = [...thread.messages].reverse().find((m) => m.author.kind === 'agent');
  const to = latest ? inboxAgentName(latest.author) : 'the agent';
  const canSend = !busy && (words.trim().length > 0 || picks.length > 0) && Boolean(latest);

  useEffect(() => {
    setWords('');
    setError(null);
  }, [thread.thread_id]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [words]);

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      const targets = sendTargetsOf(thread);
      for (let i = 0; i < targets.length; i += 1) {
        const target = targets[i]!;
        const last = i === targets.length - 1;
        if (!last && target.questions.length === 0) continue;
        await inboxApi.reply(target.message.id, { idempotency_key: newKey(), words: last ? words.trim() : '', questions: target.questions, skip: target.skip });
      }
      setWords('');
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const unpick = async (q: InboxQuestion) => {
    try {
      await inboxApi.pick(q.message_id, q.key, q.revision, null);
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className={`shrink-0 ${compact ? 'px-2 pb-[max(env(safe-area-inset-bottom),8px)]' : 'px-4 pb-4'}`} data-composer>
      {(picks.length > 0 || open.length > 0) && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 ps-12" aria-label="Riding along with your next message">
          {picks.map((q) => (
            <span key={`${q.message_id}/${q.key}`} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-brand-border-subtle bg-brand-subtle py-1 ps-2.5 pe-1 text-caption-lg text-on-brand-subtle-foreground" data-pick-chip>
              <Glyph name="check" size={12} />
              <span className="truncate">
                <b className="font-medium">{q.answer ? answerWords(q.answer) : ''}</b> <span className="opacity-75">· {q.prompt.replace(/[?.:]+$/, '')}</span>
              </span>
              <button type="button" className="flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-brand-subtle-hover" aria-label={`Remove the pick on “${q.prompt}”`} onClick={() => void unpick(q)}>
                <Glyph name="x" size={11} />
              </button>
            </span>
          ))}
          {open.length > 0 && (
            <Caption color="tertiary" size="lg">
              {open.length === 1 ? '1 question stays open' : `${open.length} questions stay open`}
            </Caption>
          )}
        </div>
      )}
      <div className="flex items-end gap-2">
        <Tooltip>
          <Tooltip.Trigger
            render={
              <Button variant="tertiary" shape="pill" icon="only" size="md" aria-label="Attach a file (not in the prototype)" disabled>
                <Glyph name="clip" size={16} />
              </Button>
            }
          />
          <Tooltip.Content side="top">Attach a file</Tooltip.Content>
        </Tooltip>
        <div className="flex min-h-9 flex-1 items-end rounded-[20px] border border-border-strong bg-container ps-3.5 pe-1 focus-within:border-brand-border-focus">
          <textarea
            ref={area}
            rows={1}
            value={words}
            onChange={(e) => setWords(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={picks.length > 0 ? `Add a note to ${to}, or just send` : `Message ${to}`}
            aria-label={`Message ${to}`}
            className="my-[7px] max-h-40 flex-1 resize-none bg-transparent text-body-base text-primary-foreground outline-none placeholder:text-tertiary-foreground"
          />
          <Button
            variant="brand"
            shape="pill"
            icon="only"
            size="sm"
            className={`mb-[3px] transition-opacity ${canSend ? 'opacity-100' : 'opacity-0'}`}
            aria-label={picks.length > 0 ? `Send to ${to} with ${picks.length} answer${picks.length === 1 ? '' : 's'}` : `Send to ${to}`}
            disabled={!canSend}
            pending={busy}
            onClick={() => void send()}
          >
            <Glyph name="arrowUp" size={15} className="[stroke-width:2.2]" />
          </Button>
        </div>
      </div>
      {error && (
        <Caption color="danger" size="lg" className="mt-1 ps-12">
          {error}
        </Caption>
      )}
    </div>
  );
}
