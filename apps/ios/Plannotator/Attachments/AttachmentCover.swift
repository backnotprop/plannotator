import PlannotatorKit
import SwiftUI
import UIKit
import WebKit

/// 4.1 to 4.4: an attachment full screen. The document and its marks are
/// Plannotator's surface (SurfaceHost); the bars, the switch, Parent and Child
/// and every composer are the shell's. A comment is saved through the door the
/// moment the person saves it and rides the next Send.
struct AttachmentCover: View {
    let session: SourceSession
    let threadId: String
    @State private var file: OpenFile

    init(session: SourceSession, threadId: String, file: OpenFile) {
        self.session = session
        self.threadId = threadId
        _file = State(initialValue: file)
    }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var view: InboxAttachmentView?
    @State private var loadProblem: String?
    /// Comment was chosen in the edit menu; the surface's answer opens the composer.
    @State private var awaitingSelection = false
    @State private var composer: Composer?
    @State private var words = ""
    @State private var saving = false
    @State private var panelProblem: String?
    /// A saved mark the person tapped (4.3).
    @State private var shown: InboxAnnotationRecord?
    @State private var editing: InboxAnnotationRecord?
    @State private var interact = false
    @State private var showList = false
    @State private var link: ContentLink?
    @State private var shareFile: URL?
    @FocusState private var focused: Bool

