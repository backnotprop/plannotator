/**
 * Settings → Reviews: every setting about reading a review on one page, in
 * this order: Diff display, Semantic diffs, Power Up, Call flow, Package
 * changes, Files and defaults. It replaced classic code review's Review,
 * Editor, Semantic diffs and Analysis tabs; each setting keeps its storage key,
 * default and meaning.
 *
 * Host-neutral, so the Inbox can draw the same page:
 * - `controls`: every control the page draws (`reviewSettingsControls.tsx`);
 *   the page styles none itself.
 * - `onChange`: every setting the page writes goes through it (default: the
 *   config store), like the diff gear's `onChange`.
 * - `rows`: the rows a host cannot honour are left out (Hide whitespace,
 *   Minimap, Hover cards, the Git and Jujutsu defaults, Auto-mark viewed,
 *   Call flow).
 * - `opinionRoute`: where Power Up's key and provider are kept. It is read
 *   when the Power Up section first comes on screen, not on every open.
 *   `opinionFetch` sends its requests (the Inbox adds its page session to a
 *   key write).
 * Every word is in `reviewSettingsWords.ts`.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { DIFF_TAB_SIZE_MAX, DIFF_TAB_SIZE_MIN, clampDiffTabSize, offersBackgroundStrength } from '../diffDisplayModel';
import { FontFamilyField } from './FontFamilyField';
import { PowerUpRows, usePowerUpSettings, type OpinionFetch } from './PowerUpSettings';
import {
  writeReviewSettingToStore,
  type ReviewSettingChange,
  type ReviewSettingsControls,
  type ReviewSettingsRows,
  type ReviewSettingsSectionId,
} from './reviewSettingsControls';
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

export type { ReviewSettingChange, ReviewSettingsRows, ReviewSettingsSectionId } from './reviewSettingsControls';

const JJ_REVIEW_DEFAULTS: VcsReviewSettingsDescriptor = {
  id: 'jj',
  label: FILES_WORDS.jj,
  defaultDiffType: 'jj-current',
  diffOptions: JJ_DEFAULT_DIFF_TYPE_OPTIONS.map(({ value, label, description }) => ({ id: value, label, description })),
};

const ALL_ROWS: ReviewSettingsRows = { hideWhitespace: true, minimap: true, hoverCards: true, defaultDiffViews: true, autoViewed: true, callFlow: true };

export interface ReviewSettingsPageProps {
  controls: ReviewSettingsControls;
  /** The route that keeps Power Up's provider and key (GET, POST, DELETE). */
  opinionRoute: string;
  /** Sends the requests to `opinionRoute`. Default: the window's fetch. */
  opinionFetch?: OpinionFetch;
  /** Writes one setting. Default: the config store's `set`. */
  onChange?: ReviewSettingChange;
  /** Rows this host can honour; each defaults to shown. */
  rows?: Partial<ReviewSettingsRows>;
  /** Package changes' switches (usePackageChangesSetting). Without it the section is not drawn. */
  packageChangesSetting?: PackageChangesSetting;
  /** This repository cannot group by git status (its base ref does not resolve): say so beside the global preference. */
  sinceBaseUnavailable?: boolean;
  /** A phone-sized review: diffs are unified for the session, so Split or Unified is not offered. */
  isCompactTouchLayout?: boolean;
  /** Scroll this section to the top when the page opens (an outside link). */
  initialSection?: ReviewSettingsSectionId;
}

function describe<T extends string>(options: ReadonlyArray<{ value: T; description: string }>, value: string): string | undefined {
  return options.find((opt) => opt.value === value)?.description;
}

/** True from the first time the element comes near the screen (always true without IntersectionObserver). */
function useShownOnce(ref: React.RefObject<HTMLElement | null>): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (shown) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setShown(true);
        observer.disconnect();
      }
    }, { rootMargin: '200px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, shown]);
  return shown;
}

