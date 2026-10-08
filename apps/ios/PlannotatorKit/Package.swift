// swift-tools-version: 6.2
// The Inbox client the app talks through: the device door's models and calls,
// the event stream, the pairing link, the Keychain item and the markdown
// splitter. No third-party dependencies.
import PackageDescription

let package = Package(
    name: "PlannotatorKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [.library(name: "PlannotatorKit", targets: ["PlannotatorKit"])],
    targets: [
        .target(name: "PlannotatorKit"),
        .testTarget(name: "PlannotatorKitTests", dependencies: ["PlannotatorKit"]),
    ]
)
