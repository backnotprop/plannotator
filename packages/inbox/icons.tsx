/**
 * Moved to @plannotator/ui (packages/ui/components/inbox-thread/icons.tsx) unchanged, so a
 * host of the shared thread parts draws the same marks. This path re-exports it so every
 * existing import and test keeps working.
 *
 * But for `HostMark` and `AuthorMark`, which are the Inbox's own here: given an agent (a session id or an agent's id),
 * they draw the face the person chose for it in the sidebar (agents/agentFaces.ts), a still picture, and ui's mark
 * otherwise. Only an icon of one agent passes one; a kind of agent (Settings, the tour, "New Claude Code session")
 * keeps its plain mark.
 */
import { inboxMarkFaceHost, isInboxMarkFace, type InboxAuthor } from '@plannotator/core/inbox-types';
import { HostMark as UiHostMark, Icon } from '@plannotator/ui/components/inbox-thread/icons';
import { isScriptAuthor } from './scriptAuthor';
import type { CSSProperties, ReactNode } from 'react';
import { RexMark, useRexMarkOf } from './agents/rexMark';
import { ProjectFaceMark, useShownAgentFace } from './agents/projectFace';
import { useAgentFaceSources } from './agents/faceArtLoad';
import { isOwnFace, type AgentFace, type OurFace, type OwnFace } from './agents/faceChoices';
import { ownIconSrc } from './agents/ownIcons';
import { useImageRetry } from './agents/useImageRetry';
import { isSetFace, setArtStyle, setFaceParts, setIconSrc, useSetLook, type SetFace } from './agents/iconSets';

export * from '@plannotator/ui/components/inbox-thread/icons';

/**
 * The mark for an agent host; with `agent`, that agent's chosen face when it has one, else, with Settings → Rows' Agent
 * icons "From the project name", its project's tile (agents/projectFace.tsx).
 */
export function HostMark({ host, big, agent, script }: { host: string | null | undefined; big?: boolean; agent?: string | null; script?: boolean }) {
  // An agent started in Rex carries its pane's status on the icon's corner (agents/rexMark.tsx); any other: today's icon.
  const rex = useRexMarkOf(agent);
  const face = useShownAgentFace(agent);
  if (script) return <ScriptMark big={big} />;
  return (
    <FaceOfMark host={host} big={big} face={face} agent={agent}>
      {rex && agent ? <RexMark mark={rex} seed={agent} size={big ? 30 : 16} /> : null}
    </FaceOfMark>
  );
}

/**
 * A given face in a mark's box (HostMark draws the agent's own; a preview draws one not kept yet). `agent`: whose
 * project a `project` face draws. `mark:<host>`: that host's mark (ui's neutral mark for a host it has none for).
 * `children`: drawn inside the box after the face (the Rex status mark).
 */
export function FaceOfMark({ host, big, face, agent, children }: { host: string | null | undefined; big?: boolean; face: AgentFace; agent?: string | null; children?: ReactNode }) {
  if (face === 'agent' || face === 'mark')
    return (
      <UiHostMark host={host} big={big}>
        {children}
      </UiHostMark>
    );
  if (isInboxMarkFace(face))
    return (
      <UiHostMark host={inboxMarkFaceHost(face)} big={big}>
        {children}
      </UiHostMark>
    );
  if (face === 'project')
    return (
      <ProjectFaceMark agent={agent} host={host} big={big}>
        {children}
      </ProjectFaceMark>
    );
  if (isOwnFace(face))
    return (
      <OwnMark key={face} face={face} host={host} big={big}>
        {children}
      </OwnMark>
    );
  if (isSetFace(face))
    return (
      <SetMark key={face} face={face} host={host} big={big}>
        {children}
      </SetMark>
    );
  return (
    <FaceMark face={face} big={big}>
      {children}
    </FaceMark>
  );
}

/**
 * An uploaded picture ("Your own…") as a still, as uploaded: scaled to fit the mark's whole tile, its own shape and
 * transparency kept (no crop, no tile colour behind it, no rounded mask), so a wide or tall one sits letterboxed in
 * the same box and no row changes size. Only ever an `<img>` of its address on this Inbox: an SVG runs nothing.
 * A picture that does not load (removed, kept on another machine) is the agent's own mark.
 */
function OwnMark({ face, host, big, children }: { face: OwnFace; host: string | null | undefined; big?: boolean; children?: ReactNode }) {
  const [failed, fail] = useImageRetry();
  if (failed)
    return (
      <UiHostMark host={host} big={big}>
        {children}
      </UiHostMark>
    );
  return (
    <span className={`ib-mk${big ? ' ib-big' : ''} ib-face ib-own`} data-agent-face={face}>
      <img src={ownIconSrc(face, true)} alt="" draggable={false} decoding="async" onError={fail} />
      {children}
    </span>
  );
}

