import {
  annotateOutcomeExitCode,
  serializeStrictAnnotateResult,
  STRICT_GATE_ERROR_EXIT_CODE,
  writeAnnotateResultFile,
  type AnnotateOutcome,
} from "./strict-annotate-result";

export interface CompleteAnnotateCommandOptions {
  waitForDecision: () => Promise<AnnotateOutcome>;
  settleAfterDecision: () => Promise<void>;
  stopServer: () => void;
  requireApproval: boolean;
  resultFile?: string;
  writeResultFile?: (
    resultFile: string,
    serialized: string,
  ) => Promise<void>;
  writeStdout?: (output: string) => Promise<void>;
  emitLegacyOutcome: (result: AnnotateOutcome) => void;
  exit?: (code: number) => void;
  logError?: (message: string) => void;
}

export function writeStdout(output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(output, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function completeAnnotateCommand({
  waitForDecision,
  settleAfterDecision,
  stopServer,
  requireApproval,
  resultFile,
  writeResultFile = writeAnnotateResultFile,
  writeStdout: outputWriter = writeStdout,
  emitLegacyOutcome,
  exit = process.exit,
  logError = (message) => console.error(message),
}: CompleteAnnotateCommandOptions): Promise<void> {
  const result = await waitForDecision();
  await settleAfterDecision();
  stopServer();

  if (requireApproval || resultFile) {
    const serialized = serializeStrictAnnotateResult(result);
    try {
      // stdout first: the reviewer's autosaved draft is already gone by the
      // time we get here, so their completed decision must reach at least one
      // channel before a result-file publication failure can abort the run.
      // Result-file publication is best-effort on top of that record.
      await outputWriter(`${serialized}\n`);
      if (resultFile) {
        await writeResultFile(resultFile, serialized);
      }
    } catch (error) {
      // The result file was not published (or stdout itself was unwritable):
      // an environment error, not a reviewer outcome. Exit 2 — fail-closed, but
      // distinct from exit 1's "gate ran and the reviewer did not approve".
      // The stdout decision record has already been emitted unless stdout was
      // the thing that failed.
      logError(error instanceof Error ? error.message : String(error));
      exit(STRICT_GATE_ERROR_EXIT_CODE);
      return;
    }
    exit(annotateOutcomeExitCode(result, requireApproval));
    return;
  }

  emitLegacyOutcome(result);
  exit(0);
}
