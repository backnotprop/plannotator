import Foundation
import InboxCore
import InboxWire

/// Every word the app shows that is NOT yet in the contract's generated `Words` (apps/mobile/contract/words).
///
/// The standing rule is that Swift holds no product word of its own. The generated table has about thirty words
/// today (sections, agents, delivery lines); the rest of the window's words live inside its components. Until each
/// of these is a product constant with a row in scripts/mobile/words.ts, it lives here, in one file, with where it
/// comes from, so the whole list can be read, approved and moved in one pass. Nothing outside this file and
/// InboxCore's CountWords writes a visible word.
///
/// Refusals are not here: the app shows the Inbox's own words from the error body.
enum PhoneWords {
  // MARK: First run and pairing (FLOWS 2, mock 1; the phone's own screen, no window twin)
  static let pairTitle = "Scan the code on your computer"
  static let pairWhere = "On your computer, open the Inbox, then Settings, Remote devices, Pair a phone."
  static let pairTypeInstead = "Type the address and six digits"
  /// Mock 1 says "a locked copy". The copy is encrypted by the phone and readable once the phone has been unlocked
  /// after a restart, so the words say that and no more.
  static let pairPromise = "Your messages stay on your computer. The phone keeps an encrypted copy so you can read, and answer, when the computer is away."
  /// Brief S1, "Demo mode".
  static let pairTryDemo = "Try it without a computer"
  static let pairAddress = "Address"
  static let pairAddressHint = "computer.tailnet.ts.net:8443"
  static let pairDigits = "Six digits"
  static let pairAction = "Pair"
  /// packages/inbox/components/PairFlow.tsx:406, as flow check pair-06 cites it.
  static let pairTailnetOnly = "Over Wi-Fi the phone pairs by scanning only."
  static let pairCameraOff = "Allow the camera in Settings to scan the code."
  static let pairOpenSettings = "Open Settings"
  static let pairNotACode = "That is not a Plannotator pairing code."
  static func pairTriesLeft(_ n: Int) -> String { n == 1 ? "1 try left." : "\(n) tries left." }
  /// Flow check pair-09: say which address was tried and what each one needs.
  static func pairNoAnswer(_ address: String) -> String { "No answer from \(address)." }
  static let pairNeedsWifi = "Over Wi-Fi: this phone must be on the same Wi-Fi as the computer, with Local Network allowed."
  static let pairNeedsTailnet = "Over the tailnet: Tailscale must be signed in on this phone."
  static let cancel = "Cancel"
  static let pairNoCamera = "No camera on this device."
  static let pairNotSaved = "This phone could not keep the pairing. Try again."
  /// A pairing link opened from outside the app (a web page, another app, the Camera app): one sheet, two equal actions.
  static func pairAsk(_ name: String) -> String { name.isEmpty ? "Pair with this computer?" : "Pair with \(name)?" }
  static func pairAskDetail(_ address: String) -> String { "This phone will read and answer the Inbox at \(address)." }
  /// FLOWS 13.
  static let pairAnother = "Pair another"
  static let demoMark = "Demo"

  // MARK: Versions (SPEC 1.9)
  /// The door's own words for `426 app_needs_update` (packages/server/inbox-door-version.ts, `appBelowFloor`).
  static let updatePhone = "Update Plannotator on your phone."
  /// FLOWS 2 and 13.
  static func updateComputer(_ name: String) -> String { "Update Plannotator on \(name)" }
  static func removedByComputer(_ name: String) -> String { "\(name) removed this phone. Pair again to use it." }
  static let pairAgain = "Pair again"

