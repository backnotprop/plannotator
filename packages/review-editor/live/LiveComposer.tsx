import { useId, useMemo, useRef, useState } from 'react';
import { useMentionAutocomplete } from '@plannotator/ui/hooks/useMentionAutocomplete';
import { MentionAutocompleteMenu, mentionActiveOptionId } from '@plannotator/ui/components/MentionAutocomplete';
import type { MentionSource } from '@plannotator/ui/utils/mentions';
import type { LiveSendTag } from './api';
import { agentLabel, type LiveAgent } from './model';

export function liveMentionSource(agents: readonly LiveAgent[]): MentionSource {
  return {
    people: agents.map((agent) => ({ id: `${agent.host}:${agent.session}`, kind: 'agent' as const, label: agentLabel(agent), detail: agent.here ? null : agent.project, canOpen: true })),
    kinds: ['agent'],
    emptyNotice: 'No agent is connected to the Inbox.',
    heading: 'Agents',
  };
}

export function tagsOf(ids: readonly string[], agents: readonly LiveAgent[]): LiveSendTag[] {
  return ids.flatMap((id) => {
    const agent = agents.find((a) => `${a.host}:${a.session}` === id);
    return agent ? [{ host: agent.host, session: agent.session, label: agentLabel(agent) }] : [];
  });
}

export function LiveComposer(props: {
  agents: readonly LiveAgent[];
  placeholder: string;
  sendLabel: string;
  allowEmpty?: boolean;
  onFocus?: () => void;
  onSend: (words: string, tags: LiveSendTag[]) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const listbox = useId();
  const source = useMemo(() => liveMentionSource(props.agents), [props.agents]);
  const mention = useMentionAutocomplete({ text, setText, textareaRef: ref, source });
  const canSend = !busy && (props.allowEmpty || text.trim() !== '');
  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      await props.onSend(text.trim(), tagsOf(mention.mentionIds, props.agents));
      setText('');
    } catch {
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="live-composer flex flex-col gap-1.5" data-live-composer>
      <textarea
        ref={ref}
        rows={2}
        value={text}
        placeholder={props.placeholder}
        aria-controls={mention.menu ? listbox : undefined}
        aria-activedescendant={mentionActiveOptionId(listbox, mention.menu)}
        className="w-full resize-y rounded border border-border bg-background px-2 py-1.5 text-[13px] leading-5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        onFocus={props.onFocus}
        onChange={(e) => {
          setText(e.target.value);
          mention.onSelect();
        }}
        onSelect={mention.onSelect}
        onKeyDown={(e) => {
          if (mention.onKeyDown(e)) return;
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <MentionAutocompleteMenu id={listbox} menu={mention.menu} onSelect={mention.select} />
      <div className="flex items-center justify-end">
        <button
          type="button"
          disabled={!canSend}
          onClick={() => void send()}
          className="h-7 rounded px-2.5 text-[12px] font-medium bg-primary text-primary-foreground disabled:opacity-40"
        >
          {busy ? 'Sending…' : props.sendLabel}
        </button>
      </div>
    </div>
  );
}
