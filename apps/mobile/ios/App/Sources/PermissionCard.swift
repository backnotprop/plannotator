import InboxCore
import InboxWire
import SwiftUI

/// A started agent's permission prompt as its own framed card, as the window draws it on a phone
/// (packages/inbox/components/PermissionCard.tsx; approval "inbox-permission-prompt"): who waits, what it wants,
/// the exact request in a monospace box, then the answers as full-width buttons with Allow once filled. Every
/// answer is the question's own choice, picked and sent at once. Answered, it shrinks in place to one line.
struct PermissionCard: View {
  let session: InboxSession
  let thread: InboxThread
  let message: InboxMessageWire
  /// Where the Deny reason is kept while it is typed: the thread is built as it scrolls, and a card scrolled far
  /// away and back opens with the words still there.
  var drafts: ThreadDrafts?

  enum Mode { case answers, reason, confirmFull }
  @State private var mode = Mode.answers
  @State private var reason = ""
  @State private var busy = false
  @State private var shown = Date()
  @State private var opened = false
  /// The card was built anew with a reason kept: opening its field again is no touch of the person's.
  @State private var restoring = false
  @FocusState private var typing: Bool
  @Environment(ScrollBox.self) private var scroll: ScrollBox?
  @Environment(\.cardKey) private var cardKey

  /// How long the answers ignore a touch after the card appears (the window's `ARM_MS`): a tap aimed at what was
  /// there a moment ago never allows a prompt the person has not seen.
  private static let arm: TimeInterval = 0.6

  private var question: InboxQuestion? { message.questions?.first }
  private var reasonKey: String { "deny/\(message.id.rawValue)" }
  /// The agent that asks; Claude Code for a prompt with no name (the window's card, `agentNameOf`).
  private var agent: String {
    let name = Names.agent(message.author)
    return name == PhoneWords.anAgent ? "Claude Code" : name
  }
  /// As the deny field addresses it: "Claude" for Claude Code.
  private var shortAgent: String { agent == "Claude Code" ? "Claude" : agent }

  var body: some View {
    if let question {
      let read = PermissionPrompt.read(message.body)
      let title = PermissionPrompt.title(question.prompt)
      Group {
        if let outcome = PermissionPrompt.outcome(question) {
          record(question, outcome, read, title)
        } else {
          waiting(question, read, title)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Token.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Token.border.opacity(0.7)))
      .onAppear {
        shown = Date()
        if let kept = drafts?.reasons[reasonKey] {
          restoring = true
          reason = kept
          mode = .reason
        }
      }
      // Opening a field or the confirmation by any means says which card the person is on.
      .onChange(of: mode) { _, now in
        drafts?.reasons[reasonKey] = now == .reason ? reason : nil
        if restoring { restoring = false } else if let cardKey { scroll?.act(cardKey) }
      }
      .onChange(of: reason) { _, now in if mode == .reason { drafts?.reasons[reasonKey] = now } }
      .onChange(of: typing) { _, now in if now, let cardKey { scroll?.act(cardKey) } }
    }
  }

  // MARK: Waiting

