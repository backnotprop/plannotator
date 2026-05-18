import type { DaemonErrorCode } from "@plannotator/shared/daemon-protocol";

export type DaemonApiError =
  | {
      kind: "network-error";
      message: string;
      cause?: unknown;
    }
  | {
      kind: "invalid-json";
      status: number;
      body: string;
      message: string;
    }
  | {
      kind: "daemon-error";
      status: number;
      code: DaemonErrorCode;
      message: string;
    }
  | {
      kind: "http-error";
      status: number;
      message: string;
    }
  | {
      kind: "invalid-payload";
      message: string;
      value: unknown;
    };

export type DaemonApiResult<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: DaemonApiError;
    };

export function errorMessage(error: DaemonApiError): string {
  return error.message;
}
