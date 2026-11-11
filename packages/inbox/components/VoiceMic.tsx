import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ComposerMirrorPaint } from '@plannotator/ui/components/ComposerTokenTextarea';
import { Icon } from '../icons';
import { useVoiceBlock, useVoiceSettings, useVoiceShown, voiceWhere, type VoiceBlock, type VoiceHandle } from '../voice';
import { voiceLine } from '../voiceLine';
import { watchVoiceMisses } from '../voiceMiss';
import { voicePressProps } from '../voicePress';
import { VOICE_BARS, type VoiceSession, type VoiceTrouble, type VoiceView } from '../voiceSession';

function Bars({ session, count }: { session: VoiceSession; count: number }) {
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const draw = () => {
      const shown = session.meter().bars.slice(VOICE_BARS - count);
      const spans = box.current?.children;
      if (!spans) return;
      shown.forEach((bar, index) => {
        const span = spans[index] as HTMLElement | undefined;
        if (!span) return;
        span.style.transform = `scaleY(${bar.height.toFixed(3)})`;
        span.toggleAttribute('data-v', bar.voice);
      });
    };
    draw();
    return session.subscribeMeter(draw);
  }, [session, count]);
  return (
    <span className="ib-vbars" aria-hidden="true" ref={box}>
      {Array.from({ length: count }, (_, index) => (
        <span key={index} />
      ))}
    </span>
  );
}

function VoiceStatus({ voice, phone }: { voice: VoiceHandle; phone: boolean }) {
  const { session, view } = voice;
  const line = () => voiceLine(view, session.meter(), phone);
  useSyncExternalStore(session.subscribeMeter, () => JSON.stringify(line()));
  const now = line();
  if (!now) return null;
  return (
    <span className="ib-vline" data-voice-line={now.state}>
      <b>{now.word}</b>
      {now.hint && <span className="ib-vhint">{now.hint}</span>}
      <button type="button" className="ib-dtlink" data-voice-cancel="" onClick={session.cancel}>
        Cancel
      </button>
      <span className="ib-vsp" />
      {now.bars && <Bars session={session} count={phone ? 10 : VOICE_BARS} />}
      {now.time && <span className="ib-dttime">{now.time}</span>}
    </span>
  );
}

function MicButton({ voice, phone, block }: { voice: VoiceHandle; phone: boolean; block: VoiceBlock | null }) {
  const { session, view } = voice;
  const live = view.phase === 'opening' || view.phase === 'listening';
  const tapped = view.phase === 'listening' && view.mode === 'tap';
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!live || !button.current) return;
    return watchVoiceMisses(button.current, () => session.view());
  }, [live, session]);
  const iconSize = phone ? 19 : 16;
  const opening = view.phase === 'opening';
  const label = block ? 'Dictate: not available here' : view.phase === 'sending' ? 'Transcribing' : opening ? 'Opening the microphone' : tapped ? 'Stop dictating' : live ? 'Dictating' : 'Dictate: hold to talk, or tap';
  return (
    <button
      ref={button}
      type="button"
      className="ib-vmic"
      data-state={live ? 'live' : view.phase === 'sending' ? 'sending' : 'idle'}
      aria-disabled={block ? true : undefined}
      aria-label={label}
      data-voice-mic=""
      {...(block ? {} : voicePressProps(session))}
    >
      {view.phase === 'sending' || opening ? <span className="ib-spin" /> : tapped ? <Icon name="stop" size={iconSize} /> : <Icon name="mic" size={iconSize} />}
    </button>
  );
}

export function VoiceFoot({ voice, phone, children }: { voice: VoiceHandle; phone: boolean; children?: ReactNode }) {
  const shown = useVoiceShown();
  const block = useVoiceBlock(shown);
  if (!shown) return children;
  return (
    <div className="ib-dtfoot" data-voice-foot="">
      <VoiceStatus voice={voice} phone={phone} />
      {children}
      <MicButton voice={voice} phone={phone} block={block} />
      <span className="ib-sr" role="status">
        {voice.view.said}
      </span>
    </div>
  );
}

