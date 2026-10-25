/**
 * A thread as a Messages conversation: a floating header with the agent as the
 * contact, a dismissible banner when the agent is stopped on the person, the
 * bubbles, a delivery line under the person's last message, and the composer.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@halftone/design-system/primitives/button/button';
import { Tooltip } from '@halftone/design-system/primitives/tooltip';
import { Text } from '@halftone/design-system/typography/text';
import { Caption } from '@halftone/design-system/typography/caption';
import { inboxApi } from '@inbox/api';
import { clockTime, dayWords } from '@inbox/format';
import { rowDeliveryLine } from '@inbox/rowDelivery';
import { inboxAgentName, isInboxNote, type InboxMessageWire, type InboxThread } from '@plannotator/core/inbox-types';
import { MessageRun } from './Bubbles';
import { Composer } from './Composer';
import { AgentAvatar, Glyph } from './marks';
import { lastReal, type Row } from './data';

const GAP_MS = 15 * 60 * 1000;

function senderKey(m: InboxMessageWire): string {
  return m.author.kind === 'person' ? 'me' : `${m.author.host}|${m.author.session}`;
}

function TimeLabel({ iso }: { iso: string }) {
  const day = dayWords(iso);
  return (
    <div className="my-3 text-center">
      <Caption color="tertiary" size="lg" weight="medium">
        {day.charAt(0).toUpperCase() + day.slice(1)} {clockTime(iso)}
      </Caption>
    </div>
  );
}

function ActionButton({ label, icon, onClick, disabled }: { label: string; icon: 'archive' | 'check' | 'back'; onClick: () => void; disabled?: boolean }) {
  return (
    <Tooltip>
      <Tooltip.Trigger
        render={
          <Button variant="secondary" shape="pill" icon="only" size="md" aria-label={label} onClick={onClick} disabled={disabled} className="shadow-default">
            <Glyph name={icon} size={16} />
          </Button>
        }
      />
      <Tooltip.Content side="bottom">{label}</Tooltip.Content>
    </Tooltip>
  );
}

export function ThreadView({ threadId, row, phone, onBack, onChanged, unreadElsewhere }: { threadId: string; row: Row | null; phone: boolean; onBack: () => void; onChanged: () => void; unreadElsewhere: number }) {
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState(true);
  const [image, setImage] = useState<{ src: string; alt: string } | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const looked = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const model = await inboxApi.thread(threadId);
      setThread(model.thread);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [threadId]);

  useEffect(() => {
    setThread(null);
    setBanner(true);
    void load();
  }, [load]);

  // Re-read when the list moves (the event stream), so the open thread stays live.
  useEffect(() => {
    if (thread) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.last_at, row?.message_count, row?.questions.picked, row?.ack?.at, row?.delivery?.state]);

  // Opening the thread is a look, capped at the newest agent message on screen.
  useEffect(() => {
    if (!thread || looked.current === thread.thread_id) return;
    looked.current = thread.thread_id;
    const through = Math.max(0, ...thread.messages.filter((m) => m.author.kind === 'agent').map((m) => m.seq ?? 0));
    inboxApi.seen(thread.thread_id, through || null).then(onChanged, () => {});
  }, [thread, onChanged]);

  // Messages opens at the newest message and stays there while pictures load,
  // unless the person scrolled up.
  const stick = useRef(true);
  const content = useRef<HTMLDivElement | null>(null);
  // The header floats; the bubbles start under it, whatever its height (the banner comes and goes).
  const header = useRef<HTMLElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(128);
  useLayoutEffect(() => {
    const el = header.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeaderHeight(el.offsetHeight));
    observer.observe(el);
    setHeaderHeight(el.offsetHeight);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [thread?.thread_id, thread?.messages.length]);
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', onScroll);
    };
  }, [thread !== null]);

  const refresh = useCallback(() => {
    void load();
    onChanged();
  }, [load, onChanged]);

  const messages = useMemo(() => (thread ? thread.messages.filter((m) => !isInboxNote(m)) : []), [thread]);
  const agents = useMemo(() => new Set(messages.filter((m) => m.author.kind === 'agent').map(senderKey)), [messages]);
  const lead = messages.find((m) => m.author.kind === 'agent') ?? null;
  const live = messages.flatMap((m) => (m.questions ?? []).filter((q) => (q.state === 'open' || q.state === 'picked') && q.kind !== 'action'));
  const stopped = live.find((q) => q.stopped);
  const holding = live.filter((q) => q.holds_up.length > 0);
  const last = thread ? lastReal(thread.messages) : undefined;
  const latestAgent = [...messages].reverse().find((m) => m.author.kind === 'agent');
  const canAck = Boolean(latestAgent && last?.id === latestAgent.id && live.length === 0 && !thread?.resolved_at);

  const ack = async (id: string, on: boolean) => {
    try {
      await inboxApi.ack(id, on);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const jump = (messageId: string, key: string) => {
    const card = document.getElementById(`q-${messageId}-${key}`);
    card?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    card?.animate?.([{ boxShadow: '0 0 0 3px var(--color-brand-border-focus)' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 1200 });
  };

  const deliveryLine = (() => {
    if (!row || !last || last.author.kind !== 'person') return null;
    if (row.sent?.checked_at) return `Read ${clockTime(row.sent.checked_at)}`;
    if (row.delivery) return rowDeliveryLine(row.delivery, clockTime);
    return 'Sent';
  })();

  const focus = stopped ?? holding[0] ?? null;
  const showBanner = banner && focus !== null;
  const name = thread?.subject ?? row?.subject ?? 'Thread';
  const agentName = lead ? inboxAgentName(lead.author) : 'Agent';

  return (
    <section className={`relative flex h-full min-w-0 flex-1 flex-col ${phone ? 'push-enter bg-container' : ''}`} aria-label={name}>
      {/* The floating header: the agent is the contact, the thread its name. */}
      <header ref={header} className="pointer-events-none absolute inset-x-0 top-0 z-30 px-3 pt-3 pb-2">
        <div aria-hidden className={`proto-header-veil absolute inset-0 ${phone ? 'bg-container/95' : 'bg-container-recessed/90'} backdrop-blur-xl`} />
        <div className="relative flex items-start justify-between gap-2">
        <div className="pointer-events-auto flex min-w-[2.5rem] items-center">
          {phone && (
            <Button variant="transparent" shape="pill" size="md" onClick={onBack} aria-label="Back to the list" className="gap-0.5 text-brand-foreground">
              <Glyph name="chevL" size={20} />
              {unreadElsewhere > 0 && <span className="rounded-full bg-brand-solid px-1.5 text-caption-lg text-on-brand-solid-foreground">{unreadElsewhere}</span>}
            </Button>
          )}
        </div>
        <div className="pointer-events-auto flex min-w-0 flex-col items-center">
          {lead && <AgentAvatar author={lead.author} size={phone ? '2xl' : '3xl'} />}
          <div className="mt-1 flex max-w-[min(32rem,70vw)] items-center gap-1 rounded-full bg-container/80 px-3 py-1 shadow-default backdrop-blur-md">
            <Text size="sm" weight="semibold" truncate>
              {name}
            </Text>
            <Glyph name="chevR" size={12} className="shrink-0 text-tertiary-foreground" />
          </div>
          <Caption color="tertiary" size="lg" className="mt-0.5 truncate">
            {agentName}
            {agents.size > 1 ? ` + ${agents.size - 1} more` : ''} · {thread?.project.name ?? row?.project.name}
            {thread?.thread_name ? ` · ${thread.thread_name}` : ''}
          </Caption>
        </div>
        <div className="pointer-events-auto flex items-center gap-1.5">
          {row?.unread && <ActionButton label="Mark read" icon="check" onClick={() => void inboxApi.markRead(threadId, true).then(refresh)} />}
          {lead && !thread?.resolved_at && <ActionButton label="Archive" icon="archive" onClick={() => void inboxApi.resolve(lead.id, true).then(refresh)} />}
        </div>
        </div>
        {/* The dismissible banner: what this thread is holding up, where Messages puts its contact banner. */}
        {showBanner && (
          <div className="pointer-events-auto relative mt-2 flex items-center gap-3 rounded-2xl border border-border-default bg-modal px-3 py-2.5 shadow-default" role="status" data-banner>
            <span className={`flex size-9 shrink-0 items-center justify-center rounded-full ${stopped ? 'bg-danger-subtle text-danger-foreground' : 'bg-warning-subtle text-warning-foreground'}`}>
              <Glyph name={stopped ? 'excl' : 'clock'} size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <Text size="sm" weight="medium" truncate>
                {stopped ? `${agentName} is stopped on you` : `${agentName} is holding up ${holding.reduce((n, q) => n + q.holds_up.length, 0)} pieces of work`}
              </Text>
              <Caption color="secondary" size="lg" className="truncate">
                {focus!.state === 'picked' ? 'Your answer is in the draft below. Send it to let it go on.' : stopped ? stopped.stopped : holding.flatMap((q) => q.holds_up).join(' · ')}
              </Caption>
            </div>
            <Button variant="brand" shape="pill" size="sm" onClick={() => jump(focus!.message_id, focus!.key)}>
              {focus!.state === 'picked' ? 'Review' : 'Answer'}
            </Button>
            <Button variant="transparent" shape="pill" icon="only" size="sm" aria-label="Dismiss" onClick={() => setBanner(false)}>
              <Glyph name="x" size={14} />
            </Button>
          </div>
        )}
      </header>

      <div ref={scroller} className="flex-1 overflow-y-auto px-4 pb-4" style={{ paddingTop: headerHeight + 8 }} data-thread-scroll>
        <div ref={content}>
        {error && (
          <Caption color="danger" size="lg">
            {error}
          </Caption>
        )}
        {!thread && !error && <Caption color="tertiary">Opening…</Caption>}
        <div className="mx-auto flex max-w-[56rem] flex-col">
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const next = messages[i + 1];
            const gap = !prev || new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() > GAP_MS;
            const sameAsPrev = prev && !gap && senderKey(prev) === senderKey(m);
            const sameAsNext = next && senderKey(next) === senderKey(m) && new Date(next.created_at).getTime() - new Date(m.created_at).getTime() <= GAP_MS;
            return (
              <div key={m.id} className={sameAsPrev ? 'mt-1' : 'mt-3'}>
                {gap && <TimeLabel iso={m.created_at} />}
                <MessageRun
                  message={m}
                  thread={thread!}
                  tailOnLast={!sameAsNext}
                  showName={agents.size > 1 && !sameAsPrev}
                  onChanged={refresh}
                  onOpenImage={(src, alt) => setImage({ src, alt })}
                  canAck={canAck && m.id === latestAgent?.id}
                  onAck={(on) => void ack(m.id, on)}
                />
              </div>
            );
          })}
          {deliveryLine && (
            <div className="mt-1 me-1 text-end" data-delivery-line>
              <Caption color="tertiary" size="lg" weight="medium">
                {deliveryLine}
              </Caption>
            </div>
          )}
          {thread?.resolved_at && (
            <div className="mt-4 text-center">
              <Caption color="tertiary" size="lg">
                Archived. The next message from {agentName} starts a new conversation.
              </Caption>
            </div>
          )}
        </div>
        </div>
      </div>

      {thread && !thread.resolved_at && <Composer thread={thread} onSent={refresh} compact={phone} />}

      {image && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          role="dialog"
          aria-label={image.alt || 'Picture'}
          onClick={() => setImage(null)}
          onKeyDown={(e) => e.key === 'Escape' && setImage(null)}
          tabIndex={-1}
          ref={(el) => el?.focus()}
        >
          <img src={image.src} alt={image.alt} className="max-h-full max-w-full rounded-xl" />
        </div>
      )}
    </section>
  );
}
