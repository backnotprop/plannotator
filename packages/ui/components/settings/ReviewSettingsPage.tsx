/**
 * Settings → Reviews: every setting about reading a review on one page, in
 * this order: Diff display, Semantic diffs, Power Up, Call flow, Package
 * changes, Files and defaults. It replaced classic code review's Review,
 * Editor, Semantic diffs and Analysis tabs; each setting keeps its storage key,
 * default and meaning.
 *
 * Host-neutral: the host passes the opinion settings route (Power Up's key and
 * provider) and the controls (`reviewSettingsControls.tsx`), so the Inbox can
 * draw the same page with its own section, row, switch and segmented control.
 * Every word is in `reviewSettingsWords.ts`.
 */
import React, { useEffect, useRef } from 'react';
import {
  configStore,
  useConfigValue,
  setReviewPanelView,
  setReviewDefaultDiffType,
  getProviderReviewDefaultDiffType,
  setProviderReviewDefaultDiffType,
  setReviewAutoViewed,
  type VcsReviewSettingsDescriptor,
} from '../../config';
import type { TokenHoverDelay } from '@plannotator/core/token-hover';
import type { PackageChangesSetting } from '../../hooks/usePackageChangesSetting';
import { loadDiffFont } from '../../utils/diffFonts';
import { monoFontStack, normalizeCssFontSize } from '../../utils/cssFontFamily';
import { DIFF_BACKGROUND_STRENGTH_OPTIONS, DIFF_CHANGE_MARK_OPTIONS, DIFF_CHANGED_WORDS_OPTIONS, DIFF_MINIMAP_OPTIONS } from '../DiffDisplayOptions';
import { FontFamilyField } from './FontFamilyField';
import { PowerUpRows, usePowerUpSettings } from './PowerUpSettings';
import type { ReviewSettingsControls, ReviewSettingsSectionId } from './reviewSettingsControls';
import {
  CALL_FLOW_WORDS,
  DEFAULT_DIFF_TYPE_OPTIONS,
  DIFF_FONT_OPTIONS,
  DISPLAY_WORDS,
  FILES_WORDS,
  FONT_WORDS,
  HOVER_WORDS,
  JJ_DEFAULT_DIFF_TYPE_OPTIONS,
  PACKAGE_WORDS,
  POWER_UP_WORDS,
  SECTION_WORDS,
  SEMANTIC_WORDS,
  TOKEN_HOVER_DELAY_OPTIONS,
  TOKEN_HOVER_TRIGGER_OPTIONS,
  powerUpDescription,
  type TokenHoverDelayOption,
} from './reviewSettingsWords';

export type { ReviewSettingsSectionId } from './reviewSettingsControls';

const JJ_REVIEW_DEFAULTS: VcsReviewSettingsDescriptor = {
  id: 'jj',
  label: FILES_WORDS.jj,
  defaultDiffType: 'jj-current',
  diffOptions: JJ_DEFAULT_DIFF_TYPE_OPTIONS.map(({ value, label, description }) => ({ id: value, label, description })),
};

export interface ReviewSettingsPageProps {
  controls: ReviewSettingsControls;
  /** The route that keeps Power Up's provider and key (GET, POST, DELETE). */
  opinionRoute: string;
  /** Package changes' switches (usePackageChangesSetting). Without it the section is not drawn. */
  packageChangesSetting?: PackageChangesSetting;
  /** This repository cannot group by git status (its base ref does not resolve): say so beside the global preference. */
  sinceBaseUnavailable?: boolean;
  /** A phone-sized review: diffs are unified for the session, so Split or Unified is not offered. */
  isCompactTouchLayout?: boolean;
  /** Scroll this section to the top when the page opens (an old tab's link). */
  initialSection?: ReviewSettingsSectionId;
}

function TabSizeStepper() {
  const tabSize = useConfigValue('diffTabSize');
  const step = (n: number) => configStore.set('diffTabSize', Math.max(1, Math.min(8, n)));
  const btn = 'h-6 px-2 text-xs rounded-[5px] text-muted-foreground hover:text-foreground hover:bg-background disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <div className="inline-flex items-center gap-px rounded-md bg-muted/60 p-px">
      <button type="button" onClick={() => step(tabSize - 1)} disabled={tabSize <= 1} aria-label={DISPLAY_WORDS.decreaseTabSize} className={btn}>−</button>
      <span className="w-6 text-center text-xs tabular-nums" data-diff-tab-size={tabSize}>{tabSize}</span>
      <button type="button" onClick={() => step(tabSize + 1)} disabled={tabSize >= 8} aria-label={DISPLAY_WORDS.increaseTabSize} className={btn}>+</button>
    </div>
  );
}

