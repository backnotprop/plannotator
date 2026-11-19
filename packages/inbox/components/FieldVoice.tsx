import { createContext, useContext, useId, useLayoutEffect, type RefObject } from 'react';
import { isTouchScreen, usePhone } from '../phone';
import { useVoiceSession, useVoiceShown } from '../voice';
import { textareaField } from '../voiceField';
import { VoiceMicButton, VoiceNote, VoiceStatusLine } from './VoiceMic';

const QuestionVoiceBusy = createContext<((id: string, busy: boolean) => void) | null>(null);

export const QuestionVoiceBusyProvider = QuestionVoiceBusy.Provider;

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
