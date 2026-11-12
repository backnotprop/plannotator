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
 */
export function AgentMark({ id, host, name, agent }: { id: string; host: string | null; name: string; agent?: Pick<InboxAgent, 'id' | 'session' | 'continues'> }) {
  const ref = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [plain, setPlain] = useState<HTMLElement | null>(null);
  const face = useAgentFace(id);
  const rig = agentRigOf(host);
  const clicked = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPlain(mountAgentMark(el, { rig, face: 'agent', size: 24, seed: id }));
    return () => {
      setPlain(null);
      unmountAgentMark(el);
    };
  }, [rig, id]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const withMotion = clicked.current;
    if (face === 'agent' || face.startsWith('own:') || face.startsWith('set:') || agentFaceArtReady()) {
      showAgentFace(el, face, withMotion);
      return;
    }
    let live = true;
    loadAgentFaceArt().then(
      () => {
        if (live) showAgentFace(el, face, withMotion);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [face, rig, id]);

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
    keepAgentFace(agent ?? id, next);
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
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      >
        <span ref={ref} className="am" aria-hidden="true" data-agent-mark={id} data-rig={rig ?? 'plain'} />
      </button>
      {plain && createPortal(<HostMark host={host} />, plain)}
      {fan && button.current && <FaceFan anchor={button.current} open={fan.open} openedBy={fan.by} host={host} name={name} face={face} sources={sources} onChoose={choose} onOwn={() => openDialog('own')} onSets={() => openDialog('sets')} onMark={() => toggle(pointer.current === 'touch' ? 'touch' : 'hover')} onClose={() => closeFan()} />}
      {dialog && (
        <AgentIconDialog
          place={dialog}
          agent={agent ?? id}
          host={host}
          name={name}
          face={face}
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
