import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { AgentCapabilities } from '@plannotator/ui/types';
import type { AgentLaunchParams } from '@plannotator/ui/hooks/useAgentJobs';
import { useAgentSettings } from '@plannotator/ui/hooks/useAgentSettings';
import type { ReviewEngine } from '@plannotator/ui/hooks/useAgentSettings';
// Same catalogs AgentsTab's launch panel uses — one source of truth for both
// guide launch surfaces (this page and the sidebar's Guided Review mode).
import {
  TOUR_CLAUDE_MODELS,
  CLAUDE_EFFORT,
  CODEX_MODELS,
  CODEX_REASONING,
  PI_THINKING,
  REVIEW_ENGINE_LABEL,
} from '@plannotator/ui/components/AgentsTab';
import { groupModelOptions, labelWithinGroup, SEARCHABLE_THRESHOLD } from '@plannotator/ui/components/AgentControls';

const GUIDE_ENGINES = Object.keys(REVIEW_ENGINE_LABEL) as ReviewEngine[];

// Marker-engine fallbacks until the server delivers the live catalogs on the
// capability entries (mirrors AgentsTab's fallbacks).
const CURSOR_FALLBACK = [{ value: 'auto', label: 'Auto' }];
const OPENCODE_FALLBACK = [{ value: '', label: 'Default' }];
const PI_FALLBACK = [{ value: '', label: 'Default' }];
const COPILOT_FALLBACK = [{ value: '', label: 'Default' }];

type Option = { value: string; label: string };

/** Inline "Label: Value ▾" picker — the wireframe's compact select pill.
 *  Long catalogs (marker-engine model lists can run to hundreds) automatically
 *  gain a type-to-filter input, a wider popover, and provider group headers. */
function InlinePicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const current = options.find((o) => o.value === value);
  const searchable = options.length > SEARCHABLE_THRESHOLD;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
    : options;
  const grouped = groupModelOptions(filtered);

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const select = (v: string) => {
    onChange(v);
    close();
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        className="flex items-center gap-2 rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-xs transition-colors hover:border-border"
      >
        <span className="text-muted-foreground">{label}:</span>
        <span className="max-w-[260px] truncate text-foreground">{current?.label ?? value}</span>
        <ChevronDown className={`text-muted-foreground/40 transition-transform ${open ? 'rotate-180' : ''}`} size={11} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div
            className={`absolute left-0 top-full z-20 mt-1 rounded-lg border border-border/50 bg-popover shadow-xl ${
              searchable ? 'w-[340px]' : 'min-w-[140px]'
            }`}
          >
            {searchable && (
              <div className="p-1 pb-0">
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Escape') close();
                    if (e.key === 'Enter' && filtered.length > 0) select(filtered[0].value);
                  }}
                  placeholder="Type to filter…"
                  className="w-full rounded-md border border-border/40 bg-background px-2.5 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/40 focus:border-border"
                />
              </div>
            )}
            <div className={`overflow-y-auto p-1 ${searchable ? 'max-h-80' : 'max-h-56'}`}>
              {filtered.length === 0 && (
                <div className="px-2.5 py-2 text-xs text-muted-foreground/50">No matches</div>
              )}
              {grouped.map((group) => (
                <React.Fragment key={group.label ?? '__flat'}>
                  {group.label && (
                    <div className="px-2.5 pb-0.5 pt-1.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/40">
                      {group.label}
                    </div>
                  )}
                  {group.options.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => select(o.value)}
                      className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                        value === o.value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{labelWithinGroup(o.label, group.label)}</span>
                    </button>
                  ))}
                </React.Fragment>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface GuideFailure {
  jobId: string;
  engine?: string;
  error: string;
}

interface GuideEmptyStateProps {
  capabilities: AgentCapabilities | null;
  launchJob: (params: AgentLaunchParams) => Promise<unknown>;
  /** Return to the normal diff workspace (closes the takeover). */
  onBack: () => void;
  /** Set when the most recent guide job failed (or was killed) rather than
   *  never having been launched — rendered as a recovery panel above the
   *  launch controls: the failure reason, an optional "Fix output" repair
   *  launch (offered once a captured payload is confirmed via the output
   *  probe below), and an editable "Show output" disclosure for manually
   *  correcting and resubmitting that payload. */
  failure?: GuideFailure;
  /** Navigate to a guide by job id once a manually-fixed output is accepted by
   *  the server (POST /api/guide/:jobId/submit → 200). */
  onOpenFixedGuide?: (jobId: string) => void;
}

