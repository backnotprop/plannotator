import { useEffect, useId, useRef, useState } from 'react';
import { Tooltip } from '@plannotator/ui/components/Tooltip';
import { Icon } from '../icons';

export function RiskInfo({ name, label, text }: { name: string; label: string; text: string }) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const holder = useRef<HTMLSpanElement>(null);
  const textId = useId();
  const open = hover || focus || pinned;
  const close = () => {
    setHover(false);
    setFocus(false);
    setPinned(false);
  };
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!holder.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  return (
    <span ref={holder} className="ib-riskd-info">
      <Tooltip content={text} wide side="top" forceOpen={open} container={open ? (holder.current?.closest('dialog') ?? null) : null}>
        <button
          type="button"
          className="ib-riskd-i"
          aria-label={label}
          aria-describedby={textId}
          data-open={open ? '' : undefined}
          data-pull-risk-info={name}
          onPointerEnter={(event) => event.pointerType === 'mouse' && setHover(true)}
          onPointerLeave={(event) => event.pointerType === 'mouse' && setHover(false)}
          onFocus={(event) => setFocus(event.currentTarget.matches(':focus-visible'))}
          onBlur={close}
          onClick={() => setPinned((was) => !was)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || !open) return;
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
        >
          <Icon name="info" size={16} />
        </button>
      </Tooltip>
      <span id={textId} hidden>
        {text}
      </span>
    </span>
  );
}
