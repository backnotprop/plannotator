import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
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

export function FieldVoice(props: Props) {
  return useVoiceShown() ? <AttachedVoice {...props} /> : null;
}

function AttachedVoice({ textareaRef, onBusyChange }: Props) {
  const voice = useVoiceSession(); // no late receiver: a dismissed field silently drops its take
  const phone = usePhone();
  const report = useContext(QuestionVoiceBusy);
  const id = useId();
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
  return (
    <span className="ib-field-voice" data-field-voice="">
      <VoiceStatusLine voice={voice} phone={phone} />
      <VoiceNote voice={voice} />
      <VoiceMicButton voice={voice} phone={phone} />
    </span>
  );
}