/**
 * Guided Review's landing page — shown when there is no completed or running
 * guide job yet. A clean, roomy, Notion-like page: heading, one paragraph, a
 * quiet "Model defaults" card with inline Engine / Model / Effort pickers
 * (the same persisted guide settings AgentsTab's launch panel edits), and a
 * primary Generate button.
 */
export const GuideEmptyState: React.FC<GuideEmptyStateProps> = ({ capabilities, launchJob, onBack, failure, onOpenFixedGuide }) => {
  const {
    guideEngine,
    guideClaudeModel,
    guideClaudeEffort,
    guideCodexModel,
    guideCodexReasoning,
    guideCursorModel,
    guideOpencodeModel,
    guidePiModel,
    guidePiThinking,
    guideCopilotModel,
    setGuideEngine,
    setGuideClaudeModel,
    setGuideClaudeEffort,
    setGuideCodexModel,
    setGuideCodexReasoning,
    setGuideCursorModel,
    setGuideOpencodeModel,
    setGuidePiModel,
    setGuidePiThinking,
    setGuideCopilotModel,
  } = useAgentSettings();

  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  // Failure-recovery panel state (only relevant when `failure` is set — see
  // GuideScreen, which remounts this component fresh, keyed on jobId, for
  // each failed guide job so this state never leaks across failures).
  //
  // `capturedPayload` doubles as the probe result: null means "not yet probed,
  // or the server has nothing captured for this job" (404) — either way,
  // "Fix output" and the output editor stay hidden until it resolves to a
  // string.
  const [capturedPayload, setCapturedPayload] = useState<string | null>(null);
  const [editedPayload, setEditedPayload] = useState('');
  const [showOutput, setShowOutput] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!failure) return;
    let alive = true;
    fetch(`/api/guide/${encodeURIComponent(failure.jobId)}/output`)
      .then(async (res) => {
        if (!alive || !res.ok) return;
        const data = await res.json().catch(() => null);
        if (data && typeof data.payload === 'string') {
          setCapturedPayload(data.payload);
          setEditedPayload(data.payload);
        }
      })
      .catch(() => {
        // 404/network error ⇒ no captured output to offer — leave hidden.
      });
    return () => {
      alive = false;
    };
  }, [failure?.jobId]);

  const handleFixOutput = async () => {
    if (!failure || repairing) return;
    setRepairing(true);
    setLaunchError(null);
    try {
      await launchJob({
        provider: 'guide',
        label: 'Guide Repair',
        repairOf: failure.jobId,
        ...(failure.engine ? { engine: failure.engine } : {}),
      });
      // A successful launch lands as a new running guide job — GuideScreen's
      // existing running-job branch takes over from here automatically.
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : 'Could not start the repair.');
    } finally {
      setRepairing(false);
    }
  };

  const handleSubmitFixedOutput = async () => {
    if (!failure || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/guide/${encodeURIComponent(failure.jobId)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: editedPayload }),
      });
      if (res.ok) {
        onOpenFixedGuide?.(failure.jobId);
        return;
      }
      const data = await res.json().catch(() => ({}));
      setSubmitError(typeof data.error === 'string' ? data.error : 'Could not submit the fixed output.');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not submit the fixed output.');
    } finally {
      setSubmitting(false);
    }
  };

  const providerAvailable = (id: string) =>
    capabilities?.providers.some((p) => p.id === id && p.available) ?? false;
  const guideAvailable = providerAvailable('guide');
  const availableEngines = GUIDE_ENGINES.filter(providerAvailable);
  // A persisted engine can be unavailable on this machine — fall back to the
  // first available one rather than a dead selection.
  const engine: ReviewEngine = providerAvailable(guideEngine) ? guideEngine : (availableEngines[0] ?? guideEngine);

  // Marker model catalogs are discovered server-side and delivered on the
  // capability entry; fall back to the engine-default option until then.
  // Mirrors AgentsTab's per-engine catalog semantics exactly: opencode/pi
  // PREPEND their engine-managed "Default" ('' value) to the discovered list —
  // the discovered catalogs are real models only, and dropping Default left a
  // saved-default user with a blank pill and no way back after picking a
  // concrete model. Cursor REPLACES: its discovered list natively includes
  // 'auto', so prepending would duplicate it.
  const markerModels = (id: 'cursor' | 'opencode' | 'pi' | 'copilot', fallback: Option[]): Option[] => {
    const models = capabilities?.providers.find((p) => p.id === id)?.models;
    if (!models || models.length === 0) return fallback;
    const discovered = models.map((m) => ({ value: m.id, label: m.label }));
    return id === 'cursor' ? discovered : [...fallback, ...discovered];
  };

  // Compute each marker engine's catalog once so the picker and the launch
  // params below read the exact same lists.
  const cursorOptions = markerModels('cursor', CURSOR_FALLBACK);
  const opencodeOptions = markerModels('opencode', OPENCODE_FALLBACK);
  const piOptions = markerModels('pi', PI_FALLBACK);
  const copilotOptions = markerModels('copilot', COPILOT_FALLBACK);

  // AgentsTab reconciles the saved guide Cursor/OpenCode/Pi model back to the
  // catalog head via effects when the live catalog no longer contains it (see
  // AgentsTab.tsx's reconcile effects ~712-745, which snap both the review
  // AND guide fields against the same catalog). This launcher reads the same
  // persisted cookie values but is deliberately stateless — no effects, no
  // cookie writes — so instead of reconciling in the background, a stale
  // saved id is reconciled right here at read time: if it's not in the
  // current catalog, fall back to the catalog's first entry rather than
  // POSTing a dead model id to the server. ('' / Default is present in the
  // opencode/pi catalogs after the round-5 prepend fix, so a saved '' stays
  // valid and is never treated as stale.)
  const effectiveModel = (saved: string, options: Option[]): string =>
    options.some((o) => o.value === saved) ? saved : (options[0]?.value ?? saved);

  const effectiveCursorModel = effectiveModel(guideCursorModel, cursorOptions);
  const effectiveOpencodeModel = effectiveModel(guideOpencodeModel, opencodeOptions);
  const effectivePiModel = effectiveModel(guidePiModel, piOptions);
  const effectiveCopilotModel = effectiveModel(guideCopilotModel, copilotOptions);

  const modelPicker: { value: string; options: Option[]; onChange: (v: string) => void } =
    engine === 'claude'
      ? { value: guideClaudeModel, options: TOUR_CLAUDE_MODELS, onChange: setGuideClaudeModel }
      : engine === 'codex'
        ? { value: guideCodexModel, options: CODEX_MODELS, onChange: setGuideCodexModel }
        : engine === 'cursor'
          ? { value: effectiveCursorModel, options: cursorOptions, onChange: setGuideCursorModel }
          : engine === 'opencode'
            ? { value: effectiveOpencodeModel, options: opencodeOptions, onChange: setGuideOpencodeModel }
            : engine === 'copilot'
              ? { value: effectiveCopilotModel, options: copilotOptions, onChange: setGuideCopilotModel }
              : { value: effectivePiModel, options: piOptions, onChange: setGuidePiModel };

  const canLaunch = guideAvailable && availableEngines.length > 0 && !launching;

  const handleGenerate = async () => {
    if (!canLaunch) return;
    setLaunching(true);
    setLaunchError(null);
    // Config shapes mirror AgentsTab's buildGuideLaunch exactly — one shape
    // per engine, so the server sees identical launches from both surfaces.
    const params: AgentLaunchParams =
      engine === 'cursor'
        ? {
            provider: 'guide',
            label: 'Guided Review',
            engine: 'cursor',
            ...(effectiveCursorModel && effectiveCursorModel.toLowerCase() !== 'auto' ? { model: effectiveCursorModel } : {}),
          }
        : engine === 'opencode'
          ? {
              provider: 'guide',
              label: 'Guided Review',
              engine: 'opencode',
              ...(effectiveOpencodeModel ? { model: effectiveOpencodeModel } : {}),
            }
          : engine === 'pi'
            ? {
                provider: 'guide',
                label: 'Guided Review',
                engine: 'pi',
                ...(effectivePiModel ? { model: effectivePiModel } : {}),
                thinking: guidePiThinking,
              }
            : engine === 'copilot'
              ? {
                  provider: 'guide',
                  label: 'Guided Review',
                  engine: 'copilot',
                  ...(effectiveCopilotModel ? { model: effectiveCopilotModel } : {}),
                }
              : {
                provider: 'guide',
                label: 'Guided Review',
                engine,
                model: engine === 'claude' ? guideClaudeModel : guideCodexModel,
                ...(engine === 'claude'
                  ? { effort: guideClaudeEffort }
                  : { reasoningEffort: guideCodexReasoning }),
              };
    try {
      await launchJob(params);
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : 'Could not start the guide.');
    } finally {
      setLaunching(false);
    }
  };

  return (
    // Full-width page: this content sits in the header zone (where the guide
    // title lands once generated) rather than a centered island.
    <div className="w-full px-10 py-8">
      <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Start a guided review?</h1>
      <p className="mt-2 max-w-[72ch] text-[13px] leading-relaxed text-muted-foreground">
        Large changesets are hard to even start reading. A guide orders this one by
        importance — the core of the change first, glue and low-signal edits last — so
        you can understand it in one sitting. Each chapter tells you what changed, why
        it exists, and what it implies, right next to the diffs, ready to annotate.
      </p>

      {failure && (
        <div className="mt-6 max-w-[820px]">
          <div className="w-fit max-w-full rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs leading-snug text-destructive">
            {failure.error}
          </div>

          {capturedPayload !== null && (
            <div className="mt-2.5 flex items-center gap-3">
              <button
                type="button"
                onClick={handleFixOutput}
                disabled={repairing}
                className="rounded-md border border-border/50 px-2.5 py-1.5 text-[11.5px] font-medium text-foreground transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {repairing ? 'Starting repair…' : 'Fix output'}
              </button>
              <button
                type="button"
                onClick={() => setShowOutput((v) => !v)}
                aria-expanded={showOutput}
                className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[11.5px] text-muted-foreground/70 transition-colors hover:text-foreground"
              >
                <ChevronRight className={`transition-transform ${showOutput ? 'rotate-90' : ''}`} size={12} />
                {showOutput ? 'Hide output' : 'Show output'}
              </button>
            </div>
          )}

          {showOutput && capturedPayload !== null && (
            <div className="mt-2.5 w-full">
              <textarea
                value={editedPayload}
                onChange={(e) => setEditedPayload(e.target.value)}
                spellCheck={false}
                className="h-[320px] w-full resize-none overflow-y-auto rounded-md border border-border/50 bg-background p-2.5 font-mono text-[11px] leading-relaxed text-foreground outline-none focus:border-border"
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSubmitFixedOutput}
                  disabled={submitting}
                  className="rounded-md bg-primary px-3 py-1.5 text-[11.5px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? 'Submitting…' : 'Submit fixed output'}
                </button>
              </div>
              {submitError && <p className="mt-1.5 text-[11px] leading-snug text-destructive/80">{submitError}</p>}
            </div>
          )}
        </div>
      )}

      {!guideAvailable || availableEngines.length === 0 ? (
        <p className="mt-8 text-xs text-muted-foreground/70">
          Guided review needs an agent CLI (Claude, Codex, Cursor, OpenCode, Pi, or Copilot) available on this machine.
        </p>
      ) : (
        <>
          <div className="mt-6 w-fit max-w-full rounded-lg border border-border/50 bg-card/50 px-4 py-3.5">
            <div className="mb-2.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">
              Model defaults
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <InlinePicker
                label="Engine"
                value={engine}
                options={availableEngines.map((e) => ({ value: e, label: REVIEW_ENGINE_LABEL[e] }))}
                onChange={(v) => setGuideEngine(v as ReviewEngine)}
              />
              <InlinePicker label="Model" {...modelPicker} />
              {engine === 'claude' && (
                <InlinePicker label="Effort" value={guideClaudeEffort} options={CLAUDE_EFFORT} onChange={setGuideClaudeEffort} />
              )}
              {engine === 'codex' && (
                <InlinePicker label="Reasoning" value={guideCodexReasoning} options={CODEX_REASONING} onChange={setGuideCodexReasoning} />
              )}
              {engine === 'pi' && (
                <InlinePicker label="Thinking" value={guidePiThinking} options={PI_THINKING} onChange={setGuidePiThinking} />
              )}
            </div>
            <p className="mt-2.5 text-[11px] leading-snug text-muted-foreground/60">
              Newer models with lower effort are recommended — guides generate quicker.
            </p>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!canLaunch}
              className="rounded-md bg-primary px-4 py-2 text-[12.5px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {launching ? 'Starting…' : failure ? 'Regenerate guide' : 'Generate guide'}
            </button>
            <button
              type="button"
              onClick={onBack}
              className="rounded-md border border-border/50 px-3 py-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              Back to diff
            </button>
          </div>
          {launchError && <p className="mt-2 text-xs leading-snug text-destructive/80">{launchError}</p>}
        </>
      )}
    </div>
  );
};