  // MARK: The list (FLOWS 3 and 12, mocks 2 and 3)
  static let inbox = "Inbox"
  /// FLOWS 1, Settings: "Remove this phone".
  static let removeThisPhone = "Remove this phone"
  static let leaveDemo = "Leave the demo"
  static let listEmpty = "Nothing here yet"
  /// FLOWS 12 says "<computer> is asleep"; without the relay the phone cannot tell asleep from out of reach.
  static func away(_ name: String) -> String { "Can't reach \(name). You are reading what this phone has." }
  static func awayNoCopy(_ name: String) -> String { "Can't reach \(name)." }
  static let tryAgain = "Try again"
  /// FLOWS 12: "Will send when Work Mac is back".
  static func willSendWhenBack(_ name: String) -> String { "Will send when \(name) is back" }
  /// FLOWS 3, the row's tag.
  static let willSend = "Will send"
  static let stateHere = "Connected"
  /// The window's words for a path that does not answer (packages/inbox/components/Devices.tsx:336).
  static let stateAway = "Not reachable yet"
  static let stateNeedsUpdate = "Needs an update"
  static let stateRemoved = "Removed"
  static let stateConnecting = "Connecting"
  static let unreadMark = "Unread"

  // MARK: A thread (FLOWS 4, mock 4)
  /// packages/core/inbox-types.ts:490 `inboxAgentName`'s fallback.
  static let anAgent = "An agent"
  /// The window's own word for the person in a row's preview (packages/core/inbox-row-preview.ts:61, "You: …").
  static let you = "You"
  /// Brief S1: a block this slice does not draw yet.
  static let moreOnComputer = "More on your computer"
  static let threadGone = "This thread is no longer on your computer."
  static let reply = "Reply"
  static let send = "Send"
  /// Mock 4.
  static let noteOrSend = "Add a note, or just send"
  static let replyOnComputer = "Reply to this one on your computer"
  static let wordsBack = "Your words are back in the box."
  /// Why something the person did was not taken: the Inbox's own words when it gave any.
  static func notice(_ notice: InboxSession.Notice, computer: String) -> String {
    switch notice {
    case .refused(let words): return words
    case .unreadable(let status): return "\(computer) did not take this (\(status))."
    case .notOffered: return "Plannotator on \(computer) cannot do this yet."
    case .appNeedsUpdate: return updatePhone
    }
  }

  // MARK: Answering (FLOWS 5, mock 4; contract flow checks answer-01 to answer-14)
  /// FLOWS 5: the kind, above the prompt.
  static func kind(_ kind: InboxQuestionKind) -> String? {
    switch kind {
    case .single: return "Pick one"
    case .multi: return "Pick any"
    case .text: return "Your words"
    default: return nil
    }
  }
  /// Mock 4: "Holding up the pull request".
  static func holdingUp(_ what: [String]) -> String { "Holding up \(what.joined(separator: ", "))" }
  static let recommended = "Recommended"
  /// The window's own word (packages/ui/components/blocks/QuestionBlock.tsx:34, flow check answer-03).
  static let other = "Other…"
  static let otherHint = "Your own words"
  static let answerHint = "Your answer"
  /// Flow check answer-01: the card's footer.
  static let addNote = "Add note"
  /// packages/ui/components/blocks/QuestionBlock.tsx:1275.
  static let hideNote = "Hide note"
  static let note = "Note"
  static let noteHint = "A note for this answer"
  static let skip = "Skip"
  static let skipped = "Skipped"
  /// packages/ui/components/blocks/QuestionBlock.tsx:1290.
  static let undoSkip = "Unskip"
  /// Flow check answer-07 (packages/inbox/components/Thread.tsx:2658): "Picked <time> · in your draft".
  static func picked(at time: String) -> String { time.isEmpty ? "Picked · in your draft" : "Picked \(time) · in your draft" }
  static func sent(at time: String) -> String { time.isEmpty ? "Sent" : "Sent \(time)" }
  /// A pick the computer does not have yet.
  static let pickedOnPhone = "Picked · on this phone"
  /// Flow check answer-12.
  static let replaced = "Replaced"
  /// Flow check answer-10.
  static let cantBeUndone = "Can't be undone"
  /// SPEC 1.9: a question kind this app does not know.
  static let answerOnComputer = "Answer this one on your computer"
  static let done = "Done"
  static let selected = "Selected"
}
