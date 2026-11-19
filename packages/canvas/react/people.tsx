/**
 * Who added what. An object says who by an id (`by`); the host knows the
 * name and picture that go with an id and says so here. With no host, a
 * person is shown by the first letter of their id and an agent by a mark.
 */
import { Sparkle } from 'lucide-react';
import React, { createContext, useContext } from 'react';
import type { Actor } from '../model/types';

export interface PersonLabel {
  name: string;
  /** A picture address (already resolved). Absent: the initial, or the agent's mark. */
  picture?: string;
}

export type People = (actor: Actor) => PersonLabel | null;

const PeopleContext = createContext<People | null>(null);

/** Tell every canvas view under this who the actors are. */
export function PeopleProvider({ people, children }: { people: People; children: React.ReactNode }) {
  return <PeopleContext.Provider value={people}>{children}</PeopleContext.Provider>;
}

/** The name to show for an actor: the host's, or the id with a capital. */
export function usePerson(actor: Actor | undefined): PersonLabel | null {
  const people = useContext(PeopleContext);
  if (!actor) return null;
  return people?.(actor) ?? { name: actor.id.charAt(0).toUpperCase() + actor.id.slice(1) };
}

/** A small round face: a picture, an initial, or the agent's mark. Decoration; the name is said by what holds it. */
export function Face({ actor, label }: { actor: Actor; label: PersonLabel }) {
  return (
    <span className="pcv-face" data-kind={actor.kind} aria-hidden="true">
      {label.picture ? <img src={label.picture} alt="" draggable={false} referrerPolicy="no-referrer" /> : actor.kind === 'agent' ? <Sparkle /> : label.name.charAt(0).toUpperCase()}
    </span>
  );
}
