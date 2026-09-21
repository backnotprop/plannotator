import React from 'react';

interface AnalysisLayerToggleProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: React.ReactNode;
  readonly description: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

/** Full-row switch shared by Settings and the code-review analysis welcome. */
export function AnalysisLayerToggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  className = '',
}: AnalysisLayerToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex min-h-11 w-full items-center justify-between gap-4 bg-transparent text-left disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{description}</span>
      </span>
      <span
        aria-hidden="true"
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-150 ease-out motion-reduce:transition-none ${
          checked ? 'bg-primary' : 'bg-muted'
        }`}
      >
        <span
          className={`absolute left-1 top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out motion-reduce:transition-none ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </span>
    </button>
  );
}
