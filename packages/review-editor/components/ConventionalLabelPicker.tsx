import React, { useCallback } from 'react';
import type { ConventionalLabel, ConventionalDecoration } from '@plannotator/ui/types';

type SemanticTone = 'danger' | 'warn' | 'success' | 'info' | 'neutral';

export interface LabelDef {
  label: ConventionalLabel;
  display: string;
  tone: SemanticTone;
  showBlockingToggle: boolean;
  hint: string;
}

export const CONVENTIONAL_LABELS: LabelDef[] = [
  { label: 'suggestion', display: 'suggestion', tone: 'info',    showBlockingToggle: true,  hint: 'Proposes an improvement' },
  { label: 'nitpick',    display: 'nit',        tone: 'neutral', showBlockingToggle: false, hint: 'Trivial, preference-based' },
  { label: 'question',   display: 'question',   tone: 'info',    showBlockingToggle: true,  hint: 'Seeking clarification' },
  { label: 'issue',      display: 'issue',      tone: 'danger',  showBlockingToggle: true,  hint: 'A problem that needs addressing' },
  { label: 'praise',     display: 'praise',     tone: 'success', showBlockingToggle: false, hint: 'Highlight something positive' },
  { label: 'thought',    display: 'thought',    tone: 'neutral', showBlockingToggle: false, hint: 'An idea, not a request' },
  { label: 'note',       display: 'note',       tone: 'neutral', showBlockingToggle: false, hint: 'Informational, no action needed' },
  { label: 'todo',       display: 'todo',       tone: 'warn',    showBlockingToggle: true,  hint: 'Small, necessary change' },
  { label: 'chore',      display: 'chore',      tone: 'warn',    showBlockingToggle: true,  hint: 'Process task (CI, changelog, etc.)' },
];

export function getEnabledLabels(configJson: string | null): LabelDef[] {
  if (!configJson) return CONVENTIONAL_LABELS;
  try {
    const parsed = JSON.parse(configJson) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed)) return CONVENTIONAL_LABELS;
    return parsed.map(cfg => {
      const builtIn = CONVENTIONAL_LABELS.find(l => l.label === cfg.label);
      return {
        label: cfg.label as ConventionalLabel,
        display: cfg.display as string,
        tone: builtIn?.tone || 'neutral',
        showBlockingToggle: cfg.blocking === true || cfg.blocking === 'true',
        hint: builtIn?.hint || (cfg.display as string),
      };
    });
  } catch {
    return CONVENTIONAL_LABELS;
  }
}

interface ConventionalLabelPickerProps {
  selected: ConventionalLabel | null;
  decorations: ConventionalDecoration[];
  onSelect: (label: ConventionalLabel | null) => void;
  onDecorationsChange: (decorations: ConventionalDecoration[]) => void;
  enabledLabels?: LabelDef[];
}

export const ConventionalLabelPicker: React.FC<ConventionalLabelPickerProps> = ({
  selected,
  decorations,
  onSelect,
  onDecorationsChange,
  enabledLabels = CONVENTIONAL_LABELS,
}) => {
  const handleLabelClick = useCallback((label: ConventionalLabel) => {
    if (selected === label) {
      onSelect(null);
      onDecorationsChange([]);
    } else {
      onSelect(label);
      const def = enabledLabels.find(l => l.label === label);
      if (def?.showBlockingToggle) {
        onDecorationsChange(['non-blocking']);
      } else {
        onDecorationsChange([]);
      }
    }
  }, [selected, enabledLabels, onSelect, onDecorationsChange]);

  const activeDef = selected ? enabledLabels.find(l => l.label === selected) : undefined;
  const isBlocking = decorations.includes('blocking');
  const showToggle = activeDef?.showBlockingToggle ?? false;

  const toggleBlocking = useCallback(() => {
    const cleaned = decorations.filter(d => d !== 'blocking' && d !== 'non-blocking');
    onDecorationsChange([...cleaned, isBlocking ? 'non-blocking' : 'blocking']);
  }, [decorations, isBlocking, onDecorationsChange]);

  return (
    <div className="cc-picker">
      <div className="cc-row">
        {enabledLabels.map((def, idx) => {
          const isActive = selected === def.label;
          return (
            <button
              key={`${idx}-${def.label}`}
              type="button"
              className={`cc-tag cc-tone-${def.tone}${isActive ? ' active' : ''}`}
              onClick={() => handleLabelClick(def.label)}
              title={def.hint}
            >
              {def.display}
            </button>
          );
        })}

        {}
        {showToggle && (
          <button
            type="button"
            className={`cc-blocking-toggle ${isBlocking ? 'is-blocking' : ''}`}
            onClick={toggleBlocking}
            title={isBlocking ? 'Must resolve before merge' : 'Optional, not blocking'}
          >
            <span className="cc-toggle-track">
              <span className="cc-toggle-thumb" />
            </span>
            {isBlocking ? 'blocking' : 'non-blocking'}
          </button>
        )}
      </div>
    </div>
  );
};

export const ConventionalLabelBadge: React.FC<{
  label: ConventionalLabel;
  decorations?: ConventionalDecoration[];
}> = ({ label, decorations }) => {
  const def = CONVENTIONAL_LABELS.find(l => l.label === label);
  const tone = def?.tone || 'neutral';
  const display = def?.display || label;

  const isBlocking = decorations?.includes('blocking');
  const hasDecoration = isBlocking || decorations?.includes('non-blocking');

  return (
    <span className={`cc-inline-badge cc-tone-${tone}`}>
      {display}
      {hasDecoration && (
        <span className={`cc-inline-dec${isBlocking ? ' cc-inline-dec-blocking' : ''}`}>
          {isBlocking ? 'blocking' : 'non-blocking'}
        </span>
      )}
    </span>
  );
};
