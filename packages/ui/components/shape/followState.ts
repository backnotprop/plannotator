/**
 * "Follow an example" (approval "trace-it-board" r5): which example is
 * followed and the step on now, and the small readings the card and the
 * picture share. Pure: no DOM.
 */
import type { ShapeExample, ShapeExampleCheck, ShapeExampleSource } from '@plannotator/core/shape';

/** Closed; or open on example `ex`, at step `step` (null: all steps at once). */
export type FollowPhase = { open: false } | { open: true; ex: number; step: number | null };

export type FollowAction =
  | { type: 'toggle' }
  | { type: 'close' }
  | { type: 'example'; ex: number }
  | { type: 'step'; step: number | null }
  | { type: 'next' }
  | { type: 'back' };

/** Which way the step moved: forward one (the hand-off), back one, or a jump. */
export type FollowDir = 'fwd' | 'back' | 'jump';

/**
 * The next phase. Next and back stop at the ends; from "all steps", next
 * starts at the first step. A step past the example's end is clamped, and an
 * example that no longer exists (a new version) closes it.
 */
export function followReduce(phase: FollowPhase, action: FollowAction, examples: readonly ShapeExample[]): FollowPhase {
  if (action.type === 'close') return { open: false };
  if (action.type === 'toggle') return phase.open || !examples.length ? { open: false } : { open: true, ex: 0, step: null };
  if (action.type === 'example') return examples[action.ex] ? { open: true, ex: action.ex, step: null } : phase;
  if (!phase.open) return phase;
  const ex = examples[phase.ex];
  if (!ex) return { open: false };
  const last = ex.steps.length - 1;
  const clamp = (n: number) => Math.max(0, Math.min(last, n));
  if (action.type === 'step') return { ...phase, step: action.step === null ? null : clamp(action.step) };
  if (action.type === 'next') return { ...phase, step: phase.step === null ? 0 : clamp(phase.step + 1) };
  return { ...phase, step: phase.step === null ? 0 : clamp(phase.step - 1) };
}

/** How the step moved from `was` to `now`. */
export function followDir(was: FollowPhase | null, now: FollowPhase): FollowDir {
  if (!now.open || !was?.open || was.ex !== now.ex || was.step === null || now.step === null) return 'jump';
  return now.step === was.step + 1 ? 'fwd' : now.step === was.step - 1 ? 'back' : 'jump';
}

/** The function's name, from its signature. */
export function followFnName(signature: string): string {
  return /^[\w$.]+/.exec(signature)?.[0] ?? signature;
}

/** A check as the card writes it: the expression, and its constant's value as a comment. */
export function followCheckCode(check: ShapeExampleCheck): string {
  return check.constant ? `${check.code}  // ${check.constant}` : check.code;
}

/** A literal the highlighter colours by its type; anything else is plain code. */
export const FOLLOW_LITERAL = /^(true|false|null|undefined|-?[\d_]+(\.\d+)?|'[^']*'|"[^"]*")$/;

export type FollowSource =
  | { kind: 'step'; step: number }
  | { kind: 'code'; path: string; line: number }
  | { kind: 'text'; text: string };

export function followSource(from: ShapeExampleSource): FollowSource {
  if (typeof from === 'string') return { kind: 'text', text: from };
  if ('step' in from) return { kind: 'step', step: from.step };
  return { kind: 'code', path: from.path, line: from.line };
}

/** A long signature, one parameter a line, hanging-indented. */
export function followSignature(sig: string, max = 52): string {
  if (sig.length <= max) return sig;
  const open = sig.indexOf('(');
  if (open < 0) return sig;
  let depth = 0;
  let close = -1;
  const parts: string[] = [];
  let from = open + 1;
  for (let i = open; i < sig.length; i++) {
    const c = sig[i]!;
    if ('(<[{'.includes(c)) depth++;
    else if (')>]}'.includes(c) && !(c === '>' && sig[i - 1] === '=')) {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (c === ',' && depth === 1) {
      parts.push(sig.slice(from, i).trim());
      from = i + 1;
    }
  }
  if (close < 0) return sig;
  parts.push(sig.slice(from, close).trim());
  return `${sig.slice(0, open)}(\n${parts.filter(Boolean).map((p) => `  ${p},`).join('\n')}\n)${sig.slice(close + 1)}`;
}
