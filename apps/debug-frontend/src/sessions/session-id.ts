const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

export function isValidSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

export function parseSessionId(value: string): string | false {
  return isValidSessionId(value) ? value : false;
}

export function encodeSessionId(value: string): string {
  if (!isValidSessionId(value)) {
    throw new Error(`Invalid Plannotator session id: ${value}`);
  }
  return encodeURIComponent(value);
}
