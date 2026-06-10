import { recoverNativeFetchConstructors } from "./fetch-shim";

export interface EmbeddedPlanReviewInput {
  client: any;
  planContent: string;
  sharingEnabled: boolean;
  shareBaseUrl?: string;
  pasteApiUrl?: string;
  htmlContent: string;
  timeoutSeconds: number | null;
  logReady: (url: string, isRemote: boolean, port: number) => void;
}

export interface EmbeddedPlanReviewResult {
  approved: boolean;
  feedback?: string;
  savedPath?: string;
  agentSwitch?: string;
}

async function loadPlanServer() {
  recoverNativeFetchConstructors();
  return await import("@plannotator/server");
}

async function loadCommandHandlers() {
  recoverNativeFetchConstructors();
  return await import("./commands");
}

export async function runEmbeddedPlanReview(
  input: EmbeddedPlanReviewInput,
): Promise<EmbeddedPlanReviewResult> {
  const { startPlannotatorServer, handleServerReady } = await loadPlanServer();
  const server = await startPlannotatorServer({
    plan: input.planContent,
    origin: "opencode",
    sharingEnabled: input.sharingEnabled,
    shareBaseUrl: input.shareBaseUrl,
    pasteApiUrl: input.pasteApiUrl,
    htmlContent: input.htmlContent,
    opencodeClient: input.client,
    onReady: async (url, isRemote, port) => {
      await handleServerReady(url, isRemote, port);
      input.logReady(url, isRemote, port);
    },
  });

  const timeoutMs = input.timeoutSeconds === null ? null : input.timeoutSeconds * 1000;
  const result = timeoutMs === null
    ? await server.waitForDecision()
    : await new Promise<Awaited<ReturnType<typeof server.waitForDecision>>>((resolve) => {
        const timeoutId = setTimeout(
          () =>
            resolve({
              approved: false,
              feedback: `[Plannotator] No response within ${input.timeoutSeconds} seconds. Port released automatically. Please call submit_plan again.`,
            }),
          timeoutMs,
        );

        server.waitForDecision().then((decision) => {
          clearTimeout(timeoutId);
          resolve(decision);
        });
      });

  await Bun.sleep(1500);
  server.stop();
  return result;
}

export async function handleEmbeddedCommand(
  command: string,
  event: any,
  deps: {
    client: any;
    htmlContent: string;
    reviewHtmlContent: string;
    getSharingEnabled: () => Promise<boolean>;
    getShareBaseUrl: () => string | undefined;
    getPasteApiUrl: () => string | undefined;
    directory?: string;
  },
): Promise<{ feedback?: string | null }> {
  const {
    handleReviewCommand,
    handleAnnotateCommand,
    handleAnnotateLastCommand,
  } = await loadCommandHandlers();

  if (command === "plannotator-last") {
    return { feedback: await handleAnnotateLastCommand(event, deps) };
  }

  if (command === "plannotator-annotate") {
    await handleAnnotateCommand(event, deps);
    return {};
  }

  if (command === "plannotator-review") {
    await handleReviewCommand(event, deps);
    return {};
  }

  return {};
}