function CodeFontSize() {
  const diffFontSize = useConfigValue('diffFontSize');
  return (
    <div className="space-y-2 py-1">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">{FONT_WORDS.sizeLabel}</div>
          <div className="text-xs text-muted-foreground">{FONT_WORDS.sizeDescription}</div>
        </div>
        <div className="min-w-[4ch] text-right text-xs tabular-nums text-muted-foreground">
          {normalizeCssFontSize(diffFontSize) || FONT_WORDS.sizeAuto}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={8}
          max={24}
          step={1}
          aria-label={FONT_WORDS.sizeLabel}
          value={diffFontSize ? parseInt(diffFontSize) : 13}
          onChange={(e) => configStore.set('diffFontSize', `${e.target.value}px`)}
          className="h-1.5 flex-1 cursor-pointer accent-primary"
        />
        {diffFontSize && (
          <button
            type="button"
            onClick={() => configStore.set('diffFontSize', '')}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {FONT_WORDS.sizeReset}
          </button>
        )}
      </div>
    </div>
  );
}

function DefaultDiffSelect<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string; description: string }>;
  value: string;
  onChange: (value: T) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="h-8 w-auto max-w-full rounded-md border border-border bg-muted/50 px-2 text-sm text-foreground"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}

function describe<T extends string>(options: ReadonlyArray<{ value: T; description: string }>, value: string): string | undefined {
  return options.find((opt) => opt.value === value)?.description;
}

function DiffDisplaySection({ controls, isCompactTouchLayout }: { controls: ReviewSettingsControls; isCompactTouchLayout: boolean }) {
  const { Section, Row, Switch, Segmented } = controls;
  const diffStyle = useConfigValue('diffStyle');
  const overflow = useConfigValue('diffOverflow');
  const showLineNumbers = useConfigValue('diffShowLineNumbers');
  const showBackground = useConfigValue('diffShowBackground');
  const intensity = useConfigValue('diffLineBgIntensity');
  const minimap = useConfigValue('diffMinimap');
  const indicators = useConfigValue('diffIndicators');
  const lineDiffType = useConfigValue('diffLineDiffType');
  const expandUnchanged = useConfigValue('diffExpandUnchanged');
  const hideWhitespace = useConfigValue('diffHideWhitespace');
  const diffFontFamily = useConfigValue('diffFontFamily');
  const tokenHoverTrigger = useConfigValue('tokenHoverTrigger');
  const tokenHoverDelay = useConfigValue('tokenHoverDelay');
  return (
    <Section
      id="display"
      first
      title={SECTION_WORDS.display.title}
      description={isCompactTouchLayout ? SECTION_WORDS.display.compactDescription : SECTION_WORDS.display.description}
    >
      {!isCompactTouchLayout && (
        <Row title={DISPLAY_WORDS.layout}>
          <Segmented label={DISPLAY_WORDS.layout} value={diffStyle} options={DISPLAY_WORDS.layoutOptions} onChange={(v) => configStore.set('diffStyle', v)} />
        </Row>
      )}
      <Switch label={DISPLAY_WORDS.wrap} checked={overflow === 'wrap'} onChange={(v) => configStore.set('diffOverflow', v ? 'wrap' : 'scroll')} />
      <Switch label={DISPLAY_WORDS.lineNumbers} checked={showLineNumbers} onChange={(v) => configStore.set('diffShowLineNumbers', v)} />
      <Switch label={DISPLAY_WORDS.backgrounds} checked={showBackground} onChange={(v) => configStore.set('diffShowBackground', v)} />
      {showBackground && (
        <Row title={DISPLAY_WORDS.backgroundStrength}>
          <Segmented label={DISPLAY_WORDS.backgroundStrength} value={intensity} options={DIFF_BACKGROUND_STRENGTH_OPTIONS} onChange={(v) => configStore.set('diffLineBgIntensity', v)} />
        </Row>
      )}
      <Row title={DISPLAY_WORDS.changeMarks}>
        <Segmented label={DISPLAY_WORDS.changeMarks} value={indicators} options={DIFF_CHANGE_MARK_OPTIONS} onChange={(v) => configStore.set('diffIndicators', v)} />
      </Row>
      <Row title={DISPLAY_WORDS.changedWords}>
        <Segmented label={DISPLAY_WORDS.changedWords} value={lineDiffType} options={DIFF_CHANGED_WORDS_OPTIONS} onChange={(v) => configStore.set('diffLineDiffType', v)} />
      </Row>
      <Row title={DISPLAY_WORDS.minimap}>
        <Segmented label={DISPLAY_WORDS.minimap} value={minimap} options={DIFF_MINIMAP_OPTIONS} onChange={(v) => configStore.set('diffMinimap', v)} />
      </Row>
      <Row title={DISPLAY_WORDS.tabSize}>
        <TabSizeStepper />
      </Row>
      <Switch label={DISPLAY_WORDS.wholeFile} checked={expandUnchanged} onChange={(v) => configStore.set('diffExpandUnchanged', v)} />
      <Switch label={DISPLAY_WORDS.hideWhitespace} checked={hideWhitespace} onChange={(v) => configStore.set('diffHideWhitespace', v)} />
      <div className="py-1">
        <FontFamilyField
          label={FONT_WORDS.label}
          description={FONT_WORDS.description}
          value={diffFontFamily}
          onSave={(v) => configStore.set('diffFontFamily', v)}
          options={DIFF_FONT_OPTIONS}
          previewStack={monoFontStack}
          previewText={FONT_WORDS.previewText}
          customAriaLabel={FONT_WORDS.customAriaLabel}
          customPlaceholder={FONT_WORDS.customPlaceholder}
          notFoundText={FONT_WORDS.notFoundText}
          loadFont={loadDiffFont}
          previewClassName="font-mono"
        />
      </div>
      <CodeFontSize />
      {/* Hover cards (internally tokenHover*): one trigger choice rather than a
          toggle plus a mode, since Off is a value of the same question; the
          delay stays its own row because "too eager" is a complaint neither
          the hold-modifier option nor Off answers. */}
      <Row title={HOVER_WORDS.label} hint={HOVER_WORDS.description}>
        <Segmented label={HOVER_WORDS.label} value={tokenHoverTrigger} options={TOKEN_HOVER_TRIGGER_OPTIONS} onChange={(v) => configStore.set('tokenHoverTrigger', v)} />
      </Row>
      <Row title={HOVER_WORDS.delay}>
        <Segmented
          label={HOVER_WORDS.delay}
          value={String(tokenHoverDelay) as TokenHoverDelayOption}
          options={TOKEN_HOVER_DELAY_OPTIONS}
          onChange={(v) => configStore.set('tokenHoverDelay', Number(v) as TokenHoverDelay)}
          disabled={tokenHoverTrigger === 'off'}
        />
      </Row>
    </Section>
  );
}

