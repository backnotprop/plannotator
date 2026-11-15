import { useEffect } from 'react';
import type { CommentCardToolsProps } from '@plannotator/ui/components/CommentCardTools';
import { useVoiceSession } from '../voice';
import { textareaField } from '../voiceField';
import { isTouchScreen } from '../phone';
import { VoiceMicButton, VoiceNote, VoiceStatusLine } from './VoiceMic';

export function CardVoice({ textareaRef, phone, onBusyChange }: CommentCardToolsProps) {
  const voice = useVoiceSession();
  const { session, busy } = voice;
  useEffect(() => {
    const field = textareaRef.current;
    if (!field) return;
    return session.attach(textareaField(field, isTouchScreen));
  }, [session, textareaRef]);
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  return (
    <>
      {busy && (
        <span className="pn-cbox-vline">
          <VoiceStatusLine voice={voice} phone={phone} />
        </span>
      )}
      <span className="pn-cbox-vnote">
        <VoiceNote voice={voice} />
      </span>
      <VoiceMicButton voice={voice} phone={phone} />
    </>
  );
}
