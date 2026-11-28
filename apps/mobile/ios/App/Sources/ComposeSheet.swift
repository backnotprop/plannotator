import InboxCore
import InboxWire
import SwiftUI

/// New message (the window's compose, at a phone's size): To, the words, files, Send. Closing it keeps everything for
/// next time, as the window does; a Send made while the computer is away waits on the phone.
struct ComposeSheet: View {
  let session: InboxSession
  /// Sent, or waiting on the phone: the list says so.
  let sent: (ComposeOutcome) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var words: String
  @State private var choosing = false
  @State private var sending = false
  /// What Send said when it could not go (the window's line, until the person changes something).
  @State private var said: String?
  @FocusState private var focused: Bool
  @Environment(\.dynamicTypeSize) private var typeSize

  init(session: InboxSession, sent: @escaping (ComposeOutcome) -> Void) {
    self.session = session
    self.sent = sent
    _words = State(initialValue: session.composeDraft?.words ?? "")
  }

  private var draft: ComposeDraft? { session.composeDraft }
  private var readiness: ComposeReadiness { session.composeReadiness() }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        toRow
        Hairline().padding(.horizontal, Space.page)
        if let notice = draft?.notice {
          Trouble(words: PhoneWords.notice(notice, computer: session.computer.name, agent: draft?.to.map { Words.agents[$0.host] ?? $0.host }, newMessage: true))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Space.page)
            .padding(.top, Space.step)
        }
        TextField(PhoneWords.composeHint, text: $words, axis: .vertical)
          .font(TextRole.body)
          .lineLimit(4...)
          .focused($focused)
          .padding(.horizontal, Space.page)
          .padding(.vertical, Space.step)
          .accessibilityIdentifier("compose-words")
        Spacer(minLength: 0)
        foot
      }
      .background(Token.background.ignoresSafeArea())
      .navigationTitle(PhoneWords.newMessage)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(PhoneWords.cancel) { dismiss() } }
      }
      .sheet(isPresented: $choosing) {
        SessionPicker(session: session, chosen: draft?.to) { to in
          session.changeCompose { $0.to = to; $0.notice = nil }
          said = nil
          choosing = false
        }
        .presentationDetents([.medium, .large])
      }
    }
    .onChange(of: words) { _, now in
      said = nil
      session.changeCompose { $0.words = now }
    }
    // A Send the computer refused puts its words back: the field shows them.
    .onChange(of: draft?.words) { _, now in if let now, now != words { words = now } }
    .task {
      focused = draft?.to != nil
      await session.readSessions()
      await session.uploadWaiting(.compose)
    }
  }

  /// To: who gets it. A touch opens the live sessions.
  private var toRow: some View {
    let large = typeSize.isAccessibilitySize
    return Button { choosing = true } label: {
      Group {
        if large, let to = draft?.to {
          // At the largest text sizes: To, the mark and the chevron on one line, then the agent and its project each
          // on its own lines across the whole width, never cut.
          VStack(alignment: .leading, spacing: Space.hair) {
            HStack(spacing: Space.close) {
              Text(PhoneWords.toLabel).font(TextRole.secondary).foregroundStyle(Token.mutedForeground)
              AgentMark(author: InboxAuthor(kind: .agent, host: to.host, session: to.session), size: 22)
              Spacer(minLength: Space.close)
              Image(systemName: "chevron.down").font(TextRole.glyph).foregroundStyle(Token.mutedForeground)
            }
            Text(SessionPicker.name(to)).font(TextRole.label).foregroundStyle(Token.foreground)
            Text(PhoneWords.inProject(to.project)).font(TextRole.secondary).foregroundStyle(Token.mutedForeground)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .multilineTextAlignment(.leading)
          .padding(.vertical, Space.close)
        } else {
          HStack(spacing: Space.close) {
            Text(PhoneWords.toLabel).font(TextRole.secondary).foregroundStyle(Token.mutedForeground)
            if let to = draft?.to {
              AgentMark(author: InboxAuthor(kind: .agent, host: to.host, session: to.session), size: 22)
              Text(SessionPicker.name(to)).font(TextRole.label).foregroundStyle(Token.foreground).lineLimit(1)
              Text(PhoneWords.inProject(to.project)).font(TextRole.secondary).foregroundStyle(Token.mutedForeground).lineLimit(1)
            } else {
              Text(session.sessions == .reading ? PhoneWords.lookingForAgents : PhoneWords.chooseAnAgent).font(TextRole.label).foregroundStyle(Token.primary)
            }
            Spacer(minLength: Space.close)
            Image(systemName: "chevron.down").font(TextRole.glyph).foregroundStyle(Token.mutedForeground)
          }
        }
      }
      .padding(.horizontal, Space.page)
      .frame(minHeight: Space.touch + Space.close)
      .contentShape(Rectangle())
    }
    .buttonStyle(PressStyle(gives: false))
    .accessibilityIdentifier("compose-to")
  }

  /// The files, then the paperclip, the bin and Send.
  private var foot: some View {
    VStack(spacing: 0) {
      if let said {
        Trouble(words: said).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, Space.page).padding(.bottom, Space.close)
      }
      VStack(spacing: 0) {
        DraftTiles(session: session, place: .compose)
        HStack(spacing: 0) {
          AttachButton(session: session, place: .compose).padding(.leading, Space.tight)
          if let draft, !draft.isEmpty || draft.to != nil {
            Button {
              session.discardCompose()
              words = ""
              dismiss()
            } label: {
              Image(systemName: "trash").font(TextRole.label).foregroundStyle(Token.mutedForeground).touchTarget()
            }
            .buttonStyle(PressStyle())
            .accessibilityLabel(PhoneWords.discard)
            .barSized()
          }
          Spacer(minLength: Space.close)
          Button(action: send) { SendDisc(ready: readiness == .ready && !sending) }
            .buttonStyle(PressStyle())
            .disabled(sending || readiness == .empty || readiness == .notOffered)
            .accessibilityLabel(PhoneWords.send)
            .accessibilityIdentifier("compose-send")
            .barSized()
        }
      }
      .glassEffect(.regular, in: .rect(cornerRadius: Radius.foot))
      .padding(.horizontal, Space.step)
      .padding(.bottom, Space.close)
    }
  }

  private func send() {
    switch readiness {
    case .chooseAgent:
      said = PhoneWords.chooseAgentToSend
      choosing = true
      return
    case .waitForFiles:
      // A file that waits for the computer's own network says so, not "uploading".
      said = session.filesNeedNetwork(draft?.files ?? []) ? PhoneWords.needsNetwork : PhoneWords.waitForFiles
      return
    case .ready: break
    case .empty, .notOffered: return
    }
    sending = true
    Task {
      let outcome = await session.sendNew()
      sending = false
      switch outcome {
      case .sent, .held:
        words = ""
        sent(outcome)
        dismiss()
      case .refused:
        words = session.composeDraft?.words ?? words
      case .nothing: break
      }
    }
  }
}

