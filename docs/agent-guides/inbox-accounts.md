## Inbox: accounts and usage

Settings → Accounts (`#settings/accounts`) shows this computer's Claude accounts and how much of each is used. It is step 1 of the approved "accounts-page" work (`.product/approved/accounts-page/`, not in this repo): read-only, this machine, Claude only. Switching, linked machines, Codex, OpenCode, Pi and a sidebar entry are later steps, each with its own review.

The Inbox reads through claude-swap (`cswap`, MIT, installed by the person). Plannotator never reads, stores or moves credentials. There is no on/off setting: with `cswap` on the Inbox's PATH the page shows the accounts, and without it the page says how to install it.

**The read** (`packages/server/inbox-accounts.ts`). `GET /api/inbox/accounts` looks `cswap` up with `AgentEnvironment.which` and runs `cswap list --json` through `runWithTimeout` (no shell, an argv array, 20 s, because the command reads the Keychain and fetches usage from Anthropic). A hung run is killed with its process group, and the Inbox stopping ends a run still going. The answer is one of:

- `{ state: "not_installed" }`.
- `{ state: "failed", reason }`: `timed_out`, `run_failed` (a non-zero exit), `bad_output` (not the list), or `unknown_schema` (a `schemaVersion` this build does not read; the window says to update).
- `{ state: "accounts", accounts }`.

Rules for the read:

- **Named fields only.** Every value is picked by name in `account()` and `usageWindow()`: `number`, `alias`, `email`, `organizationName`, `isOrganization`, `active`, `usageStatus`, `usageError`, `usageRetryAt`, and `usage`'s `fiveHour`, `sevenDay` and `scoped` (each `pct`, `resetsAt`, `countdown`, `clock`; a scoped window also `name`). Never pass the raw JSON or spread a row: a field a later `cswap` adds must not reach the window. Unknown extra fields are ignored.
- **No `cswap` words.** Its stdout, stderr and error text are never logged, stored or answered. A failure is a fixed code. `usageStatus` and `usageError` pass only as single words, and the window maps them to its own text.
- **An API-key row has no address.** `cswap` gives it a placeholder (`api-key-3@token.local`). The server drops that, for the status `api_key` and for any `@token.local` address.
- **A window `cswap` does not report is null, never 0.** A `pct` that is not a finite number drops its window, and a `usage` with no window left reads as no reading. A window of 0% with no reset time is shown as reported: the mock hides it, and that difference is decided until a real Ultra reading exists.
- **One read at a time.** Callers share the read in flight. Nothing is cached, nothing goes on disk, nothing polls: a read happens when the page opens or on Refresh.

Who may read: the window's read guard (same origin, `403 cross_origin`), and a tailnet login that is not the owner's gets `403 owner_only` before anything runs. The owner reads over the tailnet like any window route. It is not on the device door, so no phone app, linked machine or relay reaches it. The Inbox is Bun-only, so nothing is in the Pi server.

**The window** (`packages/inbox/components/Accounts.tsx`, classes `ib-acct-*`; design of record `.product/approved/accounts-page/mock/`, not in this repo). The section comes after Machines in Settings. Machines comes first on the page: one row, this machine and the account it is using, shown only when an account is active. It is plain text with no control; Switch goes there in a later step. Accounts follow under Claude Code.

A row reads as the alias, else the start of the address, else "API key". Figures show used, as `cswap` reports them. Bars come only from reported windows, in three fixed columns so they line up down the list: week last at the right, the window before it in the middle, a third on the left. On a phone a row with three windows puts them under the name, in columns that still line up. Amber at 90% or more, judged on the rounded figure so a number and its colour never disagree. `usage: null` reads "No reading yet" in the week column with the reason in plain words under the name (`noReadingReason`, which knows `cswap`'s statuses). An API-key account reads "API key" there, unless that is already its name.

The full address, the organization and the reset times stay out of the row until it is opened. A row with none of them opens nothing and is no button. The organization shows on the closed row only when two rows would read the same, and the machine says the same, since one address can be saved under two organizations.

The owner's rule for this page: "Show me only what I need until I want to act. If I want to act take me to settings page. No narrative labels or redundant info." So it has no lede and no side notes, only the accounts and their numbers, and each other state is a few words. Keep it that way.

Not installed shows the mock's line and the first install command of claude-swap's README in a copy block. No saved accounts shows the same with `cswap add`. Failed shows a short line. Refresh sits in the Claude Code heading of every state; the first read shows a waiting line, and a Refresh keeps the list up with the button disabled and spinning until it answers.

**Proofs.** No test can reach a real claude-swap, which reads and writes the Keychain item "Claude Code-credentials". Each gives the Inbox a PATH of only a fake `cswap`'s folder (`tests/helpers/fake-cswap.ts`, whose script names every program by absolute path). In e2e `cswap` is also in `AGENT_CLIS` (`tests/e2e/agent-cli-stubs.ts`), so any other spec that reached it fails the run. The samples in `tests/fixtures/cswap/` are fake output of the real tool.

- `packages/server/inbox-accounts.test.ts`: a real Inbox. Not installed, the sample, every usage shape, exit 1, garbage, an unknown schema, a hung `cswap` killed with its children (it stops ticking), the Inbox stopping, two reads running it once, a guest, another site, and an added `accessToken` proven absent from the answer, the logs and the data dir.
- `packages/inbox/accountsSection.test.tsx` (DOM): every state in the whole window over a real server, and the phone's list of sections.
- `tests/e2e/inbox-accounts.spec.ts`: the compiled binary in Chromium at 1440 and on a phone: the columns, three windows on a line, an open row, and nothing running past its edge with 12 accounts of long names. PNGs in `.local/proof/inbox-accounts-step1/`.
