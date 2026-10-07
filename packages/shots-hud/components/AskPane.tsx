/**
 * Ask this session, from the HUD: the question runs as a real turn of the
 * destination session (the same "Ask this session" bridge reviews use), and
 * the answer streams back here. Context chips name the shot (and box) the
 * question is about; asking shares those shots with the session.
 */

import { useEffect, useRef, useState } from 'react';
import { renderChatMarkdown } from '@plannotator/ui/utils/aiChatFormat';
import type { ConnectionView, Shot } from '@plannotator/shared/shots/types';
import { HOST_LONG_LABELS, HOST_LABELS } from '@plannotator/shared/shots/types';
import { AgentMark } from './AgentMark';
import { streamAsk } from '../api';
import { Icon } from '../icons';

export interface AskContext {
  shotId: string;
  shotIndex: number;
  boxId?: string;
  boxN?: number;
}

export interface AskEntry {
  id: string;
  question: string;
  context: AskContext[];
  answer: string;
  tools: string[];
  state: 'streaming' | 'waiting' | 'done' | 'error' | 'busy';
  error?: string;
  note?: string;
}

interface Props {
  entries: AskEntry[];
  setEntries: React.Dispatch<React.SetStateAction<AskEntry[]>>;
  context: AskContext[];
  setContext: (context: AskContext[]) => void;
  destination: ConnectionView | null;
  shots: Shot[];
  /** Make sure the shots named in the chips have their agent copies on disk. */
  prepare: (shotIds: string[]) => Promise<void>;
  onClose: () => void;
}

function toolLabel(name: string): string {
  return name;
}

export function AskPane({ entries, setEntries, context, setContext, destination, prepare, onClose }: Props) {
  const [question, setQuestion] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const running = entries.some((entry) => entry.state === 'streaming' || entry.state === 'waiting');

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const canAsk = !!destination?.live && destination.canAsk;
  const who = destination ? `${HOST_LONG_LABELS[destination.host]}${destination.project ? ` · ${destination.project}` : ''}` : 'No session';

  const run = async (entry: AskEntry, busyPolicy?: 'wait' | 'interrupt') => {
    const update = (patch: Partial<AskEntry> | ((current: AskEntry) => Partial<AskEntry>)) =>
      setEntries((list) => list.map((item) => (item.id === entry.id ? { ...item, ...(typeof patch === 'function' ? patch(item) : patch) } : item)));
    update({ state: busyPolicy === 'wait' ? 'waiting' : 'streaming', error: undefined });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await prepare(entry.context.map((c) => c.shotId));
      await streamAsk(
        {
          question: entry.question,
          shotIds: [...new Set(entry.context.map((c) => c.shotId))],
          boxIds: entry.context.flatMap((c) => (c.boxId ? [c.boxId] : [])),
          ...(busyPolicy ? { busyPolicy } : {}),
          ...(destination ? { host: destination.host, sessionId: destination.sessionId } : {}),
        },
        (message) => {
          switch (message.type) {
            case 'text_delta':
              update((current) => ({ state: 'streaming', answer: current.answer + String(message.delta ?? '') }));
              break;
            case 'tool_use':
              update((current) => ({ tools: [...current.tools, toolLabel(String(message.toolName ?? 'tool'))] }));
              break;
            case 'status':
              update({ state: message.status === 'waiting' ? 'waiting' : 'streaming' });
              break;
            case 'result':
              update((current) => ({ state: 'done', answer: typeof message.result === 'string' && message.result.length >= current.answer.length ? message.result : current.answer }));
              break;
            case 'error':
              if (message.code === 'agent_busy') update({ state: 'busy' });
              else if (message.code === 'session_taken_over') update({ state: 'done', note: String(message.error ?? '') });
              else update({ state: 'error', error: String(message.error ?? 'The session could not answer.') });
              break;
          }
        },
        controller.signal,
      );
      update((current) => (current.state === 'streaming' || current.state === 'waiting' ? { state: 'done' } : {}));
    } catch (error) {
      if (controller.signal.aborted) update({ state: 'done', note: 'Stopped.' });
      else update({ state: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  };

  const submit = () => {
    const text = question.trim();
    if (!text || running || !canAsk) return;
    const entry: AskEntry = { id: crypto.randomUUID(), question: text, context, answer: '', tools: [], state: 'streaming' };
    setEntries((list) => [...list, entry]);
    setQuestion('');
    void run(entry);
  };

  const shared = [...new Set(context.map((c) => c.shotIndex))];
  const host = destination ? HOST_LABELS[destination.host] : 'the session';

  return (
    <div className="drawer" onPointerDown={(e) => e.stopPropagation()}>
      <div className="qa" ref={scrollRef} aria-live="polite">
        {entries.length === 0 && (
          <div className="qa-empty">
            {canAsk ? (
              <span className="ask-hello">
                {destination && <AgentMark host={destination.host} title={destination.title} size={28} />}
                <span>
                  Ask <b>{destination?.project || who}</b>
                  <br />
                  <span className="muted">The session itself answers.</span>
                </span>
              </span>
            ) : (
              'This session can’t answer here.'
            )}
          </div>
        )}
        {entries.map((entry) => (
          <div key={entry.id}>
            <div className="q">{entry.question}</div>
            <div className="a">
              {entry.tools.map((tool, index) => (
                <div className="tool-line" key={index}>
                  <Icon name="check" size={12} />
                  {tool}
                </div>
              ))}
              {entry.answer && renderChatMarkdown(entry.answer)}
              {entry.state === 'streaming' && <span className="caret" />}
              {entry.state === 'waiting' && (
                <div className="busy-line">
                  <span className="spin" /> Waiting for {host} to finish…
                </div>
              )}
              {entry.state === 'busy' && (
                <div className="busy-line">
                  <Icon name="clock" />
                  {host} is working on something else.
                  <button type="button" className="pill-btn" onClick={() => void run(entry, 'wait')}>
                    Ask when it finishes
                  </button>
                  <button type="button" className="pill-btn" onClick={() => void run(entry, 'interrupt')}>
                    Interrupt and ask now
                  </button>
                </div>
              )}
              {entry.state === 'error' && <p className="err">{entry.error}</p>}
              {entry.note && <p className="note-line">{entry.note}</p>}
            </div>
          </div>
        ))}
      </div>
      <div className="ask-in">
        <div className="ctx">
          {context.map((c, index) => (
            <button
              type="button"
              className="c"
              key={`${c.shotId}-${c.boxId ?? ''}`}
              title="Remove (⌫)"
              onClick={() => setContext(context.filter((_, i) => i !== index))}
            >
              {c.boxN ? <i>{c.boxN}</i> : null}
              Shot {c.shotIndex}
              {c.boxN ? ` · box ${c.boxN}` : ''}
            </button>
          ))}
          <span className="who" aria-label={`${who}${running ? ', answering' : ''}`}>
            {running && <span className="spin" />}
            {destination && <AgentMark host={destination.host} title={destination.title} size={16} />}
            {destination?.project || who}
          </span>
        </div>
        <div className="inbox">
          <textarea
            ref={inputRef}
            rows={1}
            value={question}
            disabled={!canAsk}
            placeholder={entries.length ? 'Follow up…' : 'Ask…'}
            aria-label="Ask this session"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                if (running) abortRef.current?.abort();
                else onClose();
              } else if (event.key === 'Backspace' && question === '' && context.length > 0) {
                setContext(context.slice(0, -1));
              }
            }}
          />
        </div>
        {shared.length > 0 && <div className="share-note">Shares shot {shared.join(', ')} with {host}</div>}
      </div>
    </div>
  );
}
