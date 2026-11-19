import AVFoundation
import InboxCore
import SwiftUI

/// First run: the camera, to scan the code on the computer (FLOWS 2, mock 1).
struct PairingScreen: View {
  /// True when another computer is already paired and this screen came up as a sheet.
  var another = false
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @State private var typing = false
  @State private var camera = AVCaptureDevice.authorizationStatus(for: .video)

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          VStack(alignment: .leading, spacing: 10) {
            Text(PhoneWords.pairTitle)
              .font(.largeTitle.bold())
              .foregroundStyle(Token.foreground)
              .accessibilityAddTraits(.isHeader)
            Text(PhoneWords.pairWhere)
              .font(.body)
              .foregroundStyle(Token.mutedForeground)
          }
          viewfinder
          failure
          VStack(spacing: 0) {
            way(PhoneWords.pairTypeInstead) { typing = true }
            if !another {
              Divider().overlay(Token.border)
              way(PhoneWords.pairTryDemo) { Task { await model.startDemo() } }
            }
          }
          Text(PhoneWords.pairPromise)
            .font(.footnote)
            .foregroundStyle(Token.mutedForeground)
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 24)
      }
      .scrollBounceBehavior(.basedOnSize)
      .background(Token.background.ignoresSafeArea())
      .sheet(isPresented: $typing) { TypeAddressSheet().environment(model) }
      .toolbar {
        if another { ToolbarItem(placement: .cancellationAction) { Button(PhoneWords.cancel) { dismiss() } } }
      }
      .onChange(of: model.session?.computer.id) { _, _ in if another { dismiss() } }
      .onAppear { model.clearPairingFailure() }
    }
    .task {
      if camera == .notDetermined {
        // The camera permission is asked here, with the reason (Info.plist).
        camera = await AVCaptureDevice.requestAccess(for: .video) ? .authorized : .denied
      }
    }
  }

  private var viewfinder: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 28, style: .continuous).fill(Color.black)
      if camera == .authorized, QRScanner.hasCamera {
        QRScanner { text in Task { await model.scanned(text) } }
          .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
          .accessibilityLabel(PhoneWords.pairTitle)
      } else if camera == .denied || camera == .restricted {
        VStack(spacing: 14) {
          Text(PhoneWords.pairCameraOff)
            .font(.callout)
            .multilineTextAlignment(.center)
            .foregroundStyle(.white)
          Button(PhoneWords.pairOpenSettings) {
            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
          }
          .buttonStyle(.borderedProminent)
        }
        .padding(28)
      } else if !QRScanner.hasCamera {
        Text(PhoneWords.pairNoCamera)
          .font(.callout)
          .foregroundStyle(.white.opacity(0.8))
      }
      ViewfinderCorners()
        .stroke(.white.opacity(0.92), style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
        .padding(72)
        .accessibilityHidden(true)
      if model.pairing == .working {
        ProgressView().controlSize(.large).tint(.white)
      }
    }
    .aspectRatio(1.06, contentMode: .fit)
  }

  @ViewBuilder private var failure: some View {
    if case .failed(let lines) = model.pairing, !lines.isEmpty {
      VStack(alignment: .leading, spacing: 4) {
        ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
          Text(line)
            .font(index == 0 ? .callout.weight(.semibold) : .callout)
            .foregroundStyle(index == 0 ? Token.destructive : Token.mutedForeground)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)
    }
  }

  private func way(_ title: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack {
        Text(title).font(.body).multilineTextAlignment(.leading)
        Spacer(minLength: 12)
        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).accessibilityHidden(true)
      }
      .foregroundStyle(Token.primary)
      .frame(minHeight: 52)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

/// A pairing link opened from outside the app: who it is, and two equal actions. Nothing was asked of that
/// computer before this sheet, and nothing is unless the person says Pair.
struct OfferedPairingSheet: View {
  let link: PairLink
  @Environment(AppModel.self) private var model

  private var working: Bool { model.pairing == .working }
  @Environment(\.dynamicTypeSize) private var typeSize
  /// The words and actions, measured: the sheet is as tall as they are. Measured before the sheet is presented
  /// (`initial`), so it opens at its height and never resizes on its first frame.
  @State private var fitted: CGFloat

