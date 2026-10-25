/**
 * The Messages-style Inbox (prototype). Desktop: the list in Halftone's shell
 * colour on the left, the conversation in a rounded floating pane. Phone: the
 * list, and a thread pushed over it. The route is the hash (`#thread=…`), as
 * in the real window.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Caption } from '@halftone/design-system/typography/caption';
import { Text } from '@halftone/design-system/typography/text';
import { ConversationList } from './List';
import { ThreadView } from './Thread';
import { flatRows, useInbox, useMediaQuery, useTheme, useThreads } from './data';
import { Glyph } from './marks';

function readHash(): string | null {
  const m = location.hash.match(/thread=([^&]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

export function App() {
  const { list, settings, error, reload, tick } = useInbox();
  const { mode, setMode } = useTheme(settings);
  const phone = useMediaQuery('(max-width: 767px)');
  const [selected, setSelected] = useState<string | null>(readHash);
  const rows = useMemo(() => flatRows(list), [list]);
  const threads = useThreads(rows, tick);

  useEffect(() => {
    const on = () => setSelected(readHash());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);

  // A desktop always shows a conversation: the first that waits on the person.
  useEffect(() => {
    if (phone || selected || rows.length === 0) return;
    setSelected(rows[0]!.thread_id);
  }, [phone, selected, rows]);

  const open = useCallback((id: string) => {
    history.pushState(null, '', `#thread=${encodeURIComponent(id)}`);
    setSelected(id);
  }, []);
  const back = useCallback(() => {
    if (history.state === null && location.hash) history.back();
    else {
      history.pushState(null, '', location.pathname + location.search);
      setSelected(null);
    }
  }, []);

  const row = rows.find((r) => r.thread_id === selected) ?? null;
  const unreadElsewhere = rows.filter((r) => r.unread && r.thread_id !== selected).length;

  if (error && !list) {
    return (
      <div className="flex h-full items-center justify-center bg-shell">
        <Text color="danger">The Inbox did not answer: {error}</Text>
      </div>
    );
  }

  const thread = selected ? (
    <ThreadView key={selected} threadId={selected} row={row} phone={phone} onBack={back} onChanged={reload} unreadElsewhere={unreadElsewhere} />
  ) : (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-tertiary-foreground">
      <Glyph name="inbox" size={28} />
      <Caption color="tertiary">No conversation selected</Caption>
    </div>
  );

  if (phone) {
    return <div className="h-dvh bg-container">{selected ? thread : <ConversationList list={list} threads={threads} selectedId={null} onOpen={open} phone mode={mode} onMode={setMode} />}</div>;
  }

  return (
    <div className="flex h-dvh bg-shell" data-proto="imessage">
      <aside className="w-[340px] shrink-0 border-e border-transparent">
        <ConversationList list={list} threads={threads} selectedId={selected} onOpen={open} phone={false} mode={mode} onMode={setMode} />
      </aside>
      <main className="my-1.5 me-1.5 flex min-w-0 flex-1 overflow-hidden rounded-3xl bg-container-recessed shadow-default dark:border-[0.5px] dark:border-border-default dark:shadow-none">{thread}</main>
    </div>
  );
}
