import type { SystemModel } from '../format/types.ts';
import type { LineClass } from '../layout/types.ts';

export type Moves = LineClass['moves'];

export const MOVES: Record<Moves, { word: string; key: string; ink: string }> = {
  data: { word: 'data', key: 'information: records, requests, files', ink: 'var(--sys-l-data)' },
  people: { word: 'people', key: 'a person, or a person’s attention', ink: 'var(--sys-l-people)' },
  money: { word: 'money', key: 'payments, bills, claims', ink: 'var(--sys-l-money)' },
  energy: { word: 'energy', key: 'power or matter, physically moving', ink: 'var(--sys-l-energy)' },
};
export const MOVES_ORDER: Moves[] = ['data', 'people', 'money', 'energy'];

export const BASE_W = 1.3;

const PEOPLE_PART = /\b(people|person|persons|team|staff|human|user|users|operator|operators|crew|patients?|clinicians?|technicians?)\b/i;

export function inferMoves(text: string, ends: (string | undefined)[] = []): Moves {
  if (/\b(pays?|paid|payments?|invoices?|bills?|billing|claims?|revenue|statements?|settle[ds]?|settlement|refunds?|charges?|dollars?|credits?|subscriptions?|checkout|payroll)\b|\$/i.test(text)) return 'money';
  const instruction = /\b(command|commands|order|orders|cap|target|limit|limits|setpoints?|status|reading|readings|telemetry|alarm)\b/i.test(text);
  if (!instruction && /\b(MWh|kWh|kV|MW|kW|power|energy|electricity|current|fuel|water|gas|steam|DC|AC)\b/.test(text)) return 'energy';
  if (ends.some((k) => PEOPLE_PART.test(k || ''))) return 'people';
  if (/\b(decision|decide|approve|approval|a person|someone|arrive|arrives|arrivals|admitted|admit|truck rolls?|to theatre|a page|page)\b/i.test(text)) return 'people';
  return 'data';
}

const CACHE = new WeakMap<SystemModel, Record<string, LineClass>>();
export function lineOfFlow(model: SystemModel, id: string): LineClass | null {
  let c = CACHE.get(model);
  if (!c) CACHE.set(model, (c = {}));
  if (c[id]) return c[id]!;
  const f = model.flows[id];
  if (!f) return null;
  const text = [id, f.says, f.carries].filter(Boolean).join(' · ');
  const ends = [...f.from, f.to].map((p) => model.parts[p]?.kind);
  return (c[id] = { moves: f.moves ?? inferMoves(text, ends), w: BASE_W });
}

export function lineOfMany(list: (LineClass | null)[]): LineClass {
  const n: Partial<Record<Moves, number>> = {};
  for (const l of list) if (l) n[l.moves] = (n[l.moves] ?? 0) + 1;
  const moves = (Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] as Moves | undefined) ?? 'data';
  return { moves, w: BASE_W };
}
