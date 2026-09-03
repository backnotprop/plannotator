import { describe, expect, it } from 'bun:test';
import {
  buildDecisionSpec,
  type DecisionSpec,
  type DecisionSpecInput,
} from './decisionSpec';

/** Every input combination the spec can receive, for the invariant sweeps. */
function allInputs(): DecisionSpecInput[] {
  const inputs: DecisionSpecInput[] = [];
  for (const app of ['annotate', 'review'] as const)
    for (const gate of [false, true])
      for (const hasFeedback of [false, true])
        for (const approvalNotesSupported of [false, true])
          for (const count of [0, 1, 3])
            inputs.push({ app, gate, count, hasFeedback, approvalNotesSupported });
  return inputs;
}

function itemIds(spec: DecisionSpec): string[] {
  return spec.items.map((item) => item.id);
}

describe('buildDecisionSpec state matrix', () => {
  // Guards the model itself: each row of the spec's state table produces the
  // expected primary and the expected ordered menu.
  it('annotate, no feedback, no gate → Done + the single Send a note composer', () => {
    const spec = buildDecisionSpec({
      app: 'annotate', gate: false, count: 0, hasFeedback: false, approvalNotesSupported: false,
    });
    expect(spec.primary.label).toBe('Done'); // frozen copy, maintainer-approved
    // Maintainer ruling (post-demo): Done without a gate is NOT an approval —
    // it must never wear the success tone or check icon Approve wears.
    expect(spec.primary.tone).toBe('neutral');
    expect(spec.primary.icon).toBeUndefined();
    // Maintainer ruling (empty-menu collapse): ONE composer item — the old
    // "Done with a note…" / "Request changes…" pair differed only by framing
    // on the same transport and must not come back. Label is free prose.
    expect(itemIds(spec)).toEqual(['request-changes']);
    expect(spec.items[0].composer).toBeDefined();
    expect(spec.items[0].composer?.tone).toBe('primary');
    expect(spec.items[0].dividerBefore).toBe(false);
  });

  it('annotate, no feedback, gate → Approve; approve-note item only with the capability', () => {
    const withCap = buildDecisionSpec({
      app: 'annotate', gate: true, count: 0, hasFeedback: false, approvalNotesSupported: true,
    });
    expect(withCap.primary.label).toBe('Approve'); // frozen copy, maintainer-approved
    expect(withCap.primary.tone).toBe('success');
    expect(itemIds(withCap)).toEqual(['note-with-approval', 'request-changes']);
    // Free prose except the verb: the gate's positive-note item must speak of
    // approving, not finishing.
    expect(withCap.items[0].label).toContain('Approve');

    const withoutCap = buildDecisionSpec({
      app: 'annotate', gate: true, count: 0, hasFeedback: false, approvalNotesSupported: false,
    });
    expect(itemIds(withoutCap)).toEqual(['request-changes']);
    expect(withoutCap.items[0].dividerBefore).toBe(false);
  });

  it('annotate, feedback (n) → Send Feedback + note/(approve-with-notes)/discard', () => {
    const nonGate = buildDecisionSpec({
      app: 'annotate', gate: false, count: 3, hasFeedback: true, approvalNotesSupported: true,
    });
    expect(nonGate.primary.label).toBe('Send Feedback'); // frozen copy, maintainer-approved
    expect(nonGate.primary.tone).toBe('primary');
    expect(nonGate.primary.icon).toBe('send');
    // No gate ⇒ no approve channel ⇒ no Approve-with-notes, capability or not.
    expect(itemIds(nonGate)).toEqual(['note-with-feedback', 'discard-and-finish']);
    // Label is free prose; the data is the flow verb and the live count.
    expect(nonGate.items[1].label).toContain('Done,');
    expect(nonGate.items[1].label).toContain('3');
    expect(nonGate.items[1].confirm?.confirmText).toBe('Discard & finish'); // frozen copy

    const gate = buildDecisionSpec({
      app: 'annotate', gate: true, count: 3, hasFeedback: true, approvalNotesSupported: true,
    });
    expect(itemIds(gate)).toEqual(['note-with-feedback', 'approve-with-notes', 'discard-and-finish']);
    expect(gate.items[1].label).toBe('Approve with notes'); // frozen copy, maintainer-approved
    expect(gate.items[2].label).toContain('Approve,');
    expect(gate.items[2].label).toContain('3');
    expect(gate.items[2].confirm?.confirmText).toBe('Discard & approve'); // frozen copy

    const gateNoCap = buildDecisionSpec({
      app: 'annotate', gate: true, count: 3, hasFeedback: true, approvalNotesSupported: false,
    });
    expect(itemIds(gateNoCap)).toEqual(['note-with-feedback', 'discard-and-finish']);
  });

  // M1 ruling fact-guard: in the agent-terminal delivered state the Done
  // transport still posts the FULL payload, so the copy must never claim
  // "no feedback" — while the primary label itself stays the frozen 'Done'.
  it('feedbackDelivered keeps the Done primary but drops the "no feedback" claim', () => {
    const base = {
      app: 'annotate' as const, gate: false, count: 0,
      hasFeedback: false, approvalNotesSupported: false,
    };
    const plain = buildDecisionSpec(base);
    const delivered = buildDecisionSpec({ ...base, feedbackDelivered: true });

    expect(delivered.primary.label).toBe('Done'); // frozen copy, maintainer-approved
    expect(delivered.primary.title).not.toContain('no feedback');
    // The two states must actually differ — a regression that ignores the
    // flag would silently restore the lying tooltip.
    expect(delivered.primary.title).not.toBe(plain.primary.title);
    expect(delivered.items.map((item) => item.id)).toEqual(plain.items.map((item) => item.id));
  });

  it('review, no feedback → Approve; phase-1 menu is Request changes only', () => {
    const phase1 = buildDecisionSpec({
      app: 'review', gate: true, count: 0, hasFeedback: false, approvalNotesSupported: false,
    });
    expect(phase1.primary.label).toBe('Approve');
    expect(itemIds(phase1)).toEqual(['request-changes']);

    const phase2 = buildDecisionSpec({
      app: 'review', gate: true, count: 0, hasFeedback: false, approvalNotesSupported: true,
    });
    expect(itemIds(phase2)).toEqual(['note-with-approval', 'request-changes']);
    expect(phase2.items[0].label).toContain('Approve');
  });

  it('review, feedback (n) → Send Feedback + note/(approve-with-notes)/discard', () => {
    const phase2 = buildDecisionSpec({
      app: 'review', gate: true, count: 3, hasFeedback: true, approvalNotesSupported: true,
    });
    expect(phase2.primary.label).toBe('Send Feedback');
    expect(phase2.primary.shortLabel).toBe('Send');
    expect(itemIds(phase2)).toEqual(['note-with-feedback', 'approve-with-notes', 'discard-and-finish']);

    const phase1 = buildDecisionSpec({
      app: 'review', gate: true, count: 3, hasFeedback: true, approvalNotesSupported: false,
    });
    expect(itemIds(phase1)).toEqual(['note-with-feedback', 'discard-and-finish']);
    expect(phase1.items[1].dividerBefore).toBe(true);
  });
});

