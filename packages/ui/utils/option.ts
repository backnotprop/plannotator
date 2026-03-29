/**
 * Minimal Option (Maybe) monad — avoids null/undefined in return types.
 */
export type Option<T> = Some<T> | None;

export interface Some<T> { readonly _tag: "Some"; readonly value: T }
export interface None   { readonly _tag: "None" }

export const some = <T>(value: T): Some<T> => ({ _tag: "Some", value });
export const none: None = { _tag: "None" };

export const isSome = <T>(opt: Option<T>): opt is Some<T> => opt._tag === "Some";
export const isNone = <T>(opt: Option<T>): opt is None    => opt._tag === "None";

/** Apply f to the value if Some, otherwise return none. */
export const map = <A, B>(opt: Option<A>, f: (a: A) => B): Option<B> =>
  isSome(opt) ? some(f(opt.value)) : none;

/** Return the value if Some, otherwise the fallback. */
export const getOrElse = <T>(opt: Option<T>, fallback: T): T =>
  isSome(opt) ? opt.value : fallback;
