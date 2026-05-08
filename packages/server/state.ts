import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DocMode = "plan" | "review" | "annotate";
export type DocumentOrigin = "claude-code" | "opencode";

export type DocumentSnapshot = {
  id: string;
  mode: DocMode;
  origin: DocumentOrigin;
  content: string;
  filePath?: string;
  gitRef?: string;
};

export type FeedbackPayload = {
  approved: boolean;
  feedback: string;
  annotations: Array<Record<string, unknown>>;
  agentSwitch?: string;
  permissionMode?: string;
  cancelled?: boolean;
};

type IdleDaemonState = {
  schemaVersion: 1;
  status: "idle";
  document: null;
  feedback: null;
};

type AwaitingResponseDaemonState = {
  schemaVersion: 1;
  status: "awaiting-response";
  document: DocumentSnapshot;
  feedback: null;
};

type AwaitingRevisionDaemonState = {
  schemaVersion: 1;
  status: "awaiting-revision";
  document: DocumentSnapshot;
  feedback: FeedbackPayload;
};

export type DaemonState =
  | IdleDaemonState
  | AwaitingResponseDaemonState
  | AwaitingRevisionDaemonState;

export type StateEvent =
  | { type: "submit"; document: DocumentSnapshot }
  | { type: "resolve"; feedback: FeedbackPayload }
  | { type: "clear" };

const SCHEMA_VERSION = 1;

export const IDLE_STATE: DaemonState = {
  schemaVersion: SCHEMA_VERSION,
  status: "idle",
  document: null,
  feedback: null,
};

function createIdleState(): DaemonState {
  return { ...IDLE_STATE };
}

function getStateDir(): string {
  return join(homedir(), ".plannotator");
}

function getStatePath(): string {
  return join(getStateDir(), "state.json");
}

function getTempStatePath(): string {
  return `${getStatePath()}.tmp`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  return value;
}

function expectOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectString(value, label);
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }

  return value;
}

function expectAnnotations(
  value: unknown,
  label: string,
): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`${label}[${index}] must be an object`);
    }

    return entry;
  });
}

function validateDocumentSnapshot(
  value: unknown,
  label: string,
): DocumentSnapshot {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  const mode = value.mode;
  if (mode !== "plan" && mode !== "review" && mode !== "annotate") {
    throw new Error(`${label}.mode must be plan, review, or annotate`);
  }

  const origin = value.origin;
  if (origin !== "claude-code" && origin !== "opencode") {
    throw new Error(`${label}.origin must be claude-code or opencode`);
  }

  return {
    id: expectString(value.id, `${label}.id`),
    mode,
    origin,
    content: expectString(value.content, `${label}.content`),
    filePath: expectOptionalString(value.filePath, `${label}.filePath`),
    gitRef: expectOptionalString(value.gitRef, `${label}.gitRef`),
  };
}

function validateFeedbackPayload(
  value: unknown,
  label: string,
): FeedbackPayload {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  return {
    approved: expectBoolean(value.approved, `${label}.approved`),
    feedback: expectString(value.feedback, `${label}.feedback`),
    annotations: expectAnnotations(value.annotations, `${label}.annotations`),
    agentSwitch: expectOptionalString(value.agentSwitch, `${label}.agentSwitch`),
    permissionMode: expectOptionalString(
      value.permissionMode,
      `${label}.permissionMode`,
    ),
    cancelled:
      value.cancelled === undefined
        ? undefined
        : expectBoolean(value.cancelled, `${label}.cancelled`),
  };
}

