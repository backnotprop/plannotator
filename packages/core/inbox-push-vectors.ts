/**
 * The push vectors (packages/core/fixtures/inbox-relay-push-v2-vectors.json), produced by
 * running the Inbox's own push rules (inbox-push.ts) on invented inputs: every kind, a
 * permission prompt's one-tap choices, and each rung of the size ladder. The phone app's
 * notification tests read the file; packages/core/inbox-push.test.ts checks the file is still
 * what these inputs give, that each envelope opens to its plaintext and each collapse id is
 * right.
 *
 *   bun scripts/inbox-push-vectors.ts      rewrites the file (envelopes get fresh IVs)
 *
 * Sealed under the all-zero pairing of inbox-relay-vectors.json. Public by design.
 */
import { deriveRelayKeys, encryptWithKey } from "./crypto";
import { inboxPushCollapseId, inboxPushFallbacks, inboxPushPlaintext, inboxPushSealText, type InboxPushInput, type InboxPushPlaintext } from "./inbox-push";
import { INBOX_PERMISSION_ALLOW_ONCE, INBOX_PERMISSION_AUTO, INBOX_PERMISSION_DENY, INBOX_PERMISSION_FULL, INBOX_PERMISSION_TERMINAL } from "./inbox-permission";

export const INBOX_PUSH_VECTOR_PAIRING = { pairing_secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", device_id: "dev_00000000000000000000000000" };

const THREAD = "msg_01K70000000000000000000010";
const REPLY = "msg_01K70000000000000000000014";
const base = { thread_id: THREAD, message_id: THREAD, subject: "Run the retry tests against the Stripe test clock?", project: "billing-svc", agent: "Claude Code", questions: [], badge: 1 };
const asks = {
  key: "q-1a2b3c4d",
  revision: 0,
  prompt: "Run the retry tests against the Stripe test clock?",
  context: "They take about four minutes against the test key.",
  kind: "single",
  state: "open",
  choices: [
    { label: "Yes", recommended: true },
    { label: "No", recommended: false },
  ],
};

/** Each vector's input, as the Inbox resolves it from its store. */
export const INBOX_PUSH_VECTOR_INPUTS: { name: string; input: InboxPushInput }[] = [
  { name: "question", input: { ...base, questions: [asks], badge: 2 } },
  {
    name: "question, recommended second (actions drawn recommended first), its thread stopped on the person",
    input: { ...base, questions: [{ ...asks, key: "q-5e6f7a8b", revision: 1, prompt: "Which retry policy?", context: null, choices: [{ label: "Fixed", recommended: false }, { label: "Exponential", recommended: true }] }], badge: 2, holds_up: true },
  },
  {
    name: "permission (only the choices one tap can answer)",
    input: {
      ...base,
      message_id: REPLY,
      subject: "Migrate the ledger",
      permission: true,
      questions: [
        {
          ...asks,
          key: "perm-req_0001",
          prompt: "Claude Code wants to run `bun run migrate`",
          context: null,
          choices: [INBOX_PERMISSION_ALLOW_ONCE, INBOX_PERMISSION_AUTO, INBOX_PERMISSION_FULL, INBOX_PERMISSION_TERMINAL, INBOX_PERMISSION_DENY].map((label) => ({ label, recommended: false })),
        },
      ],
    },
  },
  { name: "question with more than one open (no lock-screen answer)", input: { ...base, questions: [asks, { ...asks, key: "q-9c0d1e2f" }], badge: 2 } },
  { name: "new_thread", input: { ...base, subject: "Migrated the ledger to the new schema", new_thread: true } },
  { name: "turn_error", input: { ...base, message_id: REPLY, subject: "Migrate the ledger", turn_error: true } },
  { name: "review", input: { ...base, message_id: REPLY, subject: "Review: retry policy for webhooks", review: true, badge: 3 } },
  { name: "replaced", input: { ...base, message_id: REPLY, replaces: true, badge: 0 } },
];

/**
 * The plaintexts as sealed (with their `pad`, inboxPushSealText): one per input, then each rung of the first
 * vector's size ladder. `sealed_bytes` is the sealed text's length in UTF-8 bytes: a fixed step, never the words'.
 */
export function inboxPushVectorPlaintexts(): { name: string; sealed_bytes: number; plaintext: InboxPushPlaintext }[] {
  const pushes = INBOX_PUSH_VECTOR_INPUTS.map(({ name, input }) => ({ name, plaintext: inboxPushPlaintext(input)! }));
  const ladder = inboxPushFallbacks(pushes[0]!.plaintext).map((plaintext, index, all) => ({
    name: index === all.length - 1 ? "ladder: ids only (the last rung)" : `ladder rung ${index + 1}: ${["action labels dropped", "question.context dropped", "question and actions dropped"][index]}`,
    plaintext,
  }));
  return [...pushes, ...ladder].map(({ name, plaintext }) => {
    const text = inboxPushSealText(plaintext)!;
    return { name, sealed_bytes: new TextEncoder().encode(text).length, plaintext: JSON.parse(text) as InboxPushPlaintext };
  });
}

/** The whole file, sealed: envelopes under the device key, collapse ids under the collapse key. */
export async function inboxPushVectors() {
  const { key, collapseKey } = await deriveRelayKeys(INBOX_PUSH_VECTOR_PAIRING.pairing_secret, INBOX_PUSH_VECTOR_PAIRING.device_id);
  return {
    about:
      "Push version 2 vectors for the Inbox relay (adr/implementation/inbox-mobile.md, section 4, \"Push\" and \"Relay 1.1 and push 2\"), produced by scripts/inbox-push-vectors.ts (packages/core/inbox-push-vectors.ts) from the Inbox's own push rules (packages/core/inbox-push.ts) and sealed under the all-zero pairing of inbox-relay-vectors.json: `envelope` under `key` (the plaintext with its `pad`, `sealed_bytes` long), `collapse_id` the thread id under `collapse_key`. packages/core/inbox-push.test.ts checks the file against the code; the phone's notification tests read it. Sample data is invented. Public by design: nothing here protects anything.",
    ...INBOX_PUSH_VECTOR_PAIRING,
    key,
    collapse_key: collapseKey,
    pushes: await Promise.all(
      inboxPushVectorPlaintexts().map(async (push) => ({
        ...push,
        collapse_id: await inboxPushCollapseId(collapseKey, push.plaintext.thread_id),
        envelope: await encryptWithKey(inboxPushSealText(push.plaintext)!, key),
      })),
    ),
  };
}
