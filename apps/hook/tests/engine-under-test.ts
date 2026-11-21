// The Claude Code version the engine harness runs under. scripts/test-claude-code-mod.sh writes
// this file into its staged copy from `claude --version`; the copy kept here is for a run that
// does not go through it (`claude plugin test` by hand), which then knows no version.
// A test reads it to hold the engine to what that version must offer (register.test.ts:
// "Claude Code's guard from 2.1.326"), since a test's own `$` cannot tell.
export const CLAUDE_CODE_VERSION: string | undefined = undefined