  private func waiting(_ question: InboxQuestion, _ read: PermissionPrompt, _ title: String) -> some View {
    let labels = question.choices.map(\.label)
    let session = PermissionPrompt.sessionLabel(labels)
    let toTerminal = labels.contains(PermissionPrompt.terminal)
    let terminalOnly = toTerminal && !labels.contains(PermissionPrompt.allowOnce)
    let can = self.session.canAnswer() && !busy
    return VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        AgentMark(author: message.author, size: 22)
        Text(agent).font(.subheadline.weight(.semibold)).foregroundStyle(Token.foreground).lineLimit(1).layoutPriority(1)
        TimelineView(.everyMinute) { now in
          let minutes = TimeWords.date(message.createdAt).map { Int(now.date.timeIntervalSince($0) / 60) } ?? 0
          Text(PhoneWords.permWaiting + (minutes >= 1 ? PhoneWords.permMinutes(minutes) : "")).font(.subheadline).foregroundStyle(Token.mutedForeground).lineLimit(1)
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 16)
      .frame(minHeight: 44)
      .accessibilityElement(children: .combine)
      .lineEdge("head")
      Divider().overlay(Token.border)
      VStack(alignment: .leading, spacing: 10) {
        Text(Self.ticks(title)).font(.body.weight(.semibold)).foregroundStyle(Token.foreground).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader).lineEdge("title")
        PermissionRequest(read: read, kind: PermissionPrompt.kind(question.prompt))
      }
      .padding(16)
      Divider().overlay(Token.border)
      VStack(alignment: .leading, spacing: 8) {
        switch mode {
        case .reason: denyReason(question)
        case .confirmFull: confirmFull(question)
        case .answers:
          if !terminalOnly {
            AnswerButton(words: PermissionPrompt.allowOnce, style: .filled) { answer(question, PermissionPrompt.allowOnce) }
            if let session { AnswerButton(words: session, style: .plain) { answer(question, session) } }
          }
          AnswerButton(words: PermissionPrompt.deny, style: .plain) { answer(question, PermissionPrompt.deny) }
          AnswerButton(words: PhoneWords.denyWithReason, style: .ghost) {
            guard armed else { return }
            mode = .reason
            typing = true
          }
          if terminalOnly {
            AnswerButton(words: PermissionPrompt.terminal, style: .plain) { answer(question, PermissionPrompt.terminal) }
            if let note = read.note { Text(note).font(.footnote).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true) }
          } else {
            if labels.contains(PermissionPrompt.auto) {
              VStack(alignment: .leading, spacing: 0) {
                Text(PhoneWords.orAllowAndSwitch).font(.footnote).foregroundStyle(Token.mutedForeground).padding(.top, 6)
                HStack(spacing: 18) {
                  LinkButton(words: PhoneWords.autoMode) { answer(question, PermissionPrompt.auto) }
                  // Only a session that may switch to it offers Full permissions (its choices say so).
                  if labels.contains(PermissionPrompt.full) {
                    LinkButton(words: PhoneWords.fullPermissions) {
                      guard armed else { return }
                      // Asked once in a session: after that the answer goes straight through, as in the window.
                      if PermissionPrompt.fullUsed(in: thread, before: message) { answer(question, PermissionPrompt.full) } else { mode = .confirmFull }
                    }
                  }
                }
              }
            }
            if toTerminal { LinkButton(words: PermissionPrompt.terminal, quiet: true) { answer(question, PermissionPrompt.terminal) } }
          }
        }
        if self.session.refusal(message: message.id, key: question.key) != nil, mode != .confirmFull {
          Label(PhoneWords.answerNotSent, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(Token.destructive)
        }
      }
      .padding(16)
      .disabled(!can)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(PhoneWords.asksPermission(agent, to: PermissionPrompt.wants(question.prompt)))
  }

  private var armed: Bool { Date().timeIntervalSince(shown) >= Self.arm }

  private func denyReason(_ question: InboxQuestion) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      TextField(PhoneWords.tellWhatInstead(shortAgent), text: $reason, axis: .vertical)
        .lineLimit(2...6)
        .font(.body)
        .focused($typing)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minHeight: 64, alignment: .top)
        .fieldGround(radius: 14)
        .accessibilityLabel(PhoneWords.whyYouDeny(shortAgent))
        .lineEdge("reason")
      HStack(spacing: 8) {
        let empty = reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        AnswerButton(words: PhoneWords.cancel, style: .ghost, hugs: true) {
          mode = .answers
          typing = false
        }
        AnswerButton(words: PhoneWords.denyAndSend, style: empty ? .off : .plain) {
          answer(question, nil, reason: reason.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        .disabled(empty)
      }
      .lineEdge("reasonButtons")
    }
    .cardPart()
  }

  private func confirmFull(_ question: InboxQuestion) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      run(Text(PhoneWords.switchToFull).fontWeight(.semibold).foregroundStyle(Token.foreground), Text(" " + PhoneWords.switchToFullDetail(agent)).foregroundStyle(Token.mutedForeground))
        .font(.subheadline)
        .fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 8) {
        AnswerButton(words: PhoneWords.cancel, style: .ghost, hugs: true) { mode = .answers }
        AnswerButton(words: PhoneWords.allowAndSwitch, style: .plain) { answer(question, PermissionPrompt.full, confirmFull: true) }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(PhoneWords.switchToFull)
  }

  /// One answer: the question's own label (or a Deny with words), picked and sent.
  private func answer(_ question: InboxQuestion, _ label: String?, reason: String? = nil, confirmFull: Bool = false) {
    guard armed, !busy else { return }
    busy = true
    typing = false
    let picked = QuestionAnswer(v: 1, key: question.key, kind: .single, prompt: question.prompt, selected: label.map { [$0] } ?? [], other: reason)
    Task {
      await session.answerNow(thread: thread.threadId, message: message.id, question: question, answer: picked, confirmFull: confirmFull)
      busy = false
      // Refused: what the person typed stays. A Full permissions answer the Inbox wants confirmed first (this
      // phone took it for confirmed already) opens the confirmation, never a dead end.
      if session.refusal(message: message.id, key: question.key) != nil {
        // By the refusal's code and the field it names, never by its words.
        if case .refused(_, "validation_error")? = session.refusal(message: message.id, key: question.key), session.refusalField(message: message.id, key: question.key) == "confirm_full" { mode = .confirmFull }
      } else {
        mode = .answers
        self.reason = ""
      }
    }
  }

  // MARK: Answered

  /// The answered (or withdrawn) prompt: one framed line in the same place; touch it to see the request again.
  private func record(_ question: InboxQuestion, _ outcome: PermissionPrompt.Outcome, _ read: PermissionPrompt, _ title: String) -> some View {
    let allowed = PermissionPrompt.allowed(outcome)
    let labels = question.choices.map(\.label)
    let verb: String = {
      switch outcome {
      case .once: return PhoneWords.youChose(PermissionPrompt.allowOnce)
      case .session: return PhoneWords.youChose(PermissionPrompt.sessionLabel(labels) ?? "")
      case .auto: return PhoneWords.youChose(PermissionPrompt.auto)
      case .full: return PhoneWords.youChose(PermissionPrompt.full)
      case .deny: return PhoneWords.youChose(PermissionPrompt.deny)
      case .terminal: return PhoneWords.youChose(PermissionPrompt.terminal)
      case .closed: return PhoneWords.notAnswered
      case .withdrawn:
        let follow = PermissionPrompt.followUp(in: thread, of: message) ?? PhoneWords.noLongerWaiting
        return follow.hasSuffix(".") ? String(follow.dropLast()) : follow
      }
    }()
    let held = session.isHeldSend(message: message.id, key: question.key)
    // The prompt's own time, as the window's record has it.
    let time = held ? "" : TimeWords().when(message.createdAt)
    let what = read.what(title: title)
    return VStack(alignment: .leading, spacing: 0) {
      Button {
        opened.toggle()
      } label: {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          AgentMark(author: message.author, size: 22).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
          Image(systemName: allowed ? "checkmark" : outcome == .deny ? "xmark" : "minus")
            .font(.footnote.weight(.bold))
            .foregroundStyle(allowed ? Token.success : Token.mutedForeground)
            .accessibilityHidden(true)
          // Everything the record says shares one left edge: the verdict, the request, the person's reason.
          VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
              verbText(verb).fixedSize(horizontal: false, vertical: true)
              Spacer(minLength: 4)
              Text(time).font(.footnote).monospacedDigit().foregroundStyle(Token.mutedForeground).lineLimit(1)
            }
            // The request whole when it fits in two lines; a longer one is cut in its middle, so its end (the
            // part that says what and where) always shows.
            whatText(what)
            if outcome == .deny, let reason = PermissionPrompt.reason(question) {
              Text(PhoneWords.youSaid(reason)).font(.footnote).foregroundStyle(Token.mutedForeground).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
            }
            if outcome == .terminal, let handoff = read.handoff {
              Text(handoff).font(.footnote).foregroundStyle(Token.mutedForeground).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
            }
            if held {
              Label(PhoneWords.willSendWhenBack(session.computer.name), systemImage: "clock").font(.footnote).foregroundStyle(Token.mutedForeground)
            }
          }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(ChoiceStyle())
      .accessibilityElement(children: .combine)
      if opened {
        Divider().overlay(Token.border)
        VStack(alignment: .leading, spacing: 10) {
          Text(Self.ticks(title)).font(.body.weight(.semibold)).foregroundStyle(Token.foreground).fixedSize(horizontal: false, vertical: true)
          PermissionRequest(read: read, kind: PermissionPrompt.kind(question.prompt))
        }
        .padding(16)
      }
    }
  }

  private func verbText(_ verb: String) -> some View {
    Text(Self.ticks(verb)).font(.subheadline.weight(.medium)).foregroundStyle(Token.foreground).multilineTextAlignment(.leading)
  }

  private func whatText(_ what: String) -> some View {
    Text(what).font(.system(.footnote, design: .monospaced)).foregroundStyle(Token.mutedForeground).multilineTextAlignment(.leading).lineLimit(2).truncationMode(.middle)
  }

  /// A label with its inline code as code.
  static func ticks(_ text: String, onPrimary: Bool = false) -> AttributedString {
    var out = AttributedString()
    for span in PermissionPrompt.spans(text) {
      var part = AttributedString(span.text)
      if span.code {
        part.font = .system(.callout, design: .monospaced)
        part.backgroundColor = (onPrimary ? Token.primaryForeground : Token.foreground).opacity(onPrimary ? 0.18 : 0.12)
      }
      out += part
    }
    return out
  }
}

