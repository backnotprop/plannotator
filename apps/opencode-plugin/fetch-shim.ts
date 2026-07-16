export function recoverNativeFetchConstructors(): void {
  // OpenCode's @hono/node-server can patch global.Response/Request with
  // polyfills that Bun.serve() rejects. Recover the native constructors from
  // the polyfill prototype chain before loading Bun-only server modules.
  if (typeof Response === "undefined" || typeof Request === "undefined") return;

  const responseProto = Object.getPrototypeOf(Response.prototype);
  if (
    responseProto?.constructor &&
    responseProto.constructor !== Response &&
    responseProto.constructor !== Object
  ) {
    globalThis.Response = responseProto.constructor;
  }

  const requestProto = Object.getPrototypeOf(Request.prototype);
  if (
    requestProto?.constructor &&
    requestProto.constructor !== Request &&
    requestProto.constructor !== Object
  ) {
    globalThis.Request = requestProto.constructor;
  }
}
