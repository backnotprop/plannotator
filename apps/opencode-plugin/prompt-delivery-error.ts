const OPENCODE_PROMPT_DELIVERY_ERROR_CODE =
  "PLANNOTATOR_OPENCODE_PROMPT_DELIVERY";

export class OpenCodePromptDeliveryError extends Error {
  readonly code = OPENCODE_PROMPT_DELIVERY_ERROR_CODE;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenCodePromptDeliveryError";
  }
}

export function isOpenCodePromptDeliveryError(
  error: unknown,
): error is OpenCodePromptDeliveryError {
  return error instanceof OpenCodePromptDeliveryError
    || (
      error instanceof Error
      && (error as Error & { code?: string }).code
        === OPENCODE_PROMPT_DELIVERY_ERROR_CODE
    );
}

export function shouldFallbackAfterEmbeddedError(
  runtime: string,
  error: unknown,
): boolean {
  return runtime !== "embedded" && !isOpenCodePromptDeliveryError(error);
}

export async function deliverOpenCodePrompt(input: {
  client: any;
  prompt: unknown;
  failureMessage: string;
}): Promise<void> {
  try {
    if (typeof input.client.session?.prompt !== "function") {
      throw new Error("OpenCode session prompt API is unavailable.");
    }
    await input.client.session.prompt(input.prompt);
  } catch (error) {
    try {
      void input.client.app?.log?.({
        level: "error",
        message: `[Plannotator] ${input.failureMessage}`,
      });
    } catch {
      // Preserve the delivery failure if logging is unavailable.
    }
    throw new OpenCodePromptDeliveryError(input.failureMessage, {
      cause: error,
    });
  }
}