function DiffDisplaySection({ controls, set, rows, isCompactTouchLayout }: {
  controls: ReviewSettingsControls;
  set: ReviewSettingChange;
  rows: ReviewSettingsRows;
  isCompactTouchLayout: boolean;
}) {
  const { Section, Row, Switch, Segmented, Stepper, Slider } = controls;
  const diffStyle = useConfigValue('diffStyle');
  const overflow = useConfigValue('diffOverflow');
  const showLineNumbers = useConfigValue('diffShowLineNumbers');
  const showBackground = useConfigValue('diffShowBackground');
  const intensity = useConfigValue('diffLineBgIntensity');
  const minimap = useConfigValue('diffMinimap');
  const indicators = useConfigValue('diffIndicators');
  const lineDiffType = useConfigValue('diffLineDiffType');
  const tabSize = useConfigValue('diffTabSize');
  const expandUnchanged = useConfigValue('diffExpandUnchanged');
  const hideWhitespace = useConfigValue('diffHideWhitespace');
  const diffFontFamily = useConfigValue('diffFontFamily');
  const diffFontSize = useConfigValue('diffFontSize');
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
          <Segmented label={DISPLAY_WORDS.layout} value={diffStyle} options={DISPLAY_WORDS.layoutOptions} onChange={(v) => set('diffStyle', v)} />
        </Row>
      )}
      <Switch label={DISPLAY_WORDS.wrap} checked={overflow === 'wrap'} onChange={(v) => set('diffOverflow', v ? 'wrap' : 'scroll')} />
      <Switch label={DISPLAY_WORDS.lineNumbers} checked={showLineNumbers} onChange={(v) => set('diffShowLineNumbers', v)} />
      <Switch label={DISPLAY_WORDS.backgrounds} checked={showBackground} onChange={(v) => set('diffShowBackground', v)} />
      {offersBackgroundStrength(showBackground) && (
        <Row title={DISPLAY_WORDS.backgroundStrength}>
          <Segmented label={DISPLAY_WORDS.backgroundStrength} value={intensity} options={DIFF_BACKGROUND_STRENGTH_OPTIONS} onChange={(v) => set('diffLineBgIntensity', v)} />
        </Row>
      )}
      <Row title={DISPLAY_WORDS.changeMarks}>
        <Segmented label={DISPLAY_WORDS.changeMarks} value={indicators} options={DIFF_CHANGE_MARK_OPTIONS} onChange={(v) => set('diffIndicators', v)} />
      </Row>
      <Row title={DISPLAY_WORDS.changedWords}>
        <Segmented label={DISPLAY_WORDS.changedWords} value={lineDiffType} options={DIFF_CHANGED_WORDS_OPTIONS} onChange={(v) => set('diffLineDiffType', v)} />
      </Row>
      {rows.minimap && (
        <Row title={DISPLAY_WORDS.minimap}>
          <Segmented label={DISPLAY_WORDS.minimap} value={minimap} options={DIFF_MINIMAP_OPTIONS} onChange={(v) => set('diffMinimap', v)} />
        </Row>
      )}
      <Row title={DISPLAY_WORDS.tabSize}>
        <Stepper
          label={DISPLAY_WORDS.tabSize}
          value={tabSize}
          min={DIFF_TAB_SIZE_MIN}
          max={DIFF_TAB_SIZE_MAX}
          onChange={(n) => set('diffTabSize', clampDiffTabSize(n))}
          decreaseLabel={DISPLAY_WORDS.decreaseTabSize}
          increaseLabel={DISPLAY_WORDS.increaseTabSize}
        />
      </Row>
      <Switch label={DISPLAY_WORDS.wholeFile} checked={expandUnchanged} onChange={(v) => set('diffExpandUnchanged', v)} />
      {rows.hideWhitespace && (
        <Switch label={DISPLAY_WORDS.hideWhitespace} checked={hideWhitespace} onChange={(v) => set('diffHideWhitespace', v)} />
      )}
      <Row wide title={FONT_WORDS.label} hint={FONT_WORDS.description}>
        <FontFamilyField
          showLabel={false}
          controls={controls}
          label={FONT_WORDS.label}
          value={diffFontFamily}
          onSave={(v) => set('diffFontFamily', v)}
          options={DIFF_FONT_OPTIONS}
          previewStack={monoFontStack}
          previewText={FONT_WORDS.previewText}
          customAriaLabel={FONT_WORDS.customAriaLabel}
          customPlaceholder={FONT_WORDS.customPlaceholder}
          notFoundText={FONT_WORDS.notFoundText}
          loadFont={loadDiffFont}
          previewClassName="font-mono"
        />
      </Row>
      <Row wide title={FONT_WORDS.sizeLabel} hint={FONT_WORDS.sizeDescription}>
        <Slider
          label={FONT_WORDS.sizeLabel}
          min={8}
          max={24}
          value={diffFontSize ? parseInt(diffFontSize) : 13}
          onChange={(n) => set('diffFontSize', `${n}px`)}
          valueText={normalizeCssFontSize(diffFontSize) || FONT_WORDS.sizeAuto}
          reset={diffFontSize ? { label: FONT_WORDS.sizeReset, onReset: () => set('diffFontSize', '') } : undefined}
        />
      </Row>
      {/* Hover cards (internally tokenHover*): one trigger choice rather than a
          toggle plus a mode, since Off is a value of the same question; the
          delay stays its own row because "too eager" is a complaint neither
          the hold-modifier option nor Off answers. */}
      {rows.hoverCards && (
        <>
          <Row title={HOVER_WORDS.label} hint={HOVER_WORDS.description}>
            <Segmented label={HOVER_WORDS.label} value={tokenHoverTrigger} options={TOKEN_HOVER_TRIGGER_OPTIONS} onChange={(v) => set('tokenHoverTrigger', v)} />
          </Row>
          <Row title={HOVER_WORDS.delay}>
            <Segmented
              label={HOVER_WORDS.delay}
              value={String(tokenHoverDelay) as TokenHoverDelayOption}
              options={TOKEN_HOVER_DELAY_OPTIONS}
              onChange={(v) => set('tokenHoverDelay', Number(v) as TokenHoverDelay)}
              disabled={tokenHoverTrigger === 'off'}
            />
          </Row>
        </>
      )}
    </Section>
  );
}