    private var host: SurfaceHost { .shared }
    private var thread: InboxThread? { session.threads[threadId] }
    private var agent: String { thread?.messages.first?.author.agentName ?? "The agent" }
    private var attachment: InboxAttachmentState? {
        view?.attachment ?? session.files[threadId]?.attachments.first { $0.id == file.attachmentId }
    }
    private var records: [InboxAnnotationRecord] { session.pendingAnnotations(thread: threadId) }
    private var fileCount: Int { records.filter { $0.attachmentId == file.attachmentId }.count }
    private var isText: Bool { attachment.map { !$0.isHTML && !$0.isDiagram } ?? false }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            if let line = changedLine { line }
            ZStack(alignment: .bottom) {
                if view != nil {
                    // An HTML page keeps its last lines above the switch, so a link at its foot can be reached;
                    // a text file draws under the home indicator, its toolstrip inside the surface.
                    SurfaceRepresentable(webView: host.webView)
                        .padding(.bottom, attachment?.isHTML == true ? 62 : 0)
                        .ignoresSafeArea(edges: attachment?.isHTML == true ? [] : .bottom)
                        .accessibilityIdentifier("surface")
                } else if let loadProblem {
                    ContentUnavailableView {
                        Label("Can't open \(attachment?.name ?? "this file")", systemImage: "doc.questionmark")
                    } description: {
                        Text(loadProblem)
                    } actions: {
                        Button("Try Again") { Task { await load() } }
                    }
                    .frame(maxHeight: .infinity)
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                bottom
            }
            .frame(maxHeight: .infinity)
        }
        .background(Color.screen.ignoresSafeArea())
        .overlay(alignment: .topLeading) { proofProbe }
        .task(id: file) { await load() }
        .onAppear(perform: attach)
        .onDisappear(perform: detach)
        .onChange(of: scheme) { sendAppearance() }
        .onChange(of: typeSize) { sendAppearance() }
        .sheet(isPresented: $showList) {
            AnnotationsSheet(session: session, threadId: threadId, current: file.attachmentId) { next in
                showList = false
                file = next
            }
        }
        .sheet(item: $editing) { record in
            EditAnnotationSheet(record: record, save: { text throws(InboxError) in
                try await session.saveAnnotation(thread: threadId, attachment: record.attachmentId, version: record.version, annotation: record.annotation.setting("text", to: .string(text)))
            }, onSaved: { saved in
                host.send(Bridge.CommitAnnotation(annotation: saved))
                shown = saved
            })
        }
        .fullScreenCover(item: $link) { ContentLinkView(link: $0) }
    }

    // MARK: Bars

    private var topBar: some View {
        HStack(spacing: 10) {
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 17, weight: .semibold)).frame(width: 44, height: 44).contentShape(.circle)
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .circle)
            .accessibilityLabel("Close")
            .accessibilityIdentifier("file-close")
            VStack(spacing: 1) {
                Text(attachment?.name ?? "").font(.headline).lineLimit(1)
                Text("\(agent) in \(thread?.project.name ?? "")").font(.footnote).foregroundStyle(Color.inkSecondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
            HStack(spacing: 0) {
                Button { showList = true } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "text.bubble")
                        if fileCount > 0 { Text("\(fileCount)").contentTransition(.numericText(value: Double(fileCount))) }
                    }
                    .font(.body.weight(.semibold))
                    .frame(minWidth: 44, minHeight: 44)
                    .padding(.leading, 8)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(plural(fileCount, "annotation")) on this file")
                .accessibilityIdentifier("file-count")
                Menu {
                    if let shareFile {
                        ShareLink(item: shareFile) { Label("Share", systemImage: "square.and.arrow.up") }
                            .accessibilityIdentifier("file-share")
                    }
                    if let attachment, attachment.changedSinceSent, attachment.unavailable == nil {
                        Button(file.sent ? "Open the File as It Is Now" : "Open the Version It Sent", systemImage: "clock.arrow.circlepath") {
                            file = OpenFile(attachmentId: file.attachmentId, sent: !file.sent)
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis").font(.system(size: 17, weight: .semibold)).frame(width: 44, height: 44)
                }
                .accessibilityLabel("More")
                .accessibilityIdentifier("file-more")
            }
            .padding(.trailing, 4)
            .glassEffect(.regular.interactive(), in: .capsule)
        }
        .foregroundStyle(Color.ink)
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 8)
        // A bar, as the system's own bars: it stops growing at the largest non-accessibility size.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    /// 4.1's line under the bar: the file changed since it was sent, or this is the sent version.
    private var changedLine: AnyView? {
        guard let attachment else { return nil }
        let sentAt = When.clock(attachment.sentAt)
        let text: AttributedString
        if let unavailable = attachment.unavailable {
            text = AttributedString("\(unavailable.message) This is the version \(agent) sent at \(sentAt).")
        } else if file.sent {
            text = AttributedString("The version \(agent) sent at \(sentAt). ") + Self.action("Open the file as it is now", "current")
        } else if attachment.changedSinceSent {
            let edited = attachment.current.map { " Edited \(When.clock($0.mtime))." } ?? ""
            text = AttributedString("Changed since \(agent) sent it at \(sentAt).\(edited) ") + Self.action("Open the version it sent", "sent")
        } else {
            return nil
        }
        return AnyView(
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: "info.circle").foregroundStyle(Color.warning).accessibilityHidden(true)
                Text(text).font(.subheadline).foregroundStyle(Color.ink).accessibilityIdentifier("changed-line")
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Color.warning.opacity(0.14))
            .overlay(alignment: .bottom) { Rectangle().fill(Color.warning.opacity(0.35)).frame(height: 1) }
            .environment(\.openURL, OpenURLAction { url in
                // The line's own action, never a URL leaving the app.
                file = OpenFile(attachmentId: file.attachmentId, sent: url.host() == "sent")
                return .handled
            })
        )
    }

    private static func action(_ title: String, _ version: String) -> AttributedString {
        var text = AttributedString(title)
        text.link = URL(string: "version://\(version)")
        text.foregroundColor = Color.tint
        text.font = .subheadline.weight(.semibold)
        return text
    }

    // MARK: The bottom: the HTML switch and the panels

    private var bottom: some View {
        VStack(spacing: 10) {
            if attachment?.isHTML == true, view != nil { modeStrip }
            if let composer {
                panel { composerContent(composer) }
            } else if let shown {
                panel { savedContent(shown) }
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .snappy, value: composer)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .snappy, value: shown)
    }

    /// 4.3's switch: Annotate (a tap pins) or Interact (the page's own clicks), and Fit.
    private var modeStrip: some View {
        HStack(spacing: 2) {
            modeButton("Annotate", symbol: "viewfinder", on: !interact) { setInteract(false) }
                .accessibilityIdentifier("mode-annotate")
            modeButton("Interact", symbol: "hand.point.up.left", on: interact) { setInteract(true) }
                .accessibilityIdentifier("mode-interact")
            Button {
                host.webView.scrollView.setZoomScale(host.webView.scrollView.minimumZoomScale, animated: true)
            } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right").frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Fit to screen")
            .accessibilityIdentifier("mode-fit")
        }
        .font(.body.weight(.medium))
        .foregroundStyle(Color.ink)
        .padding(4)
        .glassEffect(.regular, in: .capsule)
    }

    private func modeButton(_ title: String, symbol: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .foregroundStyle(on ? Color.tint : Color.ink)
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .background(on ? Color.tint.opacity(0.16) : .clear, in: .capsule)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func panel(@ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Capsule().fill(Color.inkSecondary.opacity(0.35)).frame(width: 36, height: 5).frame(maxWidth: .infinity)
            content()
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
        .padding(.bottom, 14)
        .background(Color.ground, in: UnevenRoundedRectangle(topLeadingRadius: 34, topTrailingRadius: 34))
        .shadow(color: .black.opacity(0.14), radius: 18, y: -2)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .gesture(DragGesture().onEnded { if $0.translation.height > 60 { closePanel() } })
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("comment-panel")
    }

    @ViewBuilder
    private func composerContent(_ composer: Composer) -> some View {
        switch composer.kind {
        case .selection(let quote):
            // 4.2: Cancel leading, Save trailing, the quote under its rule.
            HStack {
                Button { closePanel() } label: { Image(systemName: "xmark").font(.body.weight(.semibold)).frame(width: 44, height: 44) }
                    .buttonStyle(.plain)
                    .glassEffect(.regular.interactive(), in: .circle)
                    .accessibilityLabel("Cancel")
                    .accessibilityIdentifier("comment-cancel")
                Spacer()
                Text("Comment").font(.headline)
                Spacer()
                saveButton("Save")
            }
            QuoteRule(text: "\"\(quote)\"")
            wordsField
        case .pin(let label, let quote):
            // 4.3: the element, Parent and Child, the words, Save.
            HStack(spacing: 8) {
                Text("Comment").font(.subheadline.weight(.semibold)).foregroundStyle(Color.accent)
                Text(label).font(.system(.subheadline, design: .monospaced)).foregroundStyle(Color.inkSecondary).lineLimit(1)
                Spacer(minLength: 4)
                stepButton("Parent", symbol: "chevron.up", direction: "parent")
                stepButton("Child", symbol: "chevron.down", direction: "child")
            }
            if !quote.isEmpty {
                Text("\"\(quote)\"").font(.system(.subheadline, design: .monospaced)).foregroundStyle(Color.inkSecondary).lineLimit(2)
            }
            wordsField
            HStack(spacing: 10) {
                Spacer()
                cancelButton
                saveButton("Save")
            }
        case .part(let name, let detail):
            // 4.4: "On Pick a host (node E)", the field, Cancel and Comment.
            Text("On \(Text(name).fontWeight(.semibold).foregroundStyle(Color.ink))\(detail.map { " (\($0))" } ?? "")")
                .font(.subheadline)
                .foregroundStyle(Color.inkSecondary)
            wordsField
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(Color.card, in: .rect(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.hairline))
            HStack(spacing: 10) {
                Spacer()
                cancelButton
                saveButton("Comment")
            }
        }
        if let panelProblem {
            Text(panelProblem).font(.footnote).foregroundStyle(Color.destructive).accessibilityIdentifier("comment-problem")
        }
    }

    /// 4.3 at rest: a saved comment, with Edit and Remove.
    @ViewBuilder
    private func savedContent(_ record: InboxAnnotationRecord) -> some View {
        HStack(spacing: 8) {
            Text("Comment").font(.subheadline.weight(.semibold)).foregroundStyle(Color.accent)
            if let tag = record.tag { Text(tag).font(.system(.subheadline, design: .monospaced)).foregroundStyle(Color.inkSecondary) }
            Spacer()
        }
        Text("\"\(record.quote)\"").font(.system(.subheadline, design: .monospaced)).foregroundStyle(Color.inkSecondary).lineLimit(3)
        Text(record.text).font(.body).foregroundStyle(Color.ink).accessibilityIdentifier("shown-text")
        HStack(spacing: 18) {
            Text("You · \(When.clock(record.updatedAt))").foregroundStyle(Color.inkSecondary)
            Spacer()
            Button("Edit") { editing = record }.foregroundStyle(Color.tint).accessibilityIdentifier("shown-edit")
            Button("Remove", role: .destructive) { remove(record) }.foregroundStyle(Color.destructive).accessibilityIdentifier("shown-remove")
        }
        .font(.body.weight(.medium))
        .frame(minHeight: 44)
    }

    private var wordsField: some View {
        TextField("Your comment", text: $words, axis: .vertical)
            .font(.body)
            .lineLimit(2...8)
            .focused($focused)
            .accessibilityIdentifier("comment-text")
    }

    private var cancelButton: some View {
        Button("Cancel") { closePanel() }
            .buttonStyle(.glass)
            .controlSize(.large)
            .accessibilityIdentifier("comment-cancel")
    }

    private func saveButton(_ title: String) -> some View {
        Button(title) { save() }
            .buttonStyle(.glassProminent)
            .controlSize(.large)
            .disabled(words.trimmed.isEmpty || saving)
            .accessibilityIdentifier("comment-save")
    }

    private func stepButton(_ title: String, symbol: String, direction: String) -> some View {
        Button {
            Haptics.selection()
            host.stampTouch()
            host.send(Bridge.StepPin(direction: direction))
        } label: {
            Label(title, systemImage: symbol).font(.subheadline.weight(.medium)).lineLimit(1).padding(.horizontal, 4).frame(minHeight: 36)
        }
        .fixedSize()
        .buttonStyle(.glass)
        .accessibilityLabel(direction == "parent" ? "Pin the parent element" : "Pin the child element")
        .accessibilityIdentifier("pin-\(direction)")
    }

    /// Only with the proof running: how many bridge messages came from a frame other than the main one.
    @ViewBuilder
    private var proofProbe: some View {
        if ProcessInfo.processInfo.arguments.contains("-PlannotatorProof") {
            Text("\(host.droppedFrameMessages) \(host.droppedUntouched) \(host.cancelledNavigations)")
                .font(.system(size: 1))
                .opacity(0.01)
                .accessibilityIdentifier("bridge-dropped")
        }
    }

    // MARK: The surface

    private func attach() {
        host.warm()
        host.onEvent = { handle($0) }
        host.onLink = { link = $0 }
    }

    /// The screen is covered (Safari View Controller) or closed: the surface's
    /// events wait for it. What the open file set up stays until the next one replaces it.
    private func detach() {
        host.onEvent = nil
        host.onLink = nil
    }

    private func load() async {
        loadProblem = nil
        composer = nil
        shown = nil
        do throws(InboxError) {
            let sent = file.sent || attachment?.unavailable != nil
            let next = try await session.client.view(attachment: file.attachmentId, sent: sent)
            if sent != file.sent { file.sent = sent }
            view = next
            shareFile = Self.writeShareFile(next)
            await host.whenReady()
            present(next)
        } catch {
            loadProblem = error.message
        }
    }

    /// Hands the file to the surface: the theme, Annotate, the page with its base on the asset scheme.
    private func present(_ view: InboxAttachmentView) {
        let html = view.html.map(Self.assetBase)
        host.assets.client = session.client
        host.assets.token = html.flatMap(Self.assetToken)
        host.webView.onComment = isText ? { commentOnSelection() } : nil
        host.pageReported = view.attachment.isHTML
        // Pinch to zoom for a page drawn at its own width; a text file reflows instead.
        host.webView.scrollView.pinchGestureRecognizer?.isEnabled = view.attachment.isHTML
        host.webView.scrollView.setZoomScale(host.webView.scrollView.minimumZoomScale, animated: false)
        interact = false
        sendAppearance()
        host.send(Bridge.SetMode(mode: "annotate"))
        host.send(Bridge.OpenAttachment(
            attachment: view.attachment, version: view.version, text: view.text, html: html,
            annotations: records.filter { $0.attachmentId == view.attachment.id && $0.version == view.version },
            focus: file.focus))
    }

    private func handle(_ event: SurfaceEvent) {
        switch event {
        case .ready:
            // The page was loaded again (the system ended it): open the file again.
            if let view { present(view) }
        case .selection(let quote, let draft):
            if awaitingSelection {
                awaitingSelection = false
                if let draft { open(Composer(kind: .selection(quote: quote), draft: draft), keepWords: false) }
            }
        case .pin(let label, let draft):
            open(Composer(kind: .pin(label: label, quote: draft["originalText"]?.string ?? ""), draft: draft), keepWords: composer?.isPin == true)
        case .draft(let kind, let label, let draft):
            let (name, detail) = Self.split(label)
            open(Composer(kind: .part(name: name, detail: kind == "block" ? nil : detail), draft: draft), keepWords: false)
        case .annotation(let id):
            guard composer == nil else { return }
            shown = records.first { $0.id == id }
        case .error:
            break
        }
    }

    /// Comment in the edit menu: the surface makes the selection a draft, and the composer opens on it (4.2).
    private func commentOnSelection() {
        awaitingSelection = true
        host.send(Bridge.CommentSelection())
    }

    private func open(_ next: Composer, keepWords: Bool) {
        // The same part reported again (the diagram drawn again for a new theme) keeps what is typed.
        let keepWords = keepWords || composer?.kind == next.kind
        if let composer, composer.id != next.id, !keepWords { host.send(Bridge.RemoveAnnotation(id: composer.id)) }
        if !keepWords { words = "" }
        panelProblem = nil
        shown = nil
        composer = next
        // 4.2 writes at once; a pin or a diagram part (4.3, 4.4) keeps the page in view until the person taps the field.
        if case .selection = next.kind { focused = true }
    }

    private func closePanel() {
        if let composer { host.send(Bridge.RemoveAnnotation(id: composer.id)) }
        composer = nil
        shown = nil
        words = ""
        focused = false
    }

    private func save() {
        guard let composer, let view, !saving else { return }
        saving = true
        panelProblem = nil
        let annotation = composer.draft.setting("text", to: .string(words.trimmed))
        Task {
            defer { saving = false }
            do throws(InboxError) {
                let record = try await session.saveAnnotation(thread: threadId, attachment: view.attachment.id, version: view.version, annotation: annotation)
                host.send(Bridge.CommitAnnotation(annotation: record))
                Haptics.success()
                self.composer = nil
                words = ""
                focused = false
            } catch {
                Haptics.error()
                panelProblem = "Not saved. \(error.message)"
            }
        }
    }

    private func remove(_ record: InboxAnnotationRecord) {
        Task {
            do throws(InboxError) {
                try await session.removeAnnotation(thread: threadId, annotation: record.id)
                host.send(Bridge.RemoveAnnotation(id: record.id))
                shown = nil
            } catch {
                panelProblem = "Not removed. \(error.message)"
            }
        }
    }

    private func setInteract(_ on: Bool) {
        guard on != interact else { return }
        Haptics.selection()
        if on { closePanel() }
        interact = on
        host.send(Bridge.SetMode(mode: on ? "interact" : "annotate"))
    }

    private func sendAppearance() {
        // The body size at this Dynamic Type size over the default's (17 pt).
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(typeSize))
        let scale = UIFontMetrics(forTextStyle: .body).scaledValue(for: 17, compatibleWith: traits) / 17
        host.send(Bridge.SetAppearance(theme: scheme == .dark ? "dark" : "light", text_scale: Double(scale)))
    }

    // MARK: Helpers

    /// The view's `<base href>` moved from the door's root-relative asset route onto the asset scheme (contract section 5).
    static func assetBase(_ html: String) -> String {
        html.replacingOccurrences(of: "<base href=\"/api/html-assets/", with: "<base href=\"plannotator-asset://inbox/api/html-assets/")
    }

    static func assetToken(_ html: String) -> String? {
        html.firstMatch(of: /plannotator-asset:\/\/inbox\/api\/html-assets\/([^\/"]+)\//).map { String($0.1) }
    }

    /// "Pick a host (node E)" as the sheet draws it: the name bold, the part after it.
    static func split(_ label: String) -> (String, String?) {
        guard label.hasSuffix(")"), let open = label.range(of: " (", options: .backwards) else { return (label, nil) }
        return (String(label[..<open.lowerBound]), String(label[open.upperBound...].dropLast()))
    }

    /// Share (the "..." menu): the file's bytes as the view answered them, under its own name.
    static func writeShareFile(_ view: InboxAttachmentView) -> URL? {
        let dir = URL.temporaryDirectory.appending(path: "share/\(view.attachment.id)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appending(path: view.attachment.name)
        return (try? Data(view.text.utf8).write(to: url, options: .atomic)) != nil ? url : nil
    }
}

/// A comment being written: what it is on, and the surface's draft it fills in.
struct Composer: Equatable {
    enum Kind: Equatable {
        case selection(quote: String)
        case pin(label: String, quote: String)
        case part(name: String, detail: String?)
    }

    var kind: Kind
    var draft: JSONValue
    var id: String { draft["id"]?.string ?? "" }
    var isPin: Bool { if case .pin = kind { true } else { false } }
}

/// The shared surface web view, placed in the attachment screen.
struct SurfaceRepresentable: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .clear
        webView.removeFromSuperview()
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        return container
    }

    func updateUIView(_ view: UIView, context: Context) {}
}