/// The live agent sessions, by project, as the computer lists them (`GET sessions`). A touch chooses one.
struct SessionPicker: View {
  let session: InboxSession
  let chosen: ComposeTo?
  let choose: (ComposeTo) -> Void

  /// A session's name: its own title when its host keeps one, else its agent's.
  static func name(_ to: ComposeTo) -> String { to.label ?? Words.agents[to.host] ?? to.host }

  var body: some View {
    NavigationStack {
      content
        .navigationTitle(PhoneWords.toLabel)
        .navigationBarTitleDisplayMode(.inline)
        .background(Token.background.ignoresSafeArea())
    }
    .task { if case .live = session.sessions {} else { await session.readSessions() } }
  }

  @ViewBuilder private var content: some View {
    let projects = session.sessions.projects.filter { !$0.sessions.isEmpty }
    switch session.sessions {
    case .unread, .reading:
      VStack(spacing: Space.step) {
        ProgressView()
        Text(PhoneWords.lookingForAgents).font(TextRole.secondary).foregroundStyle(Token.mutedForeground)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .unreachable:
      Standing(symbol: "wifi.slash", words: PhoneWords.awayNoCopy(session.computer.name), action: PhoneWords.tryAgain) { Task { await session.readSessions() } }
    case .notOffered:
      Standing(symbol: "desktopcomputer.and.arrow.down", words: PhoneWords.updateComputer(session.computer.name))
    case .live, .kept:
      if projects.isEmpty {
        Standing(symbol: "moon.zzz", words: PhoneWords.noAgentRunning)
      } else {
        List {
          ForEach(projects, id: \.project.root) { group in
            Section(group.project.name) {
              ForEach(group.sessions, id: \.session) { live in
                let to = ComposeTo(live, in: group)
                Button { choose(to) } label: { row(to, live) }
                  .accessibilityAddTraits(chosen?.session == live.session ? .isSelected : [])
              }
            }
          }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
      }
    }
  }

  private func row(_ to: ComposeTo, _ live: InboxComposeSession) -> some View {
    HStack(spacing: Space.step) {
      AgentMark(author: InboxAuthor(kind: .agent, host: to.host, session: to.session), size: 28)
      VStack(alignment: .leading, spacing: Space.hair) {
        Text(Self.name(to)).font(TextRole.label).foregroundStyle(Token.foreground)
        if to.label != nil { Text(Words.agents[to.host] ?? to.host).font(TextRole.secondary).foregroundStyle(Token.mutedForeground) }
      }
      Spacer(minLength: Space.close)
      if chosen?.session == to.session { Image(systemName: "checkmark").font(TextRole.label).foregroundStyle(Token.primary).accessibilityHidden(true) }
    }
    .frame(minHeight: Space.touch)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
}