/** Show moved & renamed code. While Semantic changes is off it stays, greyed, and says why. */
export function MovedCodeSwitch({ controls, onChange = writeReviewSettingToStore }: { controls: ReviewSettingsControls; onChange?: ReviewSettingChange }) {
  const { Switch } = controls;
  const semanticDiffEnabled = useConfigValue('semanticDiffEnabled');
  const semantic = useConfigValue('diffSemantic');
  return (
    <Switch
      label={SEMANTIC_WORDS.moved}
      description={semanticDiffEnabled ? SEMANTIC_WORDS.movedDescription : SEMANTIC_WORDS.offWhileMasterOff}
      checked={semantic && semanticDiffEnabled}
      disabled={!semanticDiffEnabled}
      onChange={(on) => onChange('diffSemantic', on)}
    />
  );
}

/**
 * Power Up: its switch is the section's title; the provider and key form
 * under it stays usable while the switch is greyed, so a key can be added or
 * removed with Semantic changes off.
 */
export function PowerUpSection({ controls, opinionRoute, opinionFetch, load = true, onChange = writeReviewSettingToStore }: {
  controls: ReviewSettingsControls;
  opinionRoute: string;
  /** Sends the requests to `opinionRoute`. Default: the window's fetch. */
  opinionFetch?: OpinionFetch;
  /** Read the opinion route now (false until the section is on screen). */
  load?: boolean;
  onChange?: ReviewSettingChange;
}) {
  const { Section } = controls;
  const semanticDiffEnabled = useConfigValue('semanticDiffEnabled');
  const semantic = useConfigValue('diffSemantic');
  const powerUp = useConfigValue('diffPowerUp');
  const motion = useConfigValue('diffPowerUpMotion');
  const state = usePowerUpSettings(opinionRoute, { load, onChange, fetch: opinionFetch });
  const { configured } = state;
  // A greyed switch shows off, like Show moved & renamed code; the saved choice is kept.
  const disabled = !configured || !semantic || !semanticDiffEnabled;
  return (
    <Section
      id="powerUp"
      title={POWER_UP_WORDS.label}
      toggle={{
        checked: powerUp && !disabled,
        disabled,
        onChange: (on) => onChange('diffPowerUp', on),
        description: semanticDiffEnabled ? powerUpDescription(configured) : SEMANTIC_WORDS.offWhileMasterOff,
      }}
    >
      <PowerUpRows state={state} motion={motion} controls={controls} onChange={onChange} />
    </Section>
  );
}