export function VoiceMicButton({ voice, phone }: { voice: VoiceHandle; phone: boolean }) {
  const shown = useVoiceShown();
  const block = useVoiceBlock(shown);
  if (!shown) return null;
  return (
    <>
      <MicButton voice={voice} phone={phone} block={block} />
      <span className="ib-sr" role="status">
        {voice.view.said}
      </span>
    </>
  );
}

export function VoiceStatusLine({ voice, phone }: { voice: VoiceHandle; phone: boolean }) {
  const shown = useVoiceShown();
  if (!shown) return null;
  return <VoiceStatus voice={voice} phone={phone} />;
}

export function VoiceFootRow({ voice, phone }: { voice: VoiceHandle; phone: boolean }) {
  const shown = useVoiceShown();
  if (!shown) return null;
  return (
    <div className="ib-rfoot">
      <VoiceFoot voice={voice} phone={phone} />
    </div>
  );
}

interface Note {
  text: ReactNode;
  tone: 'quiet' | 'error';
  settings?: boolean;
}

function troubleNote(trouble: VoiceTrouble, api: boolean, where: string): Note {
  const service = api ? 'OpenAI' : 'ChatGPT';
  switch (trouble) {
    case 'notheard':
      return { tone: 'quiet', text: 'Nothing heard, so nothing was sent.' };
    case 'nothing':
      return { tone: 'quiet', text: 'Nothing heard in that clip.' };
    case 'badclip':
      return { tone: 'error', text: 'That clip didn’t reach the Inbox whole, so nothing was sent. Try again.' };
    case 'blocked':
      return { tone: 'error', text: 'The browser blocked the microphone. Allow it in this site’s settings, then press the mic again.' };
    case 'micfailed':
      return { tone: 'error', text: 'The microphone didn’t start. Check that one is connected, then press the mic again.' };
    case 'expired':
      return {
        tone: 'error',
        text: (
          <>
            Your ChatGPT sign-in expired. Run <code>codex login</code> on {where}, then retry.
          </>
        ),
      };
    case 'refused':
      return api
        ? { tone: 'error', text: 'OpenAI turned this clip down.' }
        : { tone: 'error', text: 'ChatGPT turned this clip down. This route isn’t an official API, so it can be blocked or changed without notice.' };
    case 'keyrefused':
      return { tone: 'error', text: 'OpenAI refused this API key.', settings: true };
    case 'offline':
      return { tone: 'error', text: `Could not reach ${service}. Your clip is kept until you close this box.` };
    case 'inboxgone':
      return { tone: 'error', text: 'Could not reach the Inbox. Your clip is kept until you close this box.' };
    case 'codexfailed':
      return { tone: 'error', text: `Codex didn’t answer on ${where}. Your clip is kept until you close this box.` };
    case 'notready':
      return { tone: 'quiet', text: notReadyText(api, where), settings: true };
    case 'voiceoff':
      return { tone: 'quiet', text: `Voice is off on ${where}.`, settings: true };
    case 'failed':
      return { tone: 'error', text: 'Couldn’t transcribe this clip. Your clip is kept until you close this box.' };
  }
}

const notReadyText = (api: boolean, where: string) => (api ? `Voice needs an OpenAI API key on ${where}.` : `Voice needs Codex signed in with ChatGPT on ${where}.`);

function blockNote(block: VoiceBlock, api: boolean, where: string): Note {
  return block === 'nomic'
    ? { tone: 'quiet', text: 'This page can’t use the microphone. Browsers allow it only over https or on the computer itself.' }
    : { tone: 'quiet', text: notReadyText(api, where), settings: true };
}

type ShownNote = { note: Note; kept: boolean; settings: boolean };

