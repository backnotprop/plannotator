import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { InboxAgent } from '@plannotator/core/inbox-types';
import { HostMark } from '../icons';
import { keepAgentFace, useAgentFace } from './agentFaces';
import { agentFaceSources, loadAgentFaceArt } from './faceArtLoad';
import type { AgentFace } from './faceChoices';
import { FAN_DWELL_MS, FAN_PRESS_MS, FaceFan, type FaceSources, type FanOpenedBy } from './FaceFan';
import { AgentIconDialog, type AgentIconPlace } from './AgentIconDialog';
import { agentFaceArtReady, agentRigOf, mountAgentMark, nextAgentFace, showAgentFace, unmountAgentMark } from './motion';

export { loadAgentFaceArt } from './faceArtLoad';

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

  const [fan, setFan] = useState<{ open: boolean; by: FanOpenedBy } | null>(null);
  const [sources, setSources] = useState<FaceSources | null>(agentFaceSources);
  const dwell = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const pressed = useRef(false);
  const quiet = useRef(false);
  useEffect(
    () => () => {
      clearTimeout(dwell.current);
      if (press.current) clearTimeout(press.current.timer);
    },
    [],
  );
  const openFan = (by: FanOpenedBy) => {
    clearTimeout(dwell.current);
    setFan({ open: true, by });
    if (agentFaceSources()) setSources(agentFaceSources());
    else
      loadAgentFaceArt().then(
        () => setSources(agentFaceSources()),
        () => {},
      );
  };
  const closeFan = () => {
    quiet.current = true;
    clearTimeout(dwell.current);
    setFan((was) => (was ? { ...was, open: false } : was));
  };
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

  const cycle = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    // A long press opened the picker: its lift is not a click.
    if (pressed.current) {
      pressed.current = false;
      return;
    }
    clearTimeout(dwell.current);
    clicked.current = true;
    keepAgentFace(agent ?? id, nextAgentFace(face));
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
    clearTimeout(dwell.current);
  };
  const onPointerDown = (event: PointerEvent) => {
    clearTimeout(dwell.current);
    pressed.current = false;
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
    if (quiet.current && event.pointerType !== 'touch' && !fan?.open && !dialog) {
      quiet.current = false;
      rest();
    }
    if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8) endPress();
  };
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
        onClick={cycle}
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
      {fan && button.current && <FaceFan anchor={button.current} open={fan.open} openedBy={fan.by} host={host} name={name} face={face} sources={sources} onChoose={choose} onOwn={() => openDialog('own')} onSets={() => openDialog('sets')} onClose={closeFan} />}
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