describe('buildDecisionSpec invariants', () => {
  // Guards the maintainer's hard rule: Approve/Done and Send Feedback never
  // render side by side — there is exactly one primary and the menu never
  // smuggles a second one in.
  it('never yields two primaries, in any input combination', () => {
    for (const input of allInputs()) {
      const spec = buildDecisionSpec(input);
      expect(spec.primary.id).toBe('primary');
      expect(itemIds(spec)).not.toContain('primary');
      // The header shows Send Feedback XOR a positive finish, never both.
      const positiveLabels = ['Done', 'Approve'];
      if (spec.primary.label === 'Send Feedback') {
        expect(positiveLabels).not.toContain(spec.primary.label);
      } else {
        expect(positiveLabels).toContain(spec.primary.label);
      }
    }
  });

  // Guards rendering an item that silently drops content: without the
  // capability advert, no approve-carrying item exists in the approval flows.
  it('approvalNotesSupported: false ⇒ no approve-carrying item anywhere', () => {
    for (const input of allInputs()) {
      if (input.approvalNotesSupported) continue;
      const ids = itemIds(buildDecisionSpec(input));
      expect(ids).not.toContain('approve-with-notes');
      expect(ids).not.toContain('note-with-approval');
    }
  });

  // Maintainer ruling (empty-menu collapse): without a gate there is no
  // approval channel, so no approve-carrying id may appear in any non-gate
  // annotate state, capability advert or not — this is also what keeps the
  // non-gate 'note-with-approval' arm in annotateDecision.ts dead code.
  it('non-gate annotate never emits an approve-carrying item', () => {
    for (const input of allInputs()) {
      if (input.app !== 'annotate' || input.gate) continue;
      const ids = itemIds(buildDecisionSpec(input));
      expect(ids).not.toContain('note-with-approval');
      expect(ids).not.toContain('approve-with-notes');
    }
  });

  // Maintainer ruling: no user-facing decision-control string carries an em
  // dash. Sweeps every field the control renders, across both arms.
  it('no user-facing string contains an em dash', () => {
    const inputs: DecisionSpecInput[] = [
      ...allInputs(),
      ...([0, 1, 3] as const).flatMap((count) =>
        [false, true].map((selfAuthored): DecisionSpecInput => ({
          app: 'review', gate: true, count, hasFeedback: count > 0,
          approvalNotesSupported: false,
          platform: { label: 'GitHub', mrLabel: 'PR', selfAuthored },
        }))),
      ...allInputs().map((input) => ({ ...input, feedbackDelivered: true })),
    ];
    for (const input of inputs) {
      const spec = buildDecisionSpec(input);
      const strings = [
        spec.primary.label, spec.primary.shortLabel, spec.primary.mobileLabel,
        spec.primary.title,
        ...spec.items.flatMap((item) => [
          item.label, item.subtitle,
          item.composer?.title, item.composer?.actionLabel, item.composer?.placeholder,
          item.confirm?.title, item.confirm?.message, item.confirm?.confirmText,
        ]),
      ];
      for (const value of strings) expect(value ?? '').not.toContain('—');
    }
  });

  // Guards a refactor that drops the one remaining guard dialog.
  it('every discard item carries a confirm', () => {
    for (const input of allInputs()) {
      for (const item of buildDecisionSpec(input).items) {
        if (item.id === 'discard-and-finish') {
          expect(item.confirm).toBeDefined();
          expect(item.tone).toBe('destructive');
        }
      }
    }
  });

  // Guards a stale count in the label after an annotation is deleted.
  it('interpolates the live count into the pill and the discard copy', () => {
    const zero = buildDecisionSpec({
      app: 'annotate', gate: false, count: 0, hasFeedback: true, approvalNotesSupported: false,
    });
    expect(zero.primary.count).toBeUndefined();
    // Nothing to discard at zero — no discard item with a lying "0 annotations".
    expect(itemIds(zero)).not.toContain('discard-and-finish');

    // F2 ruling (maintainer default, pending final confirmation): the
    // count-0 + hasFeedback cell (direct edits / attachments only) still
    // offers approve-with-notes on capable approval flows, with zero-form
    // copy — the subtitle must never claim an annotation count of 0.
    const zeroGate = buildDecisionSpec({
      app: 'annotate', gate: true, count: 0, hasFeedback: true, approvalNotesSupported: true,
    });
    expect(itemIds(zeroGate)).toEqual(['note-with-feedback', 'approve-with-notes']);
    const approveWithNotes = zeroGate.items.find((item) => item.id === 'approve-with-notes')!;
    expect(approveWithNotes.subtitle).not.toContain('0');
    // Without the capability the cell keeps no approve-carrying item.
    const zeroGateNoCap = buildDecisionSpec({
      app: 'annotate', gate: true, count: 0, hasFeedback: true, approvalNotesSupported: false,
    });
    expect(itemIds(zeroGateNoCap)).toEqual(['note-with-feedback']);

    const three = buildDecisionSpec({
      app: 'review', gate: true, count: 3, hasFeedback: true, approvalNotesSupported: true,
    });
    expect(three.primary.count).toBe(3);
    const discard = three.items.find((item) => item.id === 'discard-and-finish')!;
    expect(discard.label).toContain('3');
    expect(discard.confirm!.title).toContain('3');

    const one = buildDecisionSpec({
      app: 'annotate', gate: false, count: 1, hasFeedback: true, approvalNotesSupported: false,
    });
    const discardOne = one.items.find((item) => item.id === 'discard-and-finish')!;
    // The singular form is the data here, not the sentence around it.
    expect(discardOne.label).toContain('1 annotation…');
  });

  // Every composer item must actually be a composer and every plain item must
  // not — the control branches on these fields, so an item with both (or a
  // confirm item with a composer) would render an unreachable surface.
  it('composer and confirm are mutually exclusive per item', () => {
    for (const input of allInputs()) {
      for (const item of buildDecisionSpec(input).items) {
        expect(item.composer && item.confirm).toBeFalsy();
      }
    }
  });
});

