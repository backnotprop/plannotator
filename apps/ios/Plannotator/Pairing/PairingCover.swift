import AVFoundation
import PlannotatorKit
import SwiftUI
import VisionKit

/// 1.2: a full-screen camera cover that reads the computer's pairing code,
/// with "Find it nearby instead" (1.3) for a phone that cannot scan it.
struct PairingCover: View {
    var body: some View {
        NavigationStack {
            ScanScreen()
                .navigationDestination(for: NearbyRoute.self) { _ in NearbyScreen() }
        }
    }
}

struct NearbyRoute: Hashable {}

struct ScanScreen: View {
    @Environment(AppModel.self) private var model
    @State private var camera: CameraState = .asking
    @State private var torch = false
    @State private var message: String?
    @State private var busy = false
    @State private var lastCode: String?

    enum CameraState { case asking, ready, unavailable }

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.ignoresSafeArea()
            switch camera {
            case .ready:
                QRScanner(onCode: read).ignoresSafeArea()
                Viewfinder().frame(width: 206, height: 206).frame(maxHeight: .infinity).padding(.bottom, 180)
            case .unavailable:
                VStack(spacing: 8) {
                    Image(systemName: "camera").font(.largeTitle).foregroundStyle(.white.opacity(0.6))
                    Text("The camera isn't available.").foregroundStyle(.white.opacity(0.75))
                }
                .frame(maxHeight: .infinity)
                .padding(.bottom, 180)
            case .asking:
                EmptyView()
            }
            panel
        }
        .navigationTitle("Scan the code")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(role: .close) { model.pairing = false }
                    .accessibilityIdentifier("pairing-close")
            }
            if camera == .ready, Self.hasTorch {
                ToolbarItem(placement: .primaryAction) {
                    Button { setTorch(!torch) } label: {
                        Label(torch ? "Turn Off Light" : "Turn On Light", systemImage: torch ? "flashlight.on.fill" : "flashlight.off.fill")
                    }
                }
            }
        }
        .task {
            // No camera (the simulator), no prompt.
            guard DataScannerViewController.isSupported, await AVCaptureDevice.requestAccess(for: .video) else {
                camera = .unavailable
                return
            }
            camera = DataScannerViewController.isAvailable ? .ready : .unavailable
        }
        .onDisappear { if torch { setTorch(false) } }
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Point at the code on your computer")
                .font(.title3.bold())
            Text(message ?? "In the Inbox on your computer, open Settings, then Pair a phone.")
                .font(.subheadline)
                .foregroundStyle(message == nil ? Color.inkSecondary : Color.destructive)
                .padding(.bottom, 12)
            NavigationLink(value: NearbyRoute()) {
                Label("Find it nearby instead", systemImage: "wifi")
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(Color.fill, in: .capsule)
                    .foregroundStyle(Color.ink)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("find-nearby")
        }
        .overlay(alignment: .topTrailing) { if busy { ProgressView() } }
        .padding(.horizontal, 22)
        .padding(.top, 22)
        .padding(.bottom, 30)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: .rect(cornerRadius: 38))
        .padding(8)
    }

    private func read(_ text: String) {
        guard !busy, text != lastCode else { return }
        lastCode = text
        switch PairLink.parse(text) {
        case .failure(.newerVersion):
            message = "This code comes from a newer Plannotator. Update the app to pair."
            Haptics.error()
        case .failure:
            message = "That code is not a Plannotator pairing code."
        case .success(let link):
            busy = true
            message = nil
            Task {
                defer { busy = false }
                do throws(InboxError) {
                    try await model.pair(link: link)
                    Haptics.success()
                } catch {
                    Haptics.error()
                    message = error.message
                    lastCode = nil
                }
            }
        }
    }

    private static var hasTorch: Bool { AVCaptureDevice.default(for: .video)?.hasTorch ?? false }

    private func setTorch(_ on: Bool) {
        guard let device = AVCaptureDevice.default(for: .video), device.hasTorch, (try? device.lockForConfiguration()) != nil else { return }
        device.torchMode = on ? .on : .off
        device.unlockForConfiguration()
        torch = on
    }
}

/// The viewfinder's four corners.
private struct Viewfinder: View {
    var body: some View {
        GeometryReader { geo in
            let s = geo.size
            let arm: CGFloat = 46, r: CGFloat = 26
            Path { p in
                p.move(to: CGPoint(x: 0, y: arm)); p.addLine(to: CGPoint(x: 0, y: r)); p.addQuadCurve(to: CGPoint(x: r, y: 0), control: .zero); p.addLine(to: CGPoint(x: arm, y: 0))
                p.move(to: CGPoint(x: s.width - arm, y: 0)); p.addLine(to: CGPoint(x: s.width - r, y: 0)); p.addQuadCurve(to: CGPoint(x: s.width, y: r), control: CGPoint(x: s.width, y: 0)); p.addLine(to: CGPoint(x: s.width, y: arm))
                p.move(to: CGPoint(x: s.width, y: s.height - arm)); p.addLine(to: CGPoint(x: s.width, y: s.height - r)); p.addQuadCurve(to: CGPoint(x: s.width - r, y: s.height), control: CGPoint(x: s.width, y: s.height)); p.addLine(to: CGPoint(x: s.width - arm, y: s.height))
                p.move(to: CGPoint(x: arm, y: s.height)); p.addLine(to: CGPoint(x: r, y: s.height)); p.addQuadCurve(to: CGPoint(x: 0, y: s.height - r), control: CGPoint(x: 0, y: s.height)); p.addLine(to: CGPoint(x: 0, y: s.height - arm))
            }
            .stroke(.white, style: StrokeStyle(lineWidth: 5, lineCap: .round))
        }
        .accessibilityHidden(true)
    }
}

/// VisionKit's scanner, reading QR codes only.
struct QRScanner: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, isHighlightingEnabled: false)
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        context.coordinator.onCode = onCode
    }

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onCode: (String) -> Void
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for case .barcode(let code) in items {
                if let text = code.payloadStringValue { onCode(text) }
            }
        }
    }
}