/**
 * An icon from a set ("Sets"), as a still in the mark's tile (the same box as an uploaded picture's, so no row changes
 * size). Pixel art is drawn nearest-neighbour at a whole multiple of its native size (agents.css); a one-colour icon is
 * a mask filled with the theme's text colour, with a hidden image of the same address that says when it does not
 * load. Only ever the icon's address on this Inbox; one that does not load is the agent's own mark.
 */
function SetMark({ face, host, big, children }: { face: SetFace; host: string | null | undefined; big?: boolean; children?: ReactNode }) {
  const [failed, fail] = useImageRetry();
  const { set, icon } = setFaceParts(face);
  const look = useSetLook(set);
  if (failed)
    return (
      <UiHostMark host={host} big={big}>
        {children}
      </UiHostMark>
    );
  const src = setIconSrc(set, icon);
  return (
    <span
      className={`ib-mk${big ? ' ib-big' : ''} ib-face ib-set`}
      data-agent-face={face}
      data-pixel={look?.pixelated ? '' : undefined}
      data-mono={look?.mono ? '' : undefined}
      style={setArtStyle(look, src) as CSSProperties}
    >
      {look?.mono ? (
        <>
          <span className="ib-set-mono" aria-hidden="true" />
          <img hidden src={src} alt="" onError={fail} />
        </>
      ) : (
        <img src={src} alt="" draggable={false} decoding="async" onError={fail} />
      )}
      {children}
    </span>
  );
}

/**
 * A script's post (scriptAuthor.ts): a terminal (Heroicons command-line) in the mark's tile, where an agent's icon
 * would be. No face: no agent chose one, and no project tile stands in for it.
 */
export function ScriptMark({ big }: { big?: boolean }) {
  return (
    <span className={`ib-mk${big ? ' ib-big' : ''}`} data-script-mark="">
      <Icon name="terminal" />
    </span>
  );
}

/** An author's mark: an agent's is its session's face when it has one; a script's post's is the terminal. */
export function AuthorMark({ author, big }: { author: InboxAuthor | null | undefined; big?: boolean }) {
  const agent = author?.kind === 'agent' ? author : null;
  return <HostMark host={agent?.host ?? null} big={big} agent={agent?.session ?? null} script={isScriptAuthor(agent)} />;
}

/**
 * A face as a still picture in a mark's box (no motion: only the sidebar's Agents rows move). Until the pictures'
 * script is in, the box stays empty: no wrong picture first, nothing moves.
 */
function FaceMark({ face, big, children }: { face: OurFace; big?: boolean; children?: ReactNode }) {
  const src = useAgentFaceSources(true)?.[face];
  return (
    <span className={`ib-mk${big ? ' ib-big' : ''} ib-face`} data-agent-face={face}>
      {typeof src === 'string' ? (
        <img src={src} alt="" draggable={false} />
      ) : src ? (
        <>
          <img className="ib-face-l" src={src.light} alt="" draggable={false} />
          <img className="ib-face-d" src={src.dark} alt="" draggable={false} />
        </>
      ) : null}
      {children}
    </span>
  );
}

/**
 * Plannotator's mark as a single-colour glyph: the bold P over its highlight bar, from the classic favicon
 * (`CLASSIC_FAVICON_SVG` in core, without its dark tile), drawn in `currentColor` in a 24 box. The P is solid and
 * the bar a tint of the same colour behind it, cut away around the P so the letter stays clean at 16 px.
 * Decorative (`aria-hidden`); the caller sizes and colours it (`className`).
 */
export function PlannotatorMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" data-plannotator-mark="">
      {/* Scaled about the middle so the P stands as tall as the cube beside it (12 of 16 px). */}
      <g transform="translate(12 12) scale(1.18) translate(-12 -12.2)">
      {/* The highlight bar, in two pieces: left of the stem, and right of it under the bowl. */}
      <path opacity="0.4" d="M3.6 11.2h1.3v6H3.6a1.4 1.4 0 0 1-1.4-1.4v-3.2a1.4 1.4 0 0 1 1.4-1.4ZM10.7 15h2.5a5.6 5.6 0 0 0 4.9-3.8h2.3a1.4 1.4 0 0 1 1.4 1.4v3.2a1.4 1.4 0 0 1-1.4 1.4h-9.7Z" />
      <path fillRule="evenodd" d="M6 4.5h7.1a4.7 4.7 0 0 1 0 9.4H9.6v5.6H6ZM9.6 7.6v3.2h3.1a1.6 1.6 0 0 0 0-3.2Z" />
      </g>
    </svg>
  );
}