function FilesSection({ controls, set, rows, sinceBaseUnavailable }: {
  controls: ReviewSettingsControls;
  set: ReviewSettingChange;
  rows: ReviewSettingsRows;
  sinceBaseUnavailable: boolean;
}) {
  const { Section, Row, Group, Switch, Segmented, Select, Note } = controls;
  const reviewAutoViewed = useConfigValue('reviewAutoViewed');
  const reviewPanelView = useConfigValue('reviewPanelView');
  const defaultDiffType = useConfigValue('defaultDiffType');
  useConfigValue('reviewDefaults');
  // The coupled setters (config/reviewView) write through the host's writer too.
  const store = useMemo(() => ({ get: configStore.get.bind(configStore), set }), [set]);
  const jjDefaultDiffType = getProviderReviewDefaultDiffType(JJ_REVIEW_DEFAULTS, store);
  return (
    <Section id="files" title={SECTION_WORDS.files.title}>
      {/* Never write `reviewAutoViewed` directly — setReviewAutoViewed also
          consumes the first-time notice, since an explicit toggle is proof
          the reviewer already found the switch. */}
      {rows.autoViewed && (
        <Switch
          label={FILES_WORDS.autoViewed}
          description={FILES_WORDS.autoViewedDescription}
          checked={reviewAutoViewed}
          onChange={(v) => setReviewAutoViewed(v, store)}
        />
      )}
      {rows.defaultDiffViews && (
        <>
          <Group id="git" title={FILES_WORDS.git}>
            {/* A GLOBAL preference: never hide the options because the CURRENT
                repo can't serve them; just say so. */}
            <Row
              title={FILES_WORDS.grouping}
              hint={
                <>
                  {FILES_WORDS.groupingDescription}
                  {sinceBaseUnavailable && <Note tone="warning">{FILES_WORDS.groupingUnavailable}</Note>}
                </>
              }
            >
              {/* No Commits option: the Commits view is session-only. */}
              <Segmented label={FILES_WORDS.grouping} value={reviewPanelView} options={FILES_WORDS.groupingOptions} onChange={(v) => setReviewPanelView(v, undefined, store)} />
            </Row>
            <Row
              title={FILES_WORDS.diffView}
              hint={<>{FILES_WORDS.diffViewDescription}<span className="mt-1 block" data-default-diff-description="git">{describe(DEFAULT_DIFF_TYPE_OPTIONS, defaultDiffType)}</span></>}
            >
              {/* Coupling (sections ⟺ since-base) lives in the shared setter —
                  never write the pair by hand (see config/reviewView). */}
              <Select
                label={FILES_WORDS.gitDiffViewAria}
                options={DEFAULT_DIFF_TYPE_OPTIONS}
                value={defaultDiffType}
                onChange={(value) => setReviewDefaultDiffType(value, store)}
              />
            </Row>
          </Group>
          <Group id="jj" title={FILES_WORDS.jj}>
            <Row
              title={FILES_WORDS.diffView}
              hint={<>{FILES_WORDS.jjDiffViewDescription}<span className="mt-1 block" data-default-diff-description="jj">{describe(JJ_DEFAULT_DIFF_TYPE_OPTIONS, jjDefaultDiffType)}</span></>}
            >
              {/* Its own saved value: Git modes mean nothing in a jj repo, and jj has
                  no Git status view, so nothing here is coupled to the Git half. */}
              <Select
                label={FILES_WORDS.jjDiffViewAria}
                options={JJ_DEFAULT_DIFF_TYPE_OPTIONS}
                value={jjDefaultDiffType}
                onChange={(value) => setProviderReviewDefaultDiffType('jj', value, store)}
              />
            </Row>
          </Group>
        </>
      )}
    </Section>
  );
}