describe('buildDecisionSpec platform arm (PR6, §3.4)', () => {
  const platformInput = (count: number, selfAuthored: boolean): DecisionSpecInput => ({
    app: 'review',
    gate: true,
    count,
    hasFeedback: count > 0,
    approvalNotesSupported: false,
    platform: { label: 'GitHub', mrLabel: 'PR', selfAuthored },
  });

  // §3.4's hard rule: platform mode NEVER gets the note composer — the
  // submission dialog's general-comment field is the only note field on that
  // side, and a second composer would double-post via buildFileScopedBody —
  // and never a confirm or discard item (the dialog owns the outcome).
  it('never emits a composer, a confirm, or a discard item — any count, self-authored or not', () => {
    for (const count of [0, 1, 3]) {
      for (const selfAuthored of [false, true]) {
        const spec = buildDecisionSpec(platformInput(count, selfAuthored));
        for (const item of spec.items) {
          expect(item.composer).toBeUndefined();
          expect(item.confirm).toBeUndefined();
        }
        expect(itemIds(spec)).not.toContain('discard-and-finish');
      }
    }
  });

  // Self-approval is a mute, never a removal, and never a dead end: the
  // approve rows stay visible (muted, reason in subtitle/title) while a live
  // comment-tone path remains in every state.
  it('self-authorship mutes exactly the approve paths and always leaves a live row', () => {
    for (const count of [0, 3]) {
      const muted = buildDecisionSpec(platformInput(count, true));
      const open = buildDecisionSpec(platformInput(count, false));
      expect(itemIds(muted)).toEqual(itemIds(open)); // nothing removed
      for (const item of muted.items) {
        expect(!!item.muted).toBe(item.tone === 'success');
      }
      expect(muted.items.some((item) => !item.muted)).toBe(true);
      if (count === 0) {
        // The empty-state primary IS the approve: muted, reason in the tooltip.
        expect(muted.primary.muted).toBe(true);
        expect(muted.primary.title).toContain("You can't approve your own");
      } else {
        // Posting comments to one's own PR is allowed — the primary never mutes.
        expect(muted.primary.muted).toBeUndefined();
      }
      expect(open.primary.muted).toBeUndefined();
    }
  });

  // The platform posts to the forge API natively, so the approve rows must
  // not gate on the agent-transport advert (the §3.4 "irrelevant" ruling).
  it('ignores approvalNotesSupported', () => {
    const base = platformInput(3, false);
    expect(buildDecisionSpec({ ...base, approvalNotesSupported: true }))
      .toEqual(buildDecisionSpec(base));
  });
});
