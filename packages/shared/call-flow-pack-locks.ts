import python from "./call-flow-runtime/packs/python/package-lock.json" with { type: "json" };
import go from "./call-flow-runtime/packs/go/package-lock.json" with { type: "json" };
import rust from "./call-flow-runtime/packs/rust/package-lock.json" with { type: "json" };
import java from "./call-flow-runtime/packs/java/package-lock.json" with { type: "json" };
import ruby from "./call-flow-runtime/packs/ruby/package-lock.json" with { type: "json" };
import c from "./call-flow-runtime/packs/c/package-lock.json" with { type: "json" };
import cpp from "./call-flow-runtime/packs/cpp/package-lock.json" with { type: "json" };
import csharp from "./call-flow-runtime/packs/csharp/package-lock.json" with { type: "json" };
import php from "./call-flow-runtime/packs/php/package-lock.json" with { type: "json" };
import kotlin from "./call-flow-runtime/packs/kotlin/package-lock.json" with { type: "json" };
import swift from "./call-flow-runtime/packs/swift/package-lock.json" with { type: "json" };
import scala from "./call-flow-runtime/packs/scala/package-lock.json" with { type: "json" };
import lua from "./call-flow-runtime/packs/lua/package-lock.json" with { type: "json" };
import elixir from "./call-flow-runtime/packs/elixir/package-lock.json" with { type: "json" };
import bash from "./call-flow-runtime/packs/bash/package-lock.json" with { type: "json" };
import haskell from "./call-flow-runtime/packs/haskell/package-lock.json" with { type: "json" };
import zig from "./call-flow-runtime/packs/zig/package-lock.json" with { type: "json" };
import solidity from "./call-flow-runtime/packs/solidity/package-lock.json" with { type: "json" };
import ocaml from "./call-flow-runtime/packs/ocaml/package-lock.json" with { type: "json" };
import type { CallFlowLanguageId } from "./call-flow-languages";

export type CallFlowPackLock = {
  readonly name: string;
  readonly version: string;
  readonly lockfileVersion: number;
  readonly packages: Readonly<Record<string, unknown>>;
};

/** Bundled npm locks; each optional grammar has an independent integrity root. */
export const CALL_FLOW_PACK_LOCKS: Readonly<Record<Exclude<CallFlowLanguageId, "javascript-typescript">, CallFlowPackLock>> = {
  python,
  go,
  rust,
  java,
  ruby,
  c,
  cpp,
  csharp,
  php,
  kotlin,
  swift,
  scala,
  lua,
  elixir,
  bash,
  haskell,
  zig,
  solidity,
  ocaml,
};
