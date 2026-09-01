/**
 * Test-suite default: the durable feedback archive is OFF.
 *
 * The archive is default-on in production and writes to the resolved data
 * directory at decision-settlement time. Most server tests boot a real plan,
 * review, or annotate server WITHOUT redirecting PLANNOTATOR_DATA_DIR (plan
 * and annotate history already go to the real dir because storage.ts captures
 * its data directory at import time), so leaving the archive on would have
 * every one of those tests deposit records in the contributor's own
 * ~/.plannotator/feedback — on CI and on every machine that runs `bun test`.
 * The repo's testing rules forbid touching the real user data dir, so the
 * suite opts out globally here.
 *
 * Set unconditionally rather than only when unset: a stray
 * PLANNOTATOR_FEEDBACK_HISTORY=1 in a contributor's shell must not silently
 * turn the whole suite back into a writer.
 *
 * The archive's own tests opt back in by setting the variable inside their
 * test bodies (restored in afterEach), which is also how they exercise the
 * opt-out path.
 */
process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
