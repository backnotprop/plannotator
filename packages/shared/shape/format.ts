// The Shape format lives in @plannotator/core (browser-safe), so the board's UI
// in @plannotator/ui reads the same types and diff. This shim keeps the store's
// imports in one place, as shared does for its other core modules.
export * from "@plannotator/core/shape";
