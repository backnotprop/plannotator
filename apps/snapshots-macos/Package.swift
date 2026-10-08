// swift-tools-version: 5.10
//
// Plannotator Snapshots: the native macOS half of the capture HUD.
// Built into "Plannotator Snapshots.app" by build.sh; see README.md.

import PackageDescription

let package = Package(
    name: "PlannotatorSnapshots",
    platforms: [.macOS("14.0")],
    products: [
        .executable(name: "PlannotatorSnapshots", targets: ["PlannotatorSnapshots"]),
    ],
    targets: [
        // The trust decisions (URL commands, the hub origin, the CLI's location), pure and unit tested.
        .target(name: "SnapshotsSecurity"),
        .executableTarget(
            name: "PlannotatorSnapshots",
            dependencies: ["SnapshotsSecurity"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("Carbon"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("WebKit"),
                .linkedFramework("QuartzCore"),
                .linkedFramework("ApplicationServices"),
            ]
        ),
        .testTarget(name: "SnapshotsSecurityTests", dependencies: ["SnapshotsSecurity"]),
    ],
    swiftLanguageVersions: [.v5]
)