/// One answer: the whole width, 48 points to touch, its words wrapped rather than cut (a session choice names
/// every rule it grants, and all of them must show).
private struct AnswerButton: View {
  enum Style { case filled, plain, ghost, off }
  let words: String
  let style: Style
  /// As wide as its words (Cancel beside the answer it cancels), not the whole width.
  var hugs = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(PermissionCard.ticks(words, onPrimary: style == .filled))
        .font(.body.weight(style == .ghost ? .medium : .semibold))
        // Words alone that can be touched are the accent colour everywhere in the app.
        .foregroundStyle(style == .filled ? Token.primaryForeground : style == .off ? Token.mutedForeground : style == .ghost ? Token.primary : Token.foreground)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: hugs ? nil : .infinity, minHeight: 48)
        .frame(minWidth: hugs ? 72 : nil)
        // A tint of the words' own colour, so the button stands off its card in the dark as in the light.
        .background(style == .filled ? Token.primary : style == .ghost ? Color.clear : Token.foreground.opacity(style == .off ? 0.05 : 0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        // A hairline too, so a plain answer stands off its card in the dark.
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Token.foreground.opacity(style == .plain ? 0.22 : 0)))
        .contentShape(Rectangle())
    }
    .buttonStyle(ChoiceStyle())
  }
}

