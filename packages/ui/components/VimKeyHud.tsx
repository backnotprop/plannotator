import { EyeOff } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { InputMethod } from '../types';
import {
  getVimHudLegendGroups,
  isVimHudLegendGroupActive,
  type VimHudCommand,
  type VimHudLegendGroup,
  type VimHudLegendGroupId,
  type VimHudPhase,
} from '../utils/vimHud';

const HUD_MONO_FONT = '"SFMono-Regular", "JetBrains Mono", Menlo, var(--font-mono), monospace';
// Match the seven-frame pressed state in the 30fps product-demo HUD.
const PRESSED_DURATION_MS = (7 / 30) * 1000;
const KEY_MAP_COLUMNS: readonly (readonly VimHudLegendGroupId[])[] = [
  ['structure', 'control'],
  ['text'],
  ['selection', 'annotation'],
];
const KEY_MAP_GROUPS = getVimHudLegendGroups();

interface PreviousKeyProps {
  readonly keyLabel: string;
  readonly opacity: number;
}

function PreviousKey({ keyLabel, opacity }: PreviousKeyProps) {
  return (
    <div
      data-vim-hud-previous-key={keyLabel}
      style={{
        width: 34,
        height: 34,
        display: 'grid',
        flex: '0 0 auto',
        placeItems: 'center',
        borderRadius: 9,
        color: '#cfc8dc',
        background: 'rgba(26,24,34,0.9)',
        border: '1px solid rgba(255,255,255,0.09)',
        borderBottom: '3px solid rgba(0,0,0,0.72)',
        opacity,
        fontFamily: HUD_MONO_FONT,
        fontSize: keyLabel.length > 1 ? 9 : 14,
        fontWeight: 850,
      }}
    >
      {keyLabel}
    </div>
  );
}

interface ActiveKeyProps {
  readonly keyLabel: string;
  readonly pressed: boolean;
}

function ActiveKey({ keyLabel, pressed }: ActiveKeyProps) {
  return (
    <div
      data-vim-hud-active-key={keyLabel}
      data-pressed={pressed ? 'true' : 'false'}
      style={{
        width: 58,
        height: 58,
        display: 'grid',
        flex: '0 0 auto',
        placeItems: 'center',
        borderRadius: 14,
        color: pressed ? '#1b1427' : '#f5f0ff',
        background: pressed
          ? 'linear-gradient(180deg, #eee9ff, #a78bfa)'
          : 'linear-gradient(180deg, #292535, #15121d)',
        border: pressed
          ? '1px solid rgba(255,255,255,0.92)'
          : '1px solid rgba(196,181,253,0.34)',
        borderBottom: pressed
          ? '4px solid #6750a4'
          : '4px solid rgba(0,0,0,0.82)',
        boxShadow: pressed
          ? '0 0 32px rgba(167,139,250,0.72), 0 8px 24px rgba(0,0,0,0.42)'
          : '0 0 20px rgba(167,139,250,0.17), 0 8px 24px rgba(0,0,0,0.42)',
        fontFamily: HUD_MONO_FONT,
        fontSize: keyLabel.length > 1 ? 13 : 29,
        fontWeight: 900,
      }}
    >
      {keyLabel}
    </div>
  );
}

interface VimKeyMapGroupProps {
  readonly group: VimHudLegendGroup;
  readonly phase: VimHudPhase;
  readonly activeActionId: VimHudCommand['actionId'] | null;
}

