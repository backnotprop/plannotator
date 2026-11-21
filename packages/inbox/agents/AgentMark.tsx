import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { InboxAgent } from '@plannotator/core/inbox-types';
import { HostMark } from '../icons';
import { keepAgentFace, useAgentFace } from './agentFaces';
import { agentFaceSources, loadAgentFaceArt } from './faceArtLoad';
import type { AgentFace } from './faceChoices';
import { FAN_DWELL_MS, FAN_PRESS_MS, FaceFan, type FaceSources, type FanOpenedBy } from './FaceFan';
import { AgentIconDialog, type AgentIconPlace } from './AgentIconDialog';
import { agentFaceArtReady, agentRigOf, mountAgentMark, showAgentFace, unmountAgentMark } from './motion';
import { ProjectTile, keptAgentFace, shownAgentFace, useAgentProjectTile, useProjectDefault } from './projectFace';
import { RexMark, useRexMarkOf } from './rexMark';

export { loadAgentFaceArt } from './faceArtLoad';

/**
 * An agent's animated mark (motion.ts), 24 px, with no tile: always alive, the same whatever the agent is doing, its
 * own life seeded by the agent's id. It is a button of its own beside the row's (the row's click opens the thread;
 * this one never does): a click, a tap, the pointer resting on it, Enter or Space, or a long press on a touch screen
 * opens the picker (FaceFan.tsx) with every face, the Glass colours among them. A click never changes the face; a
 * second click on the mark closes the picker.
 * The face is kept for that agent until changed (agentFaces.ts), and every other icon of it shows it too. A host
 * with no rig shows its plain mark, moved as a whole, and has the same faces. `agent`: the sessions it is (absent:
 * only its id), so its threads' icons find the face.
 *
 * `picks` (approval "inbox-linked-marks"): `shared` for a linked machine's agent, whose face lives there: the
 * built-in faces and the built-in sets only, never "Your own…" (its picture stays on this computer); `none` for one
 * whose machine takes no face from here: the mark alone, and a press on it is the row's.
 */
export type AgentMarkPicks = 'all' | 'shared' | 'none';

/**
 * The mark's size on the marks' scale (inbox.css `--ib-mark-N`): 24 everywhere, 44 on the list's Agents view
 * (agentsView/). The same mark at either size: the same rig, faces, motion and picker, every place in step through
 * the kept face (agentFaces.ts); the picker's plate grows with it (FaceFan.tsx).
 */
export type AgentMarkSize = 24 | 44;