function FilesSection({ controls, sinceBaseUnavailable }: { controls: ReviewSettingsControls; sinceBaseUnavailable: boolean }) {
  const { Section, Row, Switch, Segmented } = controls;
  const reviewAutoViewed = useConfigValue('reviewAutoViewed');
  const reviewPanelView = useConfigValue('reviewPanelView');
  const defaultDiffType = useConfigValue('defaultDiffType');
  useConfigValue('reviewDefaults');
  const jjDefaultDiffType = getProviderReviewDefaultDiffType(JJ_REVIEW_DEFAULTS);
  const groupLabel = 'pt-2 text-xs font-medium text-muted-foreground';
  return (
    <Section id="files" title={SECTION_WORDS.files.title}>
      {/* Never write `reviewAutoViewed` directly — setReviewAutoViewed also
          consumes the first-time notice, since an explicit toggle is proof
          the reviewer already found the switch. */}
      <Switch
        label={FILES_WORDS.autoViewed}
        description={FILES_WORDS.autoViewedDescription}
        checked={reviewAutoViewed}
        onChange={(v) => setReviewAutoViewed(v)}
      />
      <section aria-labelledby="settings-review-git">
        <div id="settings-review-git" className={groupLabel}>{FILES_WORDS.git}</div>
        {/* A GLOBAL preference: never hide the options because the CURRENT
            repo can't serve them; just say so. */}
        <Row
          title={FILES_WORDS.grouping}
          hint={
            <>
              {FILES_WORDS.groupingDescription}
              {sinceBaseUnavailable && <span className="mt-1 block text-warning">{FILES_WORDS.groupingUnavailable}</span>}
            </>
          }
        >
          {/* No Commits option: the Commits view is session-only. */}
          <Segmented label={FILES_WORDS.grouping} value={reviewPanelView} options={FILES_WORDS.groupingOptions} onChange={setReviewPanelView} />
        </Row>
        <Row
          title={FILES_WORDS.diffView}
          hint={<>{FILES_WORDS.diffViewDescription}<span className="mt-1 block" data-default-diff-description="git">{describe(DEFAULT_DIFF_TYPE_OPTIONS, defaultDiffType)}</span></>}
        >
          {/* Coupling (sections ⟺ since-base) lives in the shared setter —
              never write the pair by hand (see config/reviewView). */}
          <DefaultDiffSelect
            label={FILES_WORDS.gitDiffViewAria}
            options={DEFAULT_DIFF_TYPE_OPTIONS}
            value={defaultDiffType}
            onChange={(value) => setReviewDefaultDiffType(value)}
          />
        </Row>
      </section>
      <section aria-labelledby="settings-review-jj">
        <div id="settings-review-jj" className={groupLabel}>{FILES_WORDS.jj}</div>
        <Row
          title={FILES_WORDS.diffView}
          hint={<>{FILES_WORDS.jjDiffViewDescription}<span className="mt-1 block" data-default-diff-description="jj">{describe(JJ_DEFAULT_DIFF_TYPE_OPTIONS, jjDefaultDiffType)}</span></>}
        >
          {/* Its own saved value: Git modes mean nothing in a jj repo, and jj has
              no Git status view, so nothing here is coupled to the Git half. */}
          <DefaultDiffSelect
            label={FILES_WORDS.jjDiffViewAria}
            options={JJ_DEFAULT_DIFF_TYPE_OPTIONS}
            value={jjDefaultDiffType}
            onChange={(value) => setProviderReviewDefaultDiffType('jj', value)}
          />
        </Row>
      </section>
    </Section>
  );
}