export function ReviewSettingsPage({
  controls,
  opinionRoute,
  opinionFetch,
  onChange = writeReviewSettingToStore,
  rows,
  packageChangesSetting,
  sinceBaseUnavailable = false,
  isCompactTouchLayout = false,
  initialSection,
}: ReviewSettingsPageProps) {
  const { Section, Note } = controls;
  const set = onChange;
  const shownRows = useMemo<ReviewSettingsRows>(() => ({ ...ALL_ROWS, ...rows }), [rows]);
  const semanticDiffEnabled = useConfigValue('semanticDiffEnabled');
  const callFlowEnabled = useConfigValue('callFlowEnabled');
  const rootRef = useRef<HTMLDivElement>(null);
  const powerUpRef = useRef<HTMLDivElement>(null);
  const powerUpShown = useShownOnce(powerUpRef);

  useEffect(() => {
    if (!initialSection) return;
    const target = rootRef.current?.querySelector<HTMLElement>(`[data-review-settings-section="${initialSection}"]`);
    target?.scrollIntoView?.({ block: 'start' });
  }, [initialSection]);

  return (
    <div ref={rootRef} className="space-y-4" data-review-settings="">
      <div data-review-settings-section="display">
        <DiffDisplaySection controls={controls} set={set} rows={shownRows} isCompactTouchLayout={isCompactTouchLayout} />
      </div>

      <div data-review-settings-section="semantic" data-semantic-diffs-settings="">
        <Section
          id="semantic"
          title={SEMANTIC_WORDS.master}
          toggle={{
            checked: semanticDiffEnabled,
            onChange: (on) => set('semanticDiffEnabled', on),
            description: SEMANTIC_WORDS.masterDescription,
          }}
        >
          <MovedCodeSwitch controls={controls} onChange={set} />
        </Section>
      </div>

      <div ref={powerUpRef} data-review-settings-section="powerUp" data-power-up-settings="">
        <PowerUpSection controls={controls} opinionRoute={opinionRoute} opinionFetch={opinionFetch} load={powerUpShown} onChange={set} />
      </div>

      {shownRows.callFlow && (
        <div data-review-settings-section="callFlow">
          <Section
            id="callFlow"
            title={CALL_FLOW_WORDS.label}
            toggle={{
              checked: callFlowEnabled,
              onChange: (on) => set('callFlowEnabled', on),
              description: SECTION_WORDS.callFlow.description,
            }}
          >
            <Note>{SECTION_WORDS.callFlow.note}</Note>
          </Section>
        </div>
      )}

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
            <controls.Switch
              label={PACKAGE_WORDS.lookup}
              checked={packageChangesSetting.lookup}
              onChange={(on) => void packageChangesSetting.setLookup(on)}
              disabled={packageChangesSetting.lookupEnv === false}
              description={packageChangesSetting.lookupEnv === false ? PACKAGE_WORDS.lookupEnvOff : PACKAGE_WORDS.lookupDescription}
            />
          </Section>
        </div>
      )}

      {(shownRows.autoViewed || shownRows.defaultDiffViews) && (
        <div data-review-settings-section="files">
          <FilesSection controls={controls} set={set} rows={shownRows} sinceBaseUnavailable={sinceBaseUnavailable} />
        </div>
      )}
    </div>
  );
}