  /// The width the sheet is shown at, told back so the next measure is taken at it.
  var shownWidth: (CGFloat) -> Void = { _ in }

  init(link: PairLink, initial: CGFloat, shownWidth: @escaping (CGFloat) -> Void = { _ in }) {
    self.link = link
    self.shownWidth = shownWidth
    _fitted = State(initialValue: initial)
  }

  /// Presented as the system presents a confirmation: a sheet over the dimmed list, as tall as what it says, the
  /// two actions at its foot. Large words take the whole height; words that still do not fit scroll.
  var body: some View {
    ScrollView {
      OfferedPairingContent(link: link)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fitted = $0 }
    }
    .scrollBounceBehavior(.basedOnSize)
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { shownWidth($0) }
    .presentationDetents(typeSize.isAccessibilitySize ? [.large] : [.height(fitted)])
    .presentationDragIndicator(.hidden)
    // Solid, a step lighter than the list in the dark: nothing of the list shows through the words.
    .presentationBackground(Token.card)
    // While it pairs the sheet stays: the person sees it work, and sees why if it fails.
    .interactiveDismissDisabled(working)
  }
}

/// What the pairing sheet says, with its margins: measured once off screen before the sheet opens, then shown in it.
struct OfferedPairingContent: View {
  let link: PairLink
  @Environment(AppModel.self) private var model

  private var working: Bool { model.pairing == .working }

  var body: some View {
    content
      .padding(.horizontal, 24)
      .padding(.top, 32)
      .padding(.bottom, 16)
  }

  private var content: some View {
    VStack(spacing: 28) {
      VStack(spacing: 10) {
        Text(PhoneWords.pairAsk).font(.headline).foregroundStyle(Token.mutedForeground)
        // What the phone can vouch for: where the link leads.
        Text(link.addresses.map(\.hostPort).joined(separator: "\n"))
          .font(.title3.weight(.semibold))
          .multilineTextAlignment(.center)
          .foregroundStyle(Token.foreground)
          .textSelection(.enabled)
        VStack(spacing: 2) {
          // What the link says of itself: not checked by anything until the computer answers.
          if !link.name.isEmpty { Text(PhoneWords.pairCallsItself(link.name)) }
          Text(PhoneWords.pairAskDetail)
        }
        .font(.callout)
        .multilineTextAlignment(.center)
        .foregroundStyle(Token.mutedForeground)
      }
      if working {
        HStack(spacing: 10) {
          ProgressView()
          Text(PhoneWords.pairing).font(.callout).foregroundStyle(Token.mutedForeground)
        }
        .frame(minHeight: 50)
        .accessibilityElement(children: .combine)
      } else {
        if case .failed(let lines) = model.pairing {
          VStack(spacing: 4) {
            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
              Text(line).font(.callout.weight(index == 0 ? .semibold : .regular)).foregroundStyle(index == 0 ? Token.destructive : Token.mutedForeground).multilineTextAlignment(.center)
            }
          }
          .accessibilityElement(children: .combine)
        }
        HStack(spacing: 12) {
          Button(PhoneWords.cancel) { model.declineOffered() }.buttonStyle(SheetChoice(leads: false))
          Button(PhoneWords.pairAction) { Task { await model.acceptOffered() } }.buttonStyle(SheetChoice(leads: true))
        }
      }
    }
  }
}

/// The sheet's two actions, the same size: Pair is the filled one, Cancel the quiet one beside it.
struct SheetChoice: ButtonStyle {
  let leads: Bool

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.body.weight(.semibold))
      .foregroundStyle(leads ? Token.primaryForeground : Token.foreground)
      .frame(maxWidth: .infinity, minHeight: 50)
      .background((leads ? Token.primary : Token.muted).opacity(configuration.isPressed ? 0.6 : 1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
  }
}

extension PairLink: @retroactive Identifiable {
  public var id: String { secret }
}

