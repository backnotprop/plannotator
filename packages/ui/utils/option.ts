/**
 * Minimal Option (Maybe) monad — avoids null/undefined in return types.
 */

/** Discriminated union representing a value that may or may not be present. */
export type Option<T> = Some<T> | None;

export interface Some<T> { readonly _tag: "Some"; readonly value: T }
export interface None   { readonly _tag: "None" }

/** Wraps a value in an Option. */
export const some = <T>(value: T): Some<T> => ({ _tag: "Some", value });

/** The empty Option — represents absence of a value. */
export const none: None = { _tag: "None" };

export const isSome = <T>(opt: Option<T>): opt is Some<T> => opt._tag === "Some";
export const isNone = <T>(opt: Option<T>): opt is None    => opt._tag === "None";

/** Apply f to the value if Some, otherwise return none. */
export const map = <A, B>(opt: Option<A>, f: (a: A) => B): Option<B> =>
  isSome(opt) ? some(f(opt.value)) : none;

/** Return the value if Some, otherwise the fallback. */
export const getOrElse = <T>(opt: Option<T>, fallback: T): T =>
  isSome(opt) ? opt.value : fallback;