function VimKeyMapGroup({
  group,
  phase,
  activeActionId,
}: VimKeyMapGroupProps) {
  const active = isVimHudLegendGroupActive(group.id, phase);

  return (
    <section
      data-vim-key-map-group={group.id}
      data-current={active ? 'true' : 'false'}
      aria-current={active ? 'true' : undefined}
      style={{
        padding: '11px 12px 9px',
        borderRadius: 13,
        border: active
          ? '1px solid rgba(196,181,253,0.34)'
          : '1px solid rgba(255,255,255,0.075)',
        color: '#f5f0ff',
        background: active
          ? 'linear-gradient(180deg, rgba(97,71,148,0.25), rgba(24,19,34,0.24))'
          : 'rgba(13,11,20,0.22)',
        boxShadow: active
          ? 'inset 0 1px 0 rgba(255,255,255,0.06), 0 0 24px rgba(139,92,246,0.08)'
          : 'inset 0 1px 0 rgba(255,255,255,0.035)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 7,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              color: active ? '#d8ccff' : '#b4acc1',
              fontFamily: HUD_MONO_FONT,
              fontSize: 10,
              fontWeight: 900,
              letterSpacing: '0.14em',
              lineHeight: 1.1,
              textTransform: 'uppercase',
            }}
          >
            {group.title}
          </div>
          <div
            style={{
              marginTop: 4,
              color: '#817989',
              fontSize: 10,
              fontWeight: 590,
              lineHeight: 1.25,
            }}
          >
            {group.description}
          </div>
        </div>
        {active && (
          <span
            style={{
              flex: '0 0 auto',
              padding: '3px 5px',
              borderRadius: 5,
              color: '#d8ccff',
              background: 'rgba(167,139,250,0.13)',
              fontFamily: HUD_MONO_FONT,
              fontSize: 7,
              fontWeight: 900,
              letterSpacing: '0.11em',
            }}
          >
            NOW
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gap: 3 }}>
        {group.items.map((item) => {
          const isNavigationGroup = group.id === 'structure' || group.id === 'text';
          const isLatestAction = item.actionId === activeActionId
            && (!isNavigationGroup || active);
          return (
            <div
              key={`${group.id}-${item.actionId}`}
              data-vim-key-map-action={item.actionId}
              data-latest={isLatestAction ? 'true' : 'false'}
              style={{
                display: 'grid',
                gridTemplateColumns: '48px minmax(0, 1fr)',
                alignItems: 'center',
                minHeight: 23,
                gap: 7,
                borderRadius: 7,
                color: isLatestAction ? '#f7f3ff' : '#bbb4c4',
                background: isLatestAction
                  ? 'rgba(167,139,250,0.095)'
                  : 'transparent',
              }}
            >
              <kbd
                style={{
                  minWidth: 29,
                  width: 'fit-content',
                  maxWidth: 48,
                  height: 21,
                  display: 'inline-grid',
                  placeItems: 'center',
                  padding: '0 6px',
                  overflow: 'hidden',
                  border: isLatestAction
                    ? '1px solid rgba(216,204,255,0.52)'
                    : '1px solid rgba(255,255,255,0.11)',
                  borderBottom: isLatestAction
                    ? '3px solid rgba(103,80,164,0.92)'
                    : '3px solid rgba(0,0,0,0.64)',
                  borderRadius: 6,
                  color: isLatestAction ? '#f6f0ff' : '#d5cedf',
                  background: isLatestAction
                    ? 'linear-gradient(180deg, rgba(107,82,158,0.72), rgba(44,34,63,0.75))'
                    : 'linear-gradient(180deg, rgba(43,39,51,0.84), rgba(23,20,29,0.84))',
                  fontFamily: HUD_MONO_FONT,
                  fontSize: item.key.length > 3 ? 8 : 10,
                  fontWeight: 850,
                  lineHeight: 1,
                  whiteSpace: 'nowrap',
                }}
              >
                {item.key}
              </kbd>
              <span
                style={{
                  minWidth: 0,
                  fontSize: 10,
                  fontWeight: isLatestAction ? 680 : 580,
                  lineHeight: 1.15,
                }}
              >
                {item.description}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Props for the pixel-faithful, live Vim HUD used by both document renderers. */
export interface VimKeyHudProps {
  readonly command: VimHudCommand | null;
  readonly phase: VimHudPhase;
  readonly inputMethod: InputMethod;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  /** Hide the persistent key panel while leaving the targeting HUD enabled. */
  readonly onHide?: () => void;
  /** Notify the owner when keyboard focus leaves the HUD for another surface. */
  readonly onFocusLeave?: () => void;
}

/**
 * Render the video HUD against real handled Vim commands.
 *
 * Key feedback changes instantly rather than animating navigation, preserving
 * the responsiveness expected by high-frequency keyboard users.
 */
export function VimKeyHud({
  command,
  phase,
  inputMethod,
  expanded,
  onExpandedChange,
  onHide,
  onFocusLeave,
}: VimKeyHudProps) {
  const [history, setHistory] = useState<readonly VimHudCommand[]>([]);
  const [pressedSequence, setPressedSequence] = useState<number | null>(null);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    if (!command) {
      if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
      setHistory((current) => (current.length === 0 ? current : []));
      setPressedSequence(null);
      return;
    }

    setHistory((current) => {
      if (current.at(-1)?.sequence === command.sequence) return current;
      return [...current, command].slice(-4);
    });
    setPressedSequence(command.sequence);
    if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = setTimeout(() => {
      setPressedSequence((current) => (
        current === command.sequence ? null : current
      ));
    }, PRESSED_DURATION_MS);

    return () => {
      if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    };
  }, [command]);

  const previous = history
    .filter((entry) => entry.sequence !== command?.sequence)
    .slice(-3);
  const keyLabel = command?.key ?? '·';
  const description = command?.description ?? 'Move by document meaning';
  const inputLabel = inputMethod === 'pinpoint' ? 'PINPOINT' : 'SELECT';

  return (
    <div
      data-vim-key-hud
      data-expanded={expanded ? 'true' : 'false'}
      role="region"
      aria-label="Vim keyboard HUD"
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node
          && event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        onFocusLeave?.();
      }}
      style={{
        position: 'fixed',
        right: 'min(48px, 4vw)',
        bottom: 150,
        zIndex: 120,
        width: expanded
          ? 'min(860px, calc(100vw - 32px))'
          : 'min(650px, calc(100vw - 32px))',
        height: expanded
          ? 'min(560px, calc(100dvh - 174px))'
          : 88,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        overflow: 'hidden',
        padding: '12px 16px',
        borderRadius: 20,
        color: '#f7f4ff',
        background: 'linear-gradient(180deg, rgba(43,35,59,0.46), rgba(13,11,20,0.34))',
        border: '1px solid rgba(196,181,253,0.25)',
        boxShadow: '0 22px 58px rgba(0,0,0,0.52), 0 0 32px rgba(167,139,250,0.1), inset 0 1px 0 rgba(255,255,255,0.07)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        pointerEvents: 'none',
      }}
    >
      <div
        data-vim-hud-summary
        style={{
          width: '100%',
          height: 63,
          display: 'flex',
          flex: '0 0 auto',
          alignItems: 'center',
        }}
      >
        <div
          data-vim-hud-history
          aria-hidden="true"
          style={{
            width: 112,
            display: 'flex',
            flex: '0 0 auto',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 5,
          }}
        >
          {previous.map((entry, index) => (
            <PreviousKey
              key={entry.sequence}
              keyLabel={entry.key}
              opacity={0.28 + index * 0.24}
            />
          ))}
        </div>

        <div
          aria-hidden="true"
          style={{
            width: 1,
            height: 46,
            flex: '0 0 auto',
            margin: '0 15px',
            background: 'linear-gradient(180deg, transparent, rgba(255,255,255,0.14), transparent)',
          }}
        />

        <ActiveKey
          keyLabel={keyLabel}
          pressed={command?.sequence === pressedSequence}
        />

        <div
          style={{
            minWidth: 0,
            flex: 1,
            marginLeft: 16,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: '#a99fba',
              fontFamily: HUD_MONO_FONT,
              fontSize: 10,
              fontWeight: 850,
              letterSpacing: '0.16em',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                flex: '0 0 auto',
                borderRadius: 99,
                background: '#a78bfa',
                boxShadow: '0 0 13px rgba(167,139,250,0.88)',
              }}
            />
            <span data-vim-hud-phase>{phase} / {inputLabel}</span>
          </div>
          <div
            data-vim-hud-command
            style={{
              marginTop: 5,
              overflow: 'hidden',
              color: '#f4f0f8',
              fontSize: 19,
              fontWeight: 690,
              lineHeight: 1.08,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {description}
          </div>
          <span
            role="status"
            aria-live="polite"
            className="sr-only"
          >
            {phase} {inputLabel}: {keyLabel}, {description}
          </span>
        </div>

        {onHide && (
          <button
            type="button"
            data-vim-key-panel-hide
            aria-label="Hide Vim key panel"
            title="Hide key panel (keep target reticle)"
            onPointerDown={(event) => {
              // Preserve document ownership for pointer users. Keyboard
              // activation is handed back by the owner after hiding.
              event.preventDefault();
            }}
            onClick={onHide}
            style={{
              width: 40,
              height: 40,
              display: 'grid',
              flex: '0 0 auto',
              placeItems: 'center',
              marginLeft: 10,
              padding: 0,
              border: '1px solid rgba(196,181,253,0.16)',
              borderRadius: 10,
              color: '#aaa0ba',
              background: 'rgba(17,14,24,0.2)',
              cursor: 'pointer',
              pointerEvents: 'auto',
            }}
          >
            <EyeOff size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}

        <button
          type="button"
          data-vim-key-map-toggle
          aria-expanded={expanded}
          aria-controls="vim-hud-key-map"
          aria-label={expanded ? 'Collapse Vim key map' : 'Expand Vim key map'}
          onPointerDown={(event) => {
            // Keep keyboard ownership on the document/iframe while the pointer
            // toggles this fixed HUD control.
            event.preventDefault();
          }}
          onClick={() => onExpandedChange(!expanded)}
          className="vim-key-hud__map-toggle"
          style={{
            width: 92,
            minWidth: 44,
            minHeight: 44,
            display: 'grid',
            flex: '0 0 auto',
            gridTemplateColumns: '1fr auto',
            alignItems: 'center',
            gap: 7,
            marginLeft: 12,
            padding: '7px 8px 7px 10px',
            border: '1px solid rgba(196,181,253,0.18)',
            borderRadius: 11,
            color: '#afa5bf',
            background: expanded
              ? 'rgba(167,139,250,0.13)'
              : 'rgba(17,14,24,0.22)',
            fontFamily: HUD_MONO_FONT,
            cursor: 'pointer',
            pointerEvents: 'auto',
          }}
        >
          <span
            style={{
              display: 'grid',
              justifyItems: 'start',
              fontSize: 8,
              fontWeight: 850,
              letterSpacing: '0.1em',
              lineHeight: 1.35,
            }}
          >
            <span>VIM</span>
            <span style={{ color: '#b39ce7' }}>
              {expanded ? 'CLOSE' : 'KEY MAP'}
            </span>
          </span>
          <kbd
            aria-hidden="true"
            style={{
              width: 25,
              height: 25,
              display: 'grid',
              placeItems: 'center',
              border: '1px solid rgba(216,204,255,0.34)',
              borderBottom: '3px solid rgba(0,0,0,0.66)',
              borderRadius: 7,
              color: '#eee8ff',
              background: 'linear-gradient(180deg, rgba(64,55,78,0.9), rgba(27,23,35,0.9))',
              fontSize: 12,
              fontWeight: 900,
            }}
          >
            ?
          </kbd>
        </button>
      </div>

      {expanded && (
        <div
          id="vim-hud-key-map"
          data-vim-key-map
          style={{
            minHeight: 0,
            display: 'flex',
            flex: 1,
            flexDirection: 'column',
            paddingTop: 10,
            borderTop: '1px solid rgba(255,255,255,0.085)',
            pointerEvents: 'auto',
          }}
        >
          <div
            style={{
              display: 'flex',
              flex: '0 0 auto',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              padding: '2px 2px 10px',
            }}
          >
            <div>
              <div
                style={{
                  color: '#f4efff',
                  fontSize: 14,
                  fontWeight: 760,
                  lineHeight: 1.15,
                }}
              >
                Vim key map
              </div>
              <div
                style={{
                  marginTop: 3,
                  color: '#92899e',
                  fontSize: 10,
                  fontWeight: 570,
                }}
              >
                The highlighted section matches your current navigation level.
              </div>
            </div>
            <div
              style={{
                flex: '0 0 auto',
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                color: '#a99fba',
                fontFamily: HUD_MONO_FONT,
                fontSize: 9,
                fontWeight: 850,
                letterSpacing: '0.11em',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 99,
                  background: '#a78bfa',
                  boxShadow: '0 0 12px rgba(167,139,250,0.82)',
                }}
              />
              {phase} MODE
            </div>
          </div>

          <div
            className="vim-key-hud__map-scroll"
            style={{
              minHeight: 0,
              flex: 1,
              overflow: 'auto',
              overscrollBehavior: 'contain',
              padding: '0 2px 4px',
              scrollbarGutter: 'stable',
            }}
          >
            <div className="vim-key-hud__map-columns">
              {KEY_MAP_COLUMNS.map((groupIds, columnIndex) => (
                <div
                  key={columnIndex}
                  style={{
                    display: 'grid',
                    alignContent: 'start',
                    gap: 9,
                  }}
                >
                  {KEY_MAP_GROUPS
                    .filter((group) => groupIds.includes(group.id))
                    .map((group) => (
                      <VimKeyMapGroup
                        key={group.id}
                        group={group}
                        phase={phase}
                        activeActionId={command?.actionId ?? null}
                      />
                    ))}
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              flex: '0 0 auto',
              justifyContent: 'space-between',
              gap: 12,
              padding: '9px 2px 0',
              color: '#777080',
              fontFamily: HUD_MONO_FONT,
              fontSize: 8,
              fontWeight: 780,
              letterSpacing: '0.08em',
            }}
          >
            <span>PRESS ? TO CLOSE</span>
            <span>ESC BACKS OUT ONE LEVEL</span>
          </div>
        </div>
      )}
    </div>
  );
}
