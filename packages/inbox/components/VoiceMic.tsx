/**
 * The microphone in the shared composer. `VoiceFoot`: the status and the button, placed by each host in its own
 * toolbar as it places the paperclip; nothing at all when voice is off, or with Phones only on anything but a touch
 * screen. `VoiceNote`: the line under the text, for what needs words or a choice. `voicePaint`: what the mirror layer
 * adds at the caret (the caret that follows the level, or the dim marker), never in the value.
 *
 * The level reaches the screen by direct writes from `subscribeMeter`, so a hold re-renders nothing but the one line
 * that shows its seconds.
 */
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { ComposerMirrorPaint } from '@plannotator/ui/components/ComposerTokenTextarea';
import { Icon } from '../icons';
import { useVoiceBlock, useVoiceSettings, useVoiceShown, voiceWhere, type VoiceBlock, type VoiceHandle } from '../voice';
import { voiceLine } from '../voiceLine';
import { voicePressProps } from '../voicePress';
import { VOICE_BARS, type VoiceSession, type VoiceTrouble, type VoiceView } from '../voiceSession';

/** The last bars of the level, written straight to the DOM on every tick. */
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

/** The status: re-renders when its words change, which is once a second at most. */
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
  const iconSize = phone ? 19 : 16;
  const label = block ? 'Dictate: not available here' : view.phase === 'sending' ? 'Transcribing' : tapped ? 'Stop dictating' : live ? 'Dictating' : 'Dictate: hold to talk, or tap';
  return (
    <button
      type="button"
      className="ib-vmic"
      data-state={live ? 'live' : view.phase === 'sending' ? 'sending' : 'idle'}
      aria-disabled={block ? true : undefined}
      aria-label={label}
      data-voice-mic=""
      {...(block ? {} : voicePressProps(session))}
    >
      {view.phase === 'sending' ? <span className="ib-spin" /> : tapped ? <Icon name="stop" size={iconSize} /> : <Icon name="mic" size={iconSize} />}
    </button>
  );
}

export function VoiceFoot({ voice, phone }: { voice: VoiceHandle; phone: boolean }) {
  const shown = useVoiceShown();
  const block = useVoiceBlock(shown);
  if (!shown) return null;
  return (
    <div className="ib-dtfoot" data-voice-foot="">
      <VoiceStatus voice={voice} phone={phone} />
      <MicButton voice={voice} phone={phone} block={block} />
      <span className="ib-sr" role="status">
        {voice.view.said}
      </span>
    </div>
  );
}

/** The foot in a host with no toolbar of its own. */
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
  }
}

const notReadyText = (api: boolean, where: string) => (api ? `Voice needs an OpenAI API key on ${where}.` : `Voice needs Codex signed in with ChatGPT on ${where}.`);

function blockNote(block: VoiceBlock, api: boolean, where: string): Note {
  return block === 'nomic'
    ? { tone: 'quiet', text: 'This page can’t use the microphone. Browsers allow it only over https or on the computer itself.' }
    : { tone: 'quiet', text: notReadyText(api, where), settings: true };
}

export function VoiceNote({ voice }: { voice: VoiceHandle }) {
  const settings = useVoiceSettings();
  const shown = useVoiceShown();
  const block = useVoiceBlock(shown);
  if (!shown) return null;
  const { session, view } = voice;
  const api = (view.engine ?? settings?.engine) === 'api';
  const where = voiceWhere(settings);
  const note = view.trouble ? troubleNote(view.trouble, api, where) : block ? blockNote(block, api, where) : null;
  if (!note) return null;
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

/** The caret that follows the level. Still under reduced motion. */
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

/** The dim marker reads as text, so it says its word only where nothing follows on the line. */
function Marker({ wide }: { wide: boolean }) {
  // Between words there's no room for a word: the caret stays, still, where they will land.
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

/** The field hides its own caret and placeholder: the painted caret stands in. */
export function voiceHidesCaret(view: VoiceView): boolean {
  return view.phase === 'listening' || view.phase === 'sending';
}