export function VoiceNote({ voice, glide = false }: { voice: VoiceHandle; glide?: boolean }) {
  const settings = useVoiceSettings();
  const shown = useVoiceShown();
  const block = useVoiceBlock(shown);
  const { session, view } = voice;
  const api = (view.engine ?? settings?.engine) === 'api';
  const where = voiceWhere(settings);
  const note = !shown ? null : view.trouble ? troubleNote(view.trouble, api, where) : block ? blockNote(block, api, where) : null;
  const [leaving, setLeaving] = useState<ShownNote | null>(null);
  const last = useRef<ShownNote | null>(null);
  useEffect(() => {
    if (note) {
      last.current = { note, kept: view.kept, settings: !!note.settings };
      setLeaving(null);
      return;
    }
    if (!glide || !last.current) return;
    setLeaving(last.current);
    last.current = null;
  }, [note ? (view.trouble ?? block ?? '') : null, view.kept, glide]);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(null), window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 170);
    return () => clearTimeout(timer);
  }, [leaving]);
  if (!note) {
    // The render that drops the note already draws it leaving; the effect that keeps it runs after the paint.
    const going = glide ? (leaving ?? last.current) : null;
    if (!going) return null;
    return (
      <div className={`ib-vnote ib-vnote-leaving${going.note.tone === 'error' ? ' ib-verr' : ''}`} aria-hidden="true" data-voice-note-leaving="">
        <span className="ib-vnote-t">{going.note.text}</span>
        {(going.kept || going.settings) && (
          <span className="ib-vnote-a">
            {going.kept && (
              <>
                <span className="ib-dtlink ib-vstrong">Retry</span>
                <span className="ib-dtlink">Discard</span>
              </>
            )}
            {going.settings && <span className="ib-dtlink ib-vstrong">Voice settings</span>}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className={`ib-vnote${note.tone === 'error' ? ' ib-verr' : ''}`} role={note.tone === 'error' ? 'alert' : 'status'} data-voice-note={view.trouble ?? block ?? undefined}>
      <span className="ib-vnote-t">{note.text}</span>
      {(view.kept || note.settings) && (
        <span className="ib-vnote-a">
          {view.kept && (
            <>
              <button type="button" className="ib-dtlink ib-vstrong" data-voice-retry="" onClick={session.retry}>
                Retry
              </button>
              <button type="button" className="ib-dtlink" data-voice-discard="" onClick={session.discard}>
                Discard
              </button>
            </>
          )}
          {note.settings && (
            <a className="ib-dtlink ib-vstrong" href="#settings/voice" data-voice-settings="">
              Voice settings
            </a>
          )}
        </span>
      )}
    </div>
  );
}

function VoiceCaret({ session }: { session: VoiceSession }) {
  const caret = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    return session.subscribeMeter(() => {
      if (caret.current) caret.current.style.transform = `scaleY(${(0.18 + session.meter().level * 0.82).toFixed(3)})`;
    });
  }, [session]);
  return <span className="ib-vcaret" ref={caret} />;
}

function Marker({ wide }: { wide: boolean }) {
  if (!wide) return <span className="ib-vcaret ib-vstill" />;
  return (
    <span className="ib-vph">
      <i>Transcribing…</i>
    </span>
  );
}

export function voicePaint(view: VoiceView, session: VoiceSession, value: string): ComposerMirrorPaint | undefined {
  if (view.phase === 'listening') return { at: view.caret, node: <VoiceCaret session={session} /> };
  if (view.phase === 'sending') {
    const next = value[view.caret];
    return { at: view.caret, node: <Marker wide={next === undefined || next === '\n'} /> };
  }
  if (view.wash) return { wash: { start: view.wash.start, end: view.wash.end, className: `ib-vmark${view.wash.fading ? ' ib-vfade' : ''}` } };
  return undefined;
}

export function voiceHidesCaret(view: VoiceView): boolean {
  return view.phase === 'listening' || view.phase === 'sending';
}
