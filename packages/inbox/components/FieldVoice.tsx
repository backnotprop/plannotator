import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type ReactNode, type RefObject } from 'react';
import { QuestionOtherToolsProvider } from '@plannotator/ui/components/QuestionOtherTools';
import { isTouchScreen, usePhone } from '../phone';
import { useVoiceSession, useVoiceShown } from '../voice';
import { textareaField } from '../voiceField';
import { VoiceMicButton, VoiceNote, VoiceStatusLine } from './VoiceMic';

/** Where a field's mic says its take started or ended: the Send it sits under (useOtherFieldVoice). */
export const QuestionVoiceBusy = createContext<((id: string, busy: boolean) => void) | null>(null);

export const QuestionVoiceBusyProvider = QuestionVoiceBusy.Provider;

/** The question cards' Other fields under one Send (a thread, decision mode): whether a take is still running. */
export interface OtherFieldVoice {
  /** For drawing: Send is off while one runs. */
  busy: boolean;
  /** For a Send already pressed: read now, not at the last render. */
  busyNow: () => boolean;
  /** The cards under this Send, each Other field with its mic (none while `off`). */
  wrap: (cards: ReactNode) => ReactNode;
}

export function useOtherFieldVoice(off = false): OtherFieldVoice {
  const fields = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);
  const report = useCallback((id: string, running: boolean) => {
    if (running) fields.current.add(id);
    else fields.current.delete(id);
    setBusy(fields.current.size > 0);
  }, []);
  return useMemo(() => ({
    busy,
    busyNow: () => fields.current.size > 0,
    wrap: (cards: ReactNode) => (
      <QuestionVoiceBusyProvider value={report}>
        <QuestionOtherToolsProvider value={off ? null : FieldVoice}>{cards}</QuestionOtherToolsProvider>
      </QuestionVoiceBusyProvider>
    ),
  }), [busy, off, report]);
}

type Props = { textareaRef: RefObject<HTMLTextAreaElement | null>; onBusyChange?: (busy: boolean) => void };

/**
 * A field's mic. The host draws it right after its textarea, both inside one box with `position: relative`: the mic sits
 * inside the field at its right edge, level with its first line, and the field keeps that room whether the mic shows or
 * not (`data-field-voice-room`, inbox.css), so the words never run under it and nothing moves when it comes. Below the
 * field: the take's status and its notes, only while there is one.
 *
 * It shows while the field or the mic itself has focus, while a take runs, and while its words or a note are still on
 * the field; otherwise nothing is drawn. Tab reaches it right after the field; a press keeps the field's focus and the
 * phone's keyboard (voicePress.ts, as the reply box's mic).
 */
export function FieldVoice(props: Props) {
  return useVoiceShown() ? <AttachedVoice {...props} /> : null;
}

/** The mic's box: level with the field's first line (the field may have grown), in the host's box. */
function firstLine(field: HTMLTextAreaElement): { top: number; height: number } {
  const style = getComputedStyle(field);
  const px = (value: string) => parseFloat(value) || 0;
  const line = px(style.lineHeight) || px(style.fontSize) * 1.2 || 20;
  const one = px(style.borderTopWidth) + px(style.paddingTop) + line + px(style.paddingBottom) + px(style.borderBottomWidth);
  return { top: field.offsetTop, height: Math.min(one, field.offsetHeight || one) };
}

function AttachedVoice({ textareaRef, onBusyChange }: Props) {
  const voice = useVoiceSession(); // no late receiver: a dismissed field silently drops its take
  const phone = usePhone();
  const report = useContext(QuestionVoiceBusy);
  const id = useId();
  const micBox = useRef<HTMLSpanElement>(null);
  const [focused, setFocused] = useState(false);
  const [place, setPlace] = useState<{ top: number; height: number } | null>(null);
  const { view } = voice;
  const shown = focused || view.phase !== 'idle' || view.wash !== null || view.trouble !== null;
  useLayoutEffect(() => {
    const field = textareaRef.current;
    if (field) return voice.session.attach(textareaField(field, isTouchScreen));
  }, [voice.session, textareaRef]);
  useLayoutEffect(() => {
    if (!voice.busy) return;
    onBusyChange?.(true);
    report?.(id, true);
    return () => { onBusyChange?.(false); report?.(id, false); };
  }, [voice.busy, onBusyChange, report, id]);
  // The room the mic takes, kept at rest too.
  useLayoutEffect(() => {
    const field = textareaRef.current;
    if (!field) return;
    field.setAttribute('data-field-voice-room', '');
    return () => field.removeAttribute('data-field-voice-room');
  }, [textareaRef]);
  // Focus moving between the field and its mic (Tab, Shift+Tab) is not a leave: the mic stays under the move.
  const stillHere = (next: EventTarget | null) => next instanceof Node && (next === textareaRef.current || !!micBox.current?.contains(next));
  const leave = (event: FocusEvent | ReactFocusEvent) => {
    if (!stillHere(event.relatedTarget)) setFocused(false);
  };
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  useLayoutEffect(() => {
    const field = textareaRef.current;
    if (!field) return;
    setFocused(document.activeElement === field);
    const onFocus = () => setFocused(true);
    const onBlur = (event: FocusEvent) => leaveRef.current(event);
    field.addEventListener('focus', onFocus);
    field.addEventListener('blur', onBlur);
    return () => {
      field.removeEventListener('focus', onFocus);
      field.removeEventListener('blur', onBlur);
    };
  }, [textareaRef]);
  useLayoutEffect(() => {
    const field = textareaRef.current;
    if (shown && field) setPlace(firstLine(field));
  }, [shown, phone, textareaRef]);
  if (!shown) return null;
  return (
    <>
      <span
        ref={micBox}
        className="ib-field-voice ib-field-mic"
        data-field-voice-mic=""
        style={place ?? undefined}
        onFocus={() => setFocused(true)}
        onBlur={leave}
      >
        <VoiceMicButton voice={voice} phone={phone} />
      </span>
      <div className="ib-field-voice ib-field-vfoot" data-field-voice="">
        <VoiceStatusLine voice={voice} phone={phone} />
        <VoiceNote voice={voice} />
      </div>
    </>
  );
}