function validateDaemonState(value: unknown, label = "daemon state"): DaemonState {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `${label} has unsupported schema version ${String(value.schemaVersion)}`,
    );
  }

  const status = value.status;
  if (status !== "idle" && status !== "awaiting-response" && status !== "awaiting-revision") {
    throw new Error(`${label} has invalid status ${String(status)}`);
  }

  if (status === "idle") {
    if (value.document !== null || value.feedback !== null) {
      throw new Error(`${label} idle state must have null document and feedback`);
    }

    return createIdleState();
  }

  const document = validateDocumentSnapshot(value.document, `${label}.document`);

  if (status === "awaiting-response") {
    if (value.feedback !== null) {
      throw new Error(
        `${label} awaiting-response state must not have persisted feedback`,
      );
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      status,
      document,
      feedback: null,
    };
  }

  if (value.feedback === null) {
    throw new Error(`${label} resolved state must include feedback`);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    status,
    document,
    feedback: validateFeedbackPayload(value.feedback, `${label}.feedback`),
  };
}

function validateEvent(event: StateEvent): StateEvent {
  switch (event.type) {
    case "submit":
      return {
        type: "submit",
        document: validateDocumentSnapshot(event.document, "submit document"),
      };
    case "resolve":
      return {
        type: "resolve",
        feedback: validateFeedbackPayload(event.feedback, "resolve feedback"),
      };
    case "clear":
      return event;
    default: {
      const exhaustive: never = event;
      throw new Error(`Unknown state event ${(exhaustive as { type?: string }).type}`);
    }
  }
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") {
    return;
  }

  const directoryFd = openSync(path, "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

export function transition(current: DaemonState, event: StateEvent): DaemonState {
  const validatedCurrent = validateDaemonState(current, "current daemon state");
  const validatedEvent = validateEvent(event);

  if (validatedCurrent.status === "idle" && validatedEvent.type === "submit") {
    return {
      schemaVersion: SCHEMA_VERSION,
      status: "awaiting-response",
      document: validatedEvent.document,
      feedback: null,
    };
  }

  if (
    validatedCurrent.status === "awaiting-response" &&
    validatedEvent.type === "resolve"
  ) {
    // If approved, go to idle (workflow complete)
    // If needs revision, go to awaiting-revision
    if (validatedEvent.feedback.approved) {
      return createIdleState();
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      status: "awaiting-revision",
      document: validatedCurrent.document,
      feedback: validatedEvent.feedback,
    };
  }

  if (validatedCurrent.status === "awaiting-revision" && validatedEvent.type === "clear") {
    return createIdleState();
  }

  if (validatedCurrent.status === "awaiting-revision" && validatedEvent.type === "submit") {
    // Allow revision submission: must match the document being revised
    const currentDoc = validatedCurrent.document;
    const newDoc = validatedEvent.document;

    if (currentDoc.id !== newDoc.id) {
      throw new Error(
        `Cannot submit unrelated plan. Currently revising "${currentDoc.id}". ` +
        `Run 'plannotator clear' to abandon current work.`
      );
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      status: "awaiting-response",
      document: validatedEvent.document,
      feedback: null,
    };
  }

  throw new Error(
    `Illegal state transition from ${validatedCurrent.status} via ${validatedEvent.type}`,
  );
}

export function loadState(): DaemonState {
  const statePath = getStatePath();

  if (!existsSync(statePath)) {
    return createIdleState();
  }

  const rawState = readFileSync(statePath, "utf8");

  let parsedState: unknown;
  try {
    parsedState = JSON.parse(rawState);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse daemon state JSON at ${statePath}: ${message}`);
  }

  return validateDaemonState(parsedState, `persisted daemon state at ${statePath}`);
}

export function saveState(state: DaemonState): void {
  const validatedState = validateDaemonState(state, "state to persist");
  const serializedState = JSON.stringify(validatedState);
  const stateDir = getStateDir();
  const statePath = getStatePath();
  const tempStatePath = getTempStatePath();

  mkdirSync(stateDir, { recursive: true });

  const tempFd = openSync(tempStatePath, "w", 0o600);
  try {
    writeFileSync(tempFd, serializedState, "utf8");
    fsyncSync(tempFd);
  } finally {
    closeSync(tempFd);
  }

  renameSync(tempStatePath, statePath);
  syncDirectory(stateDir);
}
