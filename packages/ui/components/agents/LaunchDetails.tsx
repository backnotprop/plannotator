import React from 'react';
import { GUIDE_ENGINE_LABEL, GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS } from '@plannotator/core/guide';
import { cn } from '../../lib/utils';
import { OptionPicker } from '../OptionPicker';
import { ModelSourceHint } from '../ModelSourceHint';
import { ClaudeIcon, CodexIcon, CopilotIcon, CursorIcon, OpenCodeIcon, PiIcon } from '../icons/AgentIcons';
import type { ReviewEngine } from '../../hooks/useAgentSettings';
import type { LaunchConfig, LaunchSide } from '../../hooks/useLaunchConfig';

const ENGINE_ICON: Record<ReviewEngine, React.FC<{ className?: string }>> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  cursor: CursorIcon,
  opencode: OpenCodeIcon,
  pi: PiIcon,
  copilot: CopilotIcon,
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] items-start gap-2">
      <span className="pt-1.5 text-[12px] text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Segments({ options, value, onChange, label }: { options: Array<{ value: string; label: string }>; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-7 rounded-md border px-2 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === o.value
              ? 'border-border bg-muted text-foreground'
              : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function LaunchDetails({
  side,
  config,
  instructions,
  onInstructions,
  onAddReview,
}: {
  side: LaunchSide;
  config: LaunchConfig;
  instructions?: string;
  onInstructions?: (value: string) => void;
  onAddReview?: () => void;
}) {
  const engineChoices = side.engines.map((e) => ({ value: e, label: GUIDE_ENGINE_LABEL[e] ?? e }));
  return (
    <div className="space-y-2 pb-3 pl-8 pr-1 pt-1" data-launch-details={side.kind}>
      {side.engines.length > 1 && (
        <Field label="Engine">
          <div role="radiogroup" aria-label="Engine" className="flex flex-wrap gap-1">
            {engineChoices.map(({ value, label }) => {
              const Icon = ENGINE_ICON[value];
              const on = side.engine === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={label}
                  title={label}
                  onClick={() => side.setEngine(value)}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    on ? 'border-border bg-muted' : 'border-transparent opacity-60 hover:bg-muted/60 hover:opacity-100',
                  )}
                >
                  <Icon className="h-4 w-4" />
                </button>
              );
            })}
          </div>
        </Field>
      )}
      <Field label="Model">
        {side.models ? (
          <OptionPicker trigger="field" value={side.model} options={side.models} onChange={side.setModel} />
        ) : (
          <span className="block py-1.5 text-[12px] text-muted-foreground">Loading models…</span>
        )}
      </Field>
      {side.efforts.length > 0 && (
        <Field label={side.effortName}>
          <Segments options={side.efforts} value={side.effort} onChange={side.setEffort} label={side.effortName} />
        </Field>
      )}
      {side.fast && (
        <Field label="Speed">
          <Segments
            label="Speed"
            options={[{ value: 'standard', label: 'Standard' }, { value: 'fast', label: 'Fast' }]}
            value={side.fast.value ? 'fast' : 'standard'}
            onChange={(v) => side.fast?.set(v === 'fast')}
          />
        </Field>
      )}
      {side.kind === 'review' && (
        <Field label="Focus">
          <OptionPicker
            trigger="field"
            value={config.profileId}
            options={config.profiles.map((p) => ({ value: p.id, label: p.label }))}
            onChange={config.setProfileId}
            {...(onAddReview ? { footerAction: { label: 'Add a review skill', onClick: onAddReview } } : {})}
          />
        </Field>
      )}
      {side.kind === 'guide' && onInstructions && (
        <Field label="Notes">
          <textarea
            value={instructions ?? ''}
            onChange={(e) => onInstructions(e.target.value)}
            maxLength={GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS}
            rows={2}
            spellCheck={false}
            aria-label="Standing instructions for every guide"
            placeholder="Standing instructions for every guide"
            className="block w-full resize-y rounded-md border border-border/60 bg-background px-2 py-1.5 text-[12px] leading-5 text-foreground outline-none placeholder:text-muted-foreground focus:border-border"
          />
        </Field>
      )}
      {(side.notice || side.catalogEngine || side.experimental) && (
        <div className="space-y-0.5 pl-[80px] text-[12px] leading-5 text-muted-foreground">
          {side.notice && <p data-model-fallback-notice="">{side.notice}</p>}
          {side.catalogEngine && <ModelSourceHint tool={side.catalogEngine} info={config.catalogs[side.catalogEngine]} />}
          {side.experimental && side.kind === 'review' && <p>Findings from this engine follow the prompt, not a schema.</p>}
        </div>
      )}
    </div>
  );
}