export function AgentMark({
  id,
  host,
  name,
  agent,
  picks = 'all',
  statusMarks = false,
  size = 24,
}: {
  id: string;
  host: string | null;
  name: string;
  agent?: Pick<InboxAgent, 'id' | 'session' | 'continues'>;
  picks?: AgentMarkPicks;
  /** The sidebar's Agents list: the "Agent status" marks too, while the setting is on (rexMark.tsx `useRexMarkOf`). */
  statusMarks?: boolean;
  size?: AgentMarkSize;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [plain, setPlain] = useState<HTMLElement | null>(null);
  const kept = useAgentFace(id);
  // Started in Rex: its pane's status on the mark's corner (rexMark.tsx); any other agent: none.
  const rexMark = useRexMarkOf(agent?.session ?? id, statusMarks);
  // Its corner mark is drawn for the 24 px mark only.
  const rex = rexMark && size === 24 ? <RexMark mark={rexMark} seed={id} size={24} side /> : null;
  // Agent icons "From the project name" (Settings → Rows): no face picked draws the project's tile (projectFace.tsx).
  const projectDefault = useProjectDefault(id);
  const face = shownAgentFace(kept, projectDefault);
  // The project's tile is a still in the mark's place; with nothing to draw, the agent's own mark, alive as ever.
  const project = useAgentProjectTile(face === 'project' ? id : null);
  const tiled = face === 'project' && project !== null;
  // What the mark draws: under the setting, an agent whose project has nothing to draw shows (and the picker checks) its own mark.
  const drawn = face === 'project' && !tiled ? 'agent' : face;
  const moving = face === 'project' || face === 'mark' ? 'agent' : face;
  const rig = agentRigOf(host);
  const clicked = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPlain(mountAgentMark(el, { rig, face: 'agent', size, seed: id }));
    return () => {
      setPlain(null);
      unmountAgentMark(el);
    };
  }, [rig, id, size]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const withMotion = clicked.current;
    if (moving === 'agent' || moving.startsWith('own:') || moving.startsWith('set:') || agentFaceArtReady()) {
      showAgentFace(el, moving, withMotion);
      return;
    }
    let live = true;
    loadAgentFaceArt().then(
      () => {
        if (live) showAgentFace(el, moving, withMotion);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [moving, rig, id]);

  // The picker: opened by a rest of the pointer, a key or a long press; mounted from its first opening on.
  const [fan, setFan] = useState<{ open: boolean; by: FanOpenedBy } | null>(null);
  const [sources, setSources] = useState<FaceSources | null>(agentFaceSources);
  const dwell = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const pressed = useRef(false);
  // Just closed: the pointer resting where it was (the fan's plate gone from under it) opens nothing until it moves.
  const quiet = useRef(false);
  // Closed by a click on the mark: nothing opens again until the pointer leaves it.
  const held = useRef(false);
  // The fan was opened, or kept, by a click: the next click on the mark closes it. One opened by a rest of the pointer
  // is kept by a click (the click that the rest beat), not closed.
  const sticky = useRef(false);
  // The kind of pointer of the last press: a tap opens the finger's fan.
  const pointer = useRef<string>('mouse');
  useEffect(
    () => () => {
      clearTimeout(dwell.current);
      if (press.current) clearTimeout(press.current.timer);
    },
    [],
  );
  const openFan = (by: FanOpenedBy, byClick = false) => {
    clearTimeout(dwell.current);
    sticky.current = byClick;
    setFan({ open: true, by });
    if (agentFaceSources()) setSources(agentFaceSources());
    else
      loadAgentFaceArt().then(
        () => setSources(agentFaceSources()),
        () => {},
      );
  };
  const closeFan = (hold = false) => {
    quiet.current = true;
    sticky.current = false;
    if (hold) held.current = true;
    clearTimeout(dwell.current);
    setFan((was) => (was ? { ...was, open: false } : was));
  };
  // "Your own…" and "Sets": the fan's last two inner places open the agent icon dialog in the middle of the window
  // (AgentIconDialog.tsx). The face takes focus first, so the dialog gives it back when it closes.
  const [dialog, setDialog] = useState<AgentIconPlace | null>(null);
  const openDialog = (place: AgentIconPlace) => {
    closeFan();
    button.current?.focus({ preventScroll: true });
    setDialog(place);
  };
  const choose = (next: AgentFace) => {
    clicked.current = true;
    keepAgentFace(agent ?? id, keptAgentFace(next, projectDefault));
    closeFan();
  };
  const endPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };

  // A click on the mark (or on the fan's plate over it, FaceFan.tsx) opens the picker, or closes the one it opened.
  const toggle = (by: FanOpenedBy) => {
    clearTimeout(dwell.current);
    if (!fan?.open) return openFan(by, true);
    if (sticky.current) return closeFan(true);
    sticky.current = true;
  };
  const onClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    // A long press opened the picker: its lift is not a click.
    if (pressed.current) {
      pressed.current = false;
      return;
    }
    toggle(event.detail === 0 ? 'keyboard' : pointer.current === 'touch' ? 'touch' : 'hover');
  };
  const rest = () => {
    clearTimeout(dwell.current);
    dwell.current = setTimeout(() => openFan('hover'), FAN_DWELL_MS);
  };
  const onPointerEnter = (event: PointerEvent) => {
    if (event.pointerType === 'touch' || fan?.open || dialog || quiet.current) return;
    rest();
  };
  const onPointerLeave = () => {
    quiet.current = false;
    held.current = false;
    clearTimeout(dwell.current);
  };
  const onPointerDown = (event: PointerEvent) => {
    clearTimeout(dwell.current);
    pressed.current = false;
    pointer.current = event.pointerType;
    if (event.pointerType !== 'touch') return;
    endPress();
    press.current = {
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        press.current = null;
        pressed.current = true;
        openFan('touch');
      }, FAN_PRESS_MS),
    };
  };
  const onPointerMove = (event: PointerEvent) => {
    if (quiet.current && !held.current && event.pointerType !== 'touch' && !fan?.open && !dialog) {
      quiet.current = false;
      rest();
    }
    if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8) endPress();
  };
  // Enter or Space opens the picker, focus in it (its own keys move in it).
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) openFan('keyboard');
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === ' ') event.preventDefault();
  };

  if (picks === 'none') {
    return (
      <>
        <span className="am-btn" data-agent-icon={id} data-picks="none">
          {/* The project's tile (projectFace.tsx) is a still beside the animated mark, which stays mounted (hidden) so
              its motion and the plain mark's portal are never torn out from under React. */}
          <span ref={ref} className="am" aria-hidden="true" data-agent-mark={id} data-rig={rig ?? 'plain'} data-size={size === 24 ? undefined : size} hidden={tiled} />
          {tiled && project && (
            <span className="am am-pf" aria-hidden="true" data-agent-tile={id} data-face="project" data-size={size === 24 ? undefined : size}>
              <ProjectTile tile={project} host={host} />
            </span>
          )}
          {rex}
        </span>
        {plain && createPortal(<HostMark host={host} />, plain)}
      </>
    );
  }
  return (
    <>
      <button
        ref={button}
        type="button"
        className="am-btn"
        aria-label={`${name}: icon`}
        aria-haspopup="dialog"
        aria-expanded={fan?.open ?? false}
        data-agent-icon={id}
        data-fan-open={fan?.open ? '' : undefined}
        onClick={onClick}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPress}
        onPointerCancel={endPress}
        onContextMenu={(event) => {
          if (pressed.current || press.current) event.preventDefault();
        }}
        // A long press here opens the face picker, never the row's menu (its ContextMenu hears touches on the row).
        onTouchStart={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      >
        {/* The project's tile (projectFace.tsx) is a still beside the animated mark, which stays mounted (hidden) so
              its motion and the plain mark's portal are never torn out from under React. */}
          <span ref={ref} className="am" aria-hidden="true" data-agent-mark={id} data-rig={rig ?? 'plain'} data-size={size === 24 ? undefined : size} hidden={tiled} />
          {tiled && project && (
            <span className="am am-pf" aria-hidden="true" data-agent-tile={id} data-face="project" data-size={size === 24 ? undefined : size}>
              <ProjectTile tile={project} host={host} />
            </span>
          )}
          {rex}
      </button>
      {plain && createPortal(<HostMark host={host} />, plain)}
      {fan && button.current && (
        <FaceFan anchor={button.current} open={fan.open} openedBy={fan.by} host={host} agent={id} name={name} face={drawn} sources={sources} onChoose={choose} onOwn={picks === 'all' ? () => openDialog('own') : undefined} onSets={() => openDialog('sets')} onMark={() => toggle(pointer.current === 'touch' ? 'touch' : 'hover')} onClose={() => closeFan()} />
      )}
      {dialog && (
        <AgentIconDialog
          place={dialog}
          agent={agent ?? id}
          host={host}
          name={name}
          face={drawn}
          shared={picks === 'shared'}
          onClose={() => {
            clicked.current = true;
            quiet.current = true;
            setDialog(null);
          }}
        />
      )}
    </>
  );
}
