import Foundation
import InboxWire

/// Small pure rules of the window, copied here until the contract carries each as data or a vector.

/// TODO(contract): "words rows" (the send-failure lines). What a refused Send says (packages/inbox/sendFailure.ts,
/// approval "inbox-reply-box", D3): a refusal the Inbox wrote for people, short and with no path or errno in it,
/// is the line as it is, because it says what to do; anything else is the window's own line.
public enum SendFailure {
  static let lineMax = 160

  /// The Inbox's words when they are fit to be the line; nil when the window's own line is said instead.
  public static func plain(_ words: String) -> String? {
    let text = QuestionAnswers.jsTrim(words)
    guard !text.isEmpty, text.count <= lineMax else { return nil }
    // A path (`/a/b`, `C:\`) or an errno code: words for the details, not the line.
    if text.contains(/(?:^|[\s'"(])(?:\/[^\s\/'"]+){2,}|[A-Za-z]:\\|\bE[A-Z]{3,}\b/) { return nil }
    return text
  }
}

/// TODO(contract): "rowMarks/codeBlockKeepsLayout vectors". `codeBlockKeepsLayout`
/// (packages/ui/utils/codeHighlight.ts): a block that is drawn or aligned keeps its layout and scrolls sideways;
/// any other code wraps. The signals: a box-drawing or block-element character, a tab between two words, or two
/// or more spaces between two words (a double space after a sentence's end is prose, and leading indentation is
/// never between words).
public enum CodeLayout {
  public static func keeps(_ content: String) -> Bool {
    content.contains(/[\u{2500}-\u{259F}]|\S\t+\S|[^\s.!?] {2,}\S/)
  }
}

/// TODO(contract): "rowMarks/codeBlockKeepsLayout vectors". What a row's two marks draw: each one's number and
/// step (`rowMarks`, packages/inbox/components/RowBadge.tsx). `open` waits on the person and holds nothing up,
/// `hold` holds up work, `stop` stops the agent.
public struct RowMarks: Hashable, Sendable {
  public enum Step: Int, Hashable, Sendable { case open, hold, stop }
  /// Open questions, action items left out.
  public var questions: Int
  public var question: Step
  /// Open action items; with none open, those done in the reply draft and not sent that still stop or hold work.
  public var actions: Int
  public var action: Step

  /// `SHOWN_COUNT_MAX`: past this a count draws "99+".
  public static let shownMax = 99
  public static func shown(_ n: Int) -> String { n > shownMax ? "\(shownMax)+" : "\(n)" }

  public init(_ row: InboxListRow) {
    let open = Int(row.questions.openValue)
    var actions = max(0, min(Int(row.questions.actions ?? 0), open))
    let questions = open - actions
    var question = Step.open
    var action = Step.open
    guard row.section == .stopped || row.section == .holding else {
      self.questions = questions
      self.question = .open
      self.actions = actions
      self.action = .open
      return
    }
    func higher(_ a: Step, _ b: Step) -> Step { b.rawValue > a.rawValue ? b : a }
    for wait in row.waits ?? [] {
      let step: Step = wait.stopped != nil ? .stop : !wait.holdsUp.isEmpty ? .hold : .open
      if wait.key.hasPrefix("a-") { action = higher(action, step) } else { question = higher(question, step) }
    }
    // The row's state always shows on a mark: when its waits do not carry it, on the question mark, else the action box.
    let level: Step = row.section == .stopped ? .stop : .hold
    if higher(question, action).rawValue < level.rawValue {
      if questions > 0 {
        question = level
      } else {
        // Nothing open carries it: a Done or Can't do it still in the reply draft is what stops the agent.
        if actions < 1 { actions = max(1, Int(row.questions.staged ?? 0)) }
        action = level
      }
    }
    self.questions = questions
    self.question = questions > 0 ? question : .open
    self.actions = actions
    self.action = actions > 0 ? action : .open
  }
}

/// What the button at a thread's foot counts (packages/core/inbox-open-questions.ts): the questions that wait
/// (open, or picked and not sent), the action items still open, and a started agent's permission prompts.
public struct OpenItems: Hashable, Sendable {
  public var questions = 0
  public var actions = 0
  public var permissions = 0

  public init(_ thread: InboxThread) {
    for message in thread.messages where message.author.kind == .agent {
      let asked = (message.questions ?? []).filter { $0.kind != .action && ($0.state == .openValue || $0.state == .picked) }
      if SendPlan.isPermissionPrompt(message) {
        permissions += asked.count
      } else {
        questions += asked.count
        actions += ActionMarks.items(of: message).filter { ActionMarks.state($0) == .open }.count
      }
    }
  }

  /// `openQuestionsShown`: whenever a question, an action item or a permission prompt waits.
  public var shown: Bool { questions + actions + permissions > 0 }
}