/// The four corners of the viewfinder.
struct ViewfinderCorners: Shape {
  func path(in rect: CGRect) -> Path {
    let arm = min(rect.width, rect.height) * 0.16
    let radius = arm * 0.5
    var path = Path()
    for (x, y, dx, dy) in [(rect.minX, rect.minY, 1.0, 1.0), (rect.maxX, rect.minY, -1.0, 1.0), (rect.maxX, rect.maxY, -1.0, -1.0), (rect.minX, rect.maxY, 1.0, -1.0)] {
      path.move(to: CGPoint(x: x, y: y + dy * arm))
      path.addLine(to: CGPoint(x: x, y: y + dy * radius))
      path.addQuadCurve(to: CGPoint(x: x + dx * radius, y: y), control: CGPoint(x: x, y: y))
      path.addLine(to: CGPoint(x: x + dx * arm, y: y))
    }
    return path
  }
}

/// "Type the address and six digits": the tailnet only, as the window says.
struct TypeAddressSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var address = ""
  @State private var digits = ""
  @FocusState private var focus: Field?
  enum Field { case address, digits }

  private var ready: Bool { !address.trimmingCharacters(in: .whitespaces).isEmpty && digits.count == 6 }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField(PhoneWords.pairAddress, text: $address, prompt: Text(PhoneWords.pairAddressHint))
            .textContentType(.URL)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .focused($focus, equals: .address)
            .submitLabel(.next)
            .onSubmit { focus = .digits }
            .accessibilityLabel(PhoneWords.pairAddress)
          TextField(PhoneWords.pairDigits, text: $digits)
            .keyboardType(.numberPad)
            .textContentType(.oneTimeCode)
            .font(.body.monospacedDigit())
            .focused($focus, equals: .digits)
            .onChange(of: digits) { _, now in digits = String(now.filter(\.isNumber).prefix(6)) }
            .accessibilityLabel(PhoneWords.pairDigits)
        } footer: {
          VStack(alignment: .leading, spacing: 6) {
            Text(PhoneWords.pairTailnetOnly)
            if case .failed(let lines) = model.pairing {
              ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                Text(line).foregroundStyle(index == 0 ? Token.destructive : Token.mutedForeground)
              }
            }
          }
        }
      }
      .navigationTitle(PhoneWords.pairTypeInstead)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(PhoneWords.cancel) { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          if model.pairing == .working {
            ProgressView()
          } else {
            Button(PhoneWords.pairAction) { Task { await model.pair(address: address, code: digits) } }
              .disabled(!ready)
          }
        }
      }
      .onAppear {
        model.clearPairingFailure()
        focus = .address
      }
      .onDisappear { model.clearPairingFailure() }
    }
    .presentationDetents([.medium, .large])
  }
}

/// The camera, reading QR codes. Each code is handed on once.
struct QRScanner: UIViewRepresentable {
  static var hasCamera: Bool { AVCaptureDevice.default(for: .video) != nil }
  let found: (String) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(found: found) }

  func makeUIView(context: Context) -> Preview {
    let view = Preview()
    view.layer.videoGravity = .resizeAspectFill
    context.coordinator.start(on: view.layer)
    return view
  }

  func updateUIView(_ view: Preview, context: Context) {}

  static func dismantleUIView(_ view: Preview, coordinator: Coordinator) { coordinator.stop() }

  final class Preview: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    override var layer: AVCaptureVideoPreviewLayer { super.layer as! AVCaptureVideoPreviewLayer }
  }

  final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "ai.plannotator.inbox.camera")
    private let found: (String) -> Void
    private var last: String?
    private var lastAt = Date.distantPast

    init(found: @escaping (String) -> Void) { self.found = found }

    @MainActor
    func start(on layer: AVCaptureVideoPreviewLayer) {
      layer.session = session
      queue.async { [self] in
        guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return }
        session.beginConfiguration()
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        if session.canAddOutput(output) {
          session.addOutput(output)
          output.setMetadataObjectsDelegate(self, queue: .main)
          if output.availableMetadataObjectTypes.contains(.qr) { output.metadataObjectTypes = [.qr] }
        }
        session.commitConfiguration()
        session.startRunning()
      }
    }

    func stop() { queue.async { [self] in if session.isRunning { session.stopRunning() } } }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
      guard let text = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
      // The same code stays in view for seconds: hand it on once, and again only after a pause.
      if text == last, Date().timeIntervalSince(lastAt) < 4 { return }
      last = text
      lastAt = Date()
      found(text)
    }
  }
}