/// A quiet answer under the buttons, underlined as the window's are, 44 points to touch.
private struct LinkButton: View {
  let words: String
  var quiet = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(words)
        .font(.subheadline.weight(.medium))
        .foregroundStyle(quiet ? Token.mutedForeground : Token.primary)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(ChoiceStyle())
  }
}

/// The exact request: a command with its purpose and folder, a file's content or change, a link and what the
/// agent looks for, and anything else in the input, so nothing the person allows is hidden.
struct PermissionRequest: View {
  let read: PermissionPrompt
  let kind: PermissionPrompt.Kind
  @State private var all = false
  /// The window's cap on a phone.
  private static let cap = 8

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let preview = read.preview, let detail = read.detail, detail.onLine {
        file(preview, path: PermissionPrompt.relative(detail.text, to: read.folder))
        rest
      } else if let detail = read.detail {
        if kind == .fetch, detail.onLine {
          link(detail.text)
          if let purpose = read.purpose {
            run(Text(PhoneWords.lookingFor + " ").foregroundStyle(Token.mutedForeground), Text(purpose).foregroundStyle(Token.foreground).fontWeight(.medium)).font(.subheadline).fixedSize(horizontal: false, vertical: true)
          }
        } else {
          if read.unsandboxed {
            Label(PhoneWords.outsideSandbox, systemImage: "exclamationmark.triangle").font(.subheadline.weight(.semibold)).foregroundStyle(Token.destructive)
          }
          CodeBlock(code: detail.onLine && kind == .file ? PermissionPrompt.relative(detail.text, to: read.folder) : detail.text, copies: false).lineEdge("code")
          linksTo
          if kind == .bash {
            if let purpose = read.purpose {
              Text((purpose.hasSuffix(".") ? String(purpose.dropLast()) : purpose) + ".").font(.subheadline).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true).lineEdge("purpose")
            }
            if let folder = read.folder {
              // On its own line, so the path is never split after "~/"; a path longer than the line cuts in its middle.
              HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(PhoneWords.runsIn).font(.subheadline).foregroundStyle(Token.mutedForeground).fixedSize()
                Text(folder).font(.system(.footnote, design: .monospaced)).foregroundStyle(Token.foreground).lineLimit(1).truncationMode(.middle)
              }
              .lineEdge("folder")
            }
          }
        }
        rest
      } else {
        rest
      }
    }
  }

  @ViewBuilder private var linksTo: some View {
    if let target = read.linksTo {
      run(Text(PhoneWords.linksTo + " "), Text(target).font(.system(.footnote, design: .monospaced)).foregroundStyle(Token.foreground)).font(.footnote).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true)
    }
  }

  @ViewBuilder private var rest: some View {
    if let leftover = read.leftover {
      Text(PhoneWords.alsoInRequest).font(.subheadline).foregroundStyle(Token.mutedForeground)
      CodeBlock(code: leftover, copies: false)
    }
  }

  /// A link exactly as sent, wrapped, never shortened; its host stressed only when the text starts with it, and
  /// named on its own line when it does not.
  @ViewBuilder private func link(_ text: String) -> some View {
    let parts = PermissionPrompt.link(text)
    Group {
      if let origin = parts.origin {
        run(Text(origin).foregroundStyle(Token.foreground).fontWeight(.medium), Text(String(text.dropFirst(origin.count))).foregroundStyle(Token.mutedForeground))
      } else {
        Text(text).foregroundStyle(Token.foreground)
      }
    }
    .font(.system(.callout, design: .monospaced))
    .textSelection(.enabled)
    .fixedSize(horizontal: false, vertical: true)
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .background(Token.codeBackground, in: RoundedRectangle(cornerRadius: Token.radius, style: .continuous))
    if parts.origin == nil, let host = parts.host {
      run(Text(PhoneWords.host + " ").foregroundStyle(Token.mutedForeground), Text(host).font(.system(.footnote, design: .monospaced)).fontWeight(.medium).foregroundStyle(Token.foreground)).font(.subheadline)
    }
  }

  /// A Write's content or an Edit's change: the path and its facts, then numbered lines.
  private func file(_ preview: PermissionPrompt.Preview, path: String) -> some View {
    let lines = preview.lines
    let shown = all ? lines : Array(lines.prefix(Self.cap))
    let cut = path.lastIndex(of: "/").map { path.index(after: $0) } ?? path.startIndex
    var number = 0
    let rows: [(id: Int, number: Int?, sign: Character?, text: String)] = shown.enumerated().map { index, line in
      if preview.isDiff, line.hasPrefix("@@ ") { return (index, nil, nil, String(line.dropFirst(3))) }
      number += 1
      return (index, number, preview.isDiff ? line.first : nil, preview.isDiff ? String(line.dropFirst()) : line)
    }
    return VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 2) {
        run(Text(String(path[..<cut])).foregroundStyle(Token.mutedForeground), Text(String(path[cut...])).foregroundStyle(Token.foreground).fontWeight(.medium))
          .font(.system(.footnote, design: .monospaced))
          .fixedSize(horizontal: false, vertical: true)
        Text(PhoneWords.fileFacts(kind: preview.kind, lines: lines)).font(.footnote).monospacedDigit().foregroundStyle(Token.mutedForeground)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 9)
      if read.linksTo != nil {
        Divider().overlay(Token.border)
        linksTo.padding(.horizontal, 14).padding(.vertical, 7)
      }
      Divider().overlay(Token.border)
      VStack(alignment: .leading, spacing: 0) {
        ForEach(rows, id: \.id) { row in
          if let n = row.number {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
              Text("\(n)").monospacedDigit().foregroundStyle(Token.mutedForeground.opacity(0.7)).frame(width: 26, alignment: .trailing).accessibilityHidden(true)
              Text(row.text.isEmpty ? " " : row.text).foregroundStyle(Token.foreground).fixedSize(horizontal: false, vertical: true)
              Spacer(minLength: 0)
            }
            .padding(.trailing, 14)
            .padding(.vertical, 1)
            .background(row.sign == "+" ? Token.success.opacity(0.12) : row.sign == "-" ? Token.destructive.opacity(0.1) : Color.clear)
          } else {
            Text(row.text).font(.caption).foregroundStyle(Token.mutedForeground).padding(.horizontal, 14).padding(.vertical, 3).frame(maxWidth: .infinity, alignment: .leading).background(Token.foreground.opacity(0.04))
          }
        }
      }
      .font(.system(.footnote, design: .monospaced))
      .padding(.vertical, 8)
      if lines.count > Self.cap {
        Divider().overlay(Token.border)
        Button(all ? PhoneWords.showLess : PhoneWords.showMoreLines(lines.count - Self.cap)) { all.toggle() }
          .font(.footnote)
          .foregroundStyle(Token.mutedForeground)
          .padding(.horizontal, 14)
          .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
          .contentShape(Rectangle())
          .buttonStyle(ChoiceStyle())
      }
    }
    .background(Token.codeBackground, in: RoundedRectangle(cornerRadius: Token.radius, style: .continuous))
  }
}
