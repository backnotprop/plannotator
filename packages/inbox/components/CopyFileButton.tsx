import { useEffect, useRef, useState } from 'react';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { Icon } from '../icons';
import { Tip } from './Tip';

/** How long the button says "Copied" (or "Not copied") after a press. */
export const COPY_FILE_FEEDBACK_MS = 1600;

export interface CopyFileButtonProps {
  /** The text of the version on screen, exactly as read: what lands on the clipboard, as plain text. */
  text: string;
  name: string;
  /** The version on screen is the one that was sent (the tooltip says so). */
  sent: boolean;
  /** Say something in the pane's live region. */
  announce: (text: string) => void;
}

/**
 * Copy file (approval "inbox-copy-file", Strip): the first thing in a code
 * file's hint row, at the code's top left, clear of full screen's toolbar (top
 * right on a desktop, bottom right on a phone). A press puts the raw text on
 * the clipboard, the icon turns to a check with "Copied" for a moment, and the
 * live region says "Copied <name>.".
 */
export function CopyFileButton({ text, name, sent, announce }: CopyFileButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The text on screen: a copy that answers for another file, or after the pane closed, says nothing and starts no timer. */
  const current = useRef<string | null>(null);
  // Another file or version: the last one's "Copied" does not carry over, nor does its timer.
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