export function ReviewSettingsPage({
  controls,
  opinionRoute,
  packageChangesSetting,
  sinceBaseUnavailable = false,
  isCompactTouchLayout = false,
  initialSection,
}: ReviewSettingsPageProps) {
  const { Section, Switch } = controls;
  const semanticDiffEnabled = useConfigValue('semanticDiffEnabled');
  const semantic = useConfigValue('diffSemantic');
  const callFlowEnabled = useConfigValue('callFlowEnabled');
  const powerUp = useConfigValue('diffPowerUp');
  const motion = useConfigValue('diffPowerUpMotion');
  const powerUpState = usePowerUpSettings(opinionRoute);
  const { configured } = powerUpState;
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!initialSection) return;
    const target = rootRef.current?.querySelector<HTMLElement>(`[data-review-settings-section="${initialSection}"]`);
    target?.scrollIntoView?.({ block: 'start' });
  }, [initialSection]);

  return (
    <div ref={rootRef} className="space-y-4" data-review-settings="">
      <div data-review-settings-section="display">
        <DiffDisplaySection controls={controls} isCompactTouchLayout={isCompactTouchLayout} />
      </div>

      <div data-review-settings-section="semantic" data-semantic-diffs-settings="">
        <Section id="semantic" title={SECTION_WORDS.semantic.title} description={SECTION_WORDS.semantic.description}>
          <Switch
            label={SEMANTIC_WORDS.master}
            description={SEMANTIC_WORDS.masterDescription}
            checked={semanticDiffEnabled}
            onChange={(on) => configStore.set('semanticDiffEnabled', on)}
          />
          {/* Off hides what depends on it: the moved-code switch here and Power Up below. */}
          {semanticDiffEnabled && (
            <Switch
              label={SEMANTIC_WORDS.moved}
              description={SEMANTIC_WORDS.movedDescription}
              checked={semantic}
              onChange={(on) => configStore.set('diffSemantic', on)}
            />
          )}
        </Section>
      </div>

      {semanticDiffEnabled && (
        <div data-review-settings-section="powerUp" data-power-up-settings="">
          <Section
            id="powerUp"
            title={POWER_UP_WORDS.label}
            toggle={{
              checked: powerUp && configured,
              disabled: !configured || !semantic,
              onChange: (on) => configStore.set('diffPowerUp', on),
              description: powerUpDescription(configured),
            }}
          >
            <PowerUpRows state={powerUpState} motion={motion} controls={controls} />
          </Section>
        </div>
      )}

      <div data-review-settings-section="callFlow">
        <Section
          id="callFlow"
          title={CALL_FLOW_WORDS.label}
          toggle={{
            checked: callFlowEnabled,
            onChange: (on) => configStore.set('callFlowEnabled', on),
            description: SECTION_WORDS.callFlow.description,
          }}
        >
          <p className="text-xs leading-relaxed text-muted-foreground">{SECTION_WORDS.callFlow.note}</p>
        </Section>
      </div>

      {packageChangesSetting && (
        <div data-review-settings-section="packages">
          <Section
            id="packages"
            title={PACKAGE_WORDS.card}
            toggle={{
              checked: packageChangesSetting.card,
              onChange: (on) => packageChangesSetting.setCard(on),
              description: SECTION_WORDS.packages.description,
            }}
          >
            <Switch
              label={PACKAGE_WORDS.lookup}
              checked={packageChangesSetting.lookup}
              onChange={(on) => void packageChangesSetting.setLookup(on)}
              disabled={packageChangesSetting.lookupEnv === false}
              description={packageChangesSetting.lookupEnv === false ? PACKAGE_WORDS.lookupEnvOff : PACKAGE_WORDS.lookupDescription}
            />
          </Section>
        </div>
      )}

      <div data-review-settings-section="files">
        <FilesSection controls={controls} sinceBaseUnavailable={sinceBaseUnavailable} />
      </div>
    </div>
  );
}
