import PlannotatorKit
import SwiftUI
import UIKit

/// 6.1 and 6.2: a guided review full screen. The guide is Plannotator's guide
/// viewer in the surface (SurfaceHost): the sections with their reviewed ticks
/// and Continue, then one section per screen with its diffs unified and
/// wrapped, Previous, Reviewed and Next at the thumb. The bar is the shell's:
/// its title follows the surface's `section` messages ("02 of 04"), its close
/// button turns into back on a section, and on a section it carries the wrap
/// button. A tick is saved through the door the moment it is made (7.20).
struct GuideCover: View {
    let session: SourceSession
    let threadId: String
    let messageId: String

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize

    @State private var view: InboxGuideView?
    @State private var loadProblem: String?
    /// The surface has drawn the guide.
    @State private var painted = false
    /// The section on screen (6.2), or nil for the sections (6.1), as the surface last said.
    @State private var section: Int?
    @State private var sections = 0
    @State private var wrap = true
    @State private var link: ContentLink?
    @State private var problem: String?

    private var host: SurfaceHost { .shared }
    private var thread: InboxThread? { session.threads[threadId] }
    private var message: InboxMessage? { thread?.messages.first { $0.id == messageId } }
    private var agent: String { message?.author.agentName ?? "The agent" }
    private var project: String { thread?.project.name ?? "" }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            ZStack {
                if view != nil {
                    // Until the surface has drawn this guide the screen's own colour shows, never what it drew before.
                    SurfaceRepresentable(webView: host.webView)
                        .ignoresSafeArea(edges: .bottom)
                        .opacity(painted ? 1 : 0)
                        .accessibilityIdentifier("surface")
                } else if let loadProblem {
                    ContentUnavailableView {
                        Label("Can't open this guided review", systemImage: "book.closed")
                    } description: {
                        Text(loadProblem)
                    } actions: {
                        Button("Try Again") { Task { await load() } }
                    }
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color.ground.ignoresSafeArea())
        .task { await load() }
        .onAppear(perform: attach)
        .onDisappear(perform: detach)
        .onChange(of: scheme) { sendAppearance() }
        .onChange(of: typeSize) { sendAppearance() }
        .alert("Not saved", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(problem ?? "")
        }
        .fullScreenCover(item: $link) { ContentLinkView(link: $0) }
    }

    // MARK: The bar

    private var topBar: some View {
        HStack(spacing: 10) {
            if section == nil {
                barButton("xmark", size: 17, label: "Close", id: "guide-close") { dismiss() }
            } else {
                barButton("chevron.left", size: 19, label: "Sections", id: "guide-back") { showSections() }
            }
            VStack(spacing: 1) {
                Text(title).font(.headline).lineLimit(1).contentTransition(.numericText())
                Text(subtitle).font(.footnote).foregroundStyle(Color.inkSecondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("guide-title")
            if section == nil {
                Color.clear.frame(width: 44, height: 44).accessibilityHidden(true)
            } else {
                barButton("text.append", size: 17, label: "Wrap lines", id: "guide-wrap", tint: wrap) { toggleWrap() }
                    .accessibilityValue(wrap ? "On" : "Off")
            }
        }
        .foregroundStyle(Color.ink)
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 8)
        // A bar, as the system's own bars: it stops growing at the largest non-accessibility size.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    /// 6.1: "Guided review", the agent and when it was sent. 6.2: "02 of 04".
    private var title: String {
        guard let section, sections > 0 else { return "Guided review" }
        return "\(Self.two(section)) of \(Self.two(sections - 1))"
    }

    private var subtitle: String {
        guard section == nil else { return "Guided review · \(agent) in \(project)" }
        let sent = When.clock(message?.createdAt)
        return sent.isEmpty ? "\(agent) in \(project)" : "\(agent) in \(project), sent \(sent)"
    }

    private func barButton(_ symbol: String, size: CGFloat, label: String, id: String, tint: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: size, weight: .semibold))
                .foregroundStyle(tint ? Color.tint : Color.ink)
                .frame(width: 44, height: 44)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        .accessibilityLabel(label)
        .accessibilityIdentifier(id)
    }

    /// "02": the section's number as the guide writes it.
    static func two(_ index: Int) -> String { String(format: "%02d", index + 1) }

    // MARK: The surface

    private func attach() {
        host.warm()
        host.onEvent = { handle($0) }
        host.onLink = { link = $0 }
    }

    /// The screen is covered (Safari View Controller) or closed: the surface's events wait for it.
    private func detach() {
        host.onEvent = nil
        host.onLink = nil
    }

    private func load() async {
        loadProblem = nil
        do throws(InboxError) {
            // Guided reviews come from a computer's Inbox (submit_guide); a Workspaces source has none here.
            guard let door = session.inboxClient else {
                loadProblem = "Guided reviews open from a computer's Inbox."
                return
            }
            let next = try await door.guide(message: messageId)
            await host.whenReady()
            guard !host.isUnavailable, host.loadError == nil else {
                loadProblem = "Guided reviews can't be shown on this iPhone right now."
                return
            }
            view = next
            present(next, reviewed: message?.guideReviewed)
            await host.drawn()
            painted = true
        } catch {
            loadProblem = error.message
        }
    }

    /// Hands the guide to the surface: the theme and text size, the wrap, the
    /// ticks the Inbox keeps, and the section on screen when there is one.
    private func present(_ view: InboxGuideView, reviewed: [Bool]?) {
        host.assets.token = nil
        host.webView.onComment = nil
        host.pageReported = false
        host.webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        host.webView.scrollView.setZoomScale(host.webView.scrollView.minimumZoomScale, animated: false)
        sendAppearance()
        host.send(Bridge.SetWrap(wrap: wrap))
        host.send(Bridge.OpenGuide(message_id: messageId, guide: view.guide, snapshot: view.snapshot, reviewed: reviewed))
        if let section { host.send(Bridge.OpenSection(section: section)) }
    }

    private func handle(_ event: SurfaceEvent) {
        switch event {
        case .ready:
            // The page was loaded again (the system ended it): open the guide again where it was.
            if let view { present(view, reviewed: message?.guideReviewed) }
        case .reviewed(let id, let reviewed):
            guard id == messageId else { return }
            Haptics.selection()
            session.saveTicks(reviewed, message: id, thread: threadId) { words, kept in
                problem = words
                // The surface drew the tick the Inbox did not keep: give it the kept ones back.
                if let view { present(view, reviewed: kept) }
            }
        case .section(let id, let next, let count):
            guard id == messageId else { return }
            withAnimation(.snappy) {
                section = next
                sections = count
            }
            UIAccessibility.post(notification: .screenChanged, argument: nil)
        default:
            break
        }
    }

    private func showSections() {
        withAnimation(.snappy) { section = nil }
        host.send(Bridge.OpenSection(section: nil))
        UIAccessibility.post(notification: .screenChanged, argument: nil)
    }

    private func toggleWrap() {
        wrap.toggle()
        host.send(Bridge.SetWrap(wrap: wrap))
    }

    private func sendAppearance() {
        host.sendAppearance(scheme: scheme, typeSize: typeSize)
    }
}
