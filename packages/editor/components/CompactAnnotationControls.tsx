import React, { useState } from 'react';
import type { InputMethod } from '@plannotator/ui/types';

interface CompactAnnotationControlsProps {
  inputMethod: InputMethod;
  onInputMethodChange: (method: InputMethod) => void;
}

/**
 * Reading-first entry into the existing Plan annotation engine. Compact touch
 * always uses Markup semantics; this control only chooses how a target is
 * acquired. Compact method changes remain session-only, so the persisted
 * desktop action and input-method preferences stay untouched.
 */
export const CompactAnnotationControls: React.FC<CompactAnnotationControlsProps> = ({
  inputMethod,
  onInputMethodChange,
}) => {
  const [expanded, setExpanded] = useState(false);

  if (!expanded) {
    return (
      <button
        type="button"
        data-pn-touch-target
        data-pn-compact-annotate-entry="true"
        onClick={() => setExpanded(true)}
        aria-expanded="false"
        className="inline-flex min-w-0 items-center gap-2 rounded-lg border border-border/50 bg-muted/45 px-3 text-sm font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <MarkupIcon />
        <span>Annotate</span>
        <span className="text-muted-foreground">·</span>
        <span className="truncate text-muted-foreground">
          {inputMethod === 'pinpoint' ? 'Pinpoint' : 'Select text'}
        </span>
        <ChevronIcon />
      </button>
    );
  }

  const choose = (method: InputMethod) => {
    onInputMethodChange(method);
    setExpanded(false);
  };

  return (
    <div
      data-pn-compact-annotate-choices="true"
      className="grid w-full grid-cols-2 gap-1 rounded-xl border border-border/50 bg-muted/45 p-1"
      role="group"
      aria-label="Choose how to annotate"
    >
      <MethodButton
        selected={inputMethod === 'drag'}
        label="Select text"
        description="Drag over text"
        icon={<SelectIcon />}
        onClick={() => choose('drag')}
      />
      <MethodButton
        selected={inputMethod === 'pinpoint'}
        label="Pinpoint"
        description="Tap one block"
        icon={<PinpointIcon />}
        onClick={() => choose('pinpoint')}
      />
    </div>
  );
};

const MethodButton = ({
  selected,
  label,
  description,
  icon,
  onClick,
}: {
  selected: boolean;
  label: string;
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
}) => (
  <button
    type="button"
    data-pn-touch-target
    aria-pressed={selected}
    onClick={onClick}
    className={`flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 ${
      selected
        ? 'bg-background text-foreground shadow-sm'
        : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
    }`}
  >
    <span className="shrink-0">{icon}</span>
    <span className="min-w-0">
      <span className="block text-sm font-medium leading-4">{label}</span>
      <span className="block truncate text-[11px] leading-4 text-muted-foreground">{description}</span>
    </span>
  </button>
);

const MarkupIcon = () => (
  <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
  </svg>
);

const SelectIcon = () => (
  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h-1a2 2 0 0 1-2-2 2 2 0 0 1-2 2H6" />
    <path d="M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7" />
    <path d="M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1" />
    <path d="M6 4h1a2 2 0 0 1 2 2 2 2 0 0 1 2-2h1" />
    <path d="M9 6v12" />
  </svg>
);

const PinpointIcon = () => (
  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
  </svg>
);

const ChevronIcon = () => (
  <svg className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
  </svg>
);
