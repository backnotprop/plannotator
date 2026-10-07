// swift-tools-version: 5.10
//
// Plannotator Shots: the native macOS half of the screenshot HUD.
// Built into "Plannotator Shots.app" by build.sh; see README.md.

import PackageDescription

let package = Package(
    name: "PlannotatorShots",
    platforms: [.macOS("14.0")],
    products: [
        .executable(name: "PlannotatorShots", targets: ["PlannotatorShots"]),
    ],
    targets: [
        .executableTarget(
            name: "PlannotatorShots",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("Carbon"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("WebKit"),
                .linkedFramework("QuartzCore"),
                .linkedFramework("ApplicationServices"),
            ]
        ),
    ],
    swiftLanguageVersions: [.v5]
)
