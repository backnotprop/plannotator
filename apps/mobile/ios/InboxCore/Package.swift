// swift-tools-version: 6.0
// The native app's core: no UIKit, so `swift test` runs it on a Mac with no simulator.
import PackageDescription

let package = Package(
  name: "InboxCore",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    .library(name: "InboxCore", targets: ["InboxCore"]),
    .library(name: "InboxStandIn", targets: ["InboxStandIn"]),
  ],
  targets: [
    // Wire.swift and Words.swift are symlinks into apps/mobile/contract/generated/swift: referenced, never copied.
    .target(name: "InboxWire"),
    .target(name: "InboxCore", dependencies: ["InboxWire"]),
    // A door that answers from memory: the app's "Try it without a computer", the tests and the screenshots.
    .target(name: "InboxStandIn", dependencies: ["InboxCore"]),
    .testTarget(name: "InboxCoreTests", dependencies: ["InboxCore", "InboxStandIn"]),
  ],
  swiftLanguageModes: [.v6]
)
