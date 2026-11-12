import { useEffect, useRef, useState } from 'react';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { Icon } from '../icons';
import { Tip } from './Tip';

export const COPY_FILE_FEEDBACK_MS = 1600;

export interface CopyFileButtonProps {
  text: string;
  name: string;
  sent: boolean;
  announce: (text: string) => void;
}

export function CopyFileButton({ text, name, sent, announce }: CopyFileButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef<string | null>(null);
  useEffect(() => {
    current.current = text;
    setState('idle');
    return () => {
      current.current = null;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [text]);

  const copy = async () => {
    const ok = await copyTextToClipboard(text);
    if (current.current !== text) return;
    announce(ok ? `Copied ${name}.` : `${name} was not copied. Select the code and copy it instead.`);
    setState(ok ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), COPY_FILE_FEEDBACK_MS);
  };

  const tip = state === 'copied' ? 'Copied' : sent ? `Copy the text of ${name} as it was sent` : `Copy the text of ${name}`;
  return (
    <Tip content={tip}>
      <button
        type="button"
        className={`ib-copyfile${state === 'copied' ? ' ib-copied' : state === 'failed' ? ' ib-copyfail' : ''}`}
        onClick={() => void copy()}
        data-copy-file={state}
      >
        <Icon name={state === 'copied' ? 'check' : 'copy'} size={14} />
        <span>{state === 'copied' ? 'Copied' : state === 'failed' ? 'Not copied' : 'Copy file'}</span>
      </button>
    </Tip>
  );
}
