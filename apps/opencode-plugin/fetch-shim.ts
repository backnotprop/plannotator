export function recoverNativeFetchConstructors(): void {
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
