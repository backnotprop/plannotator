import Foundation

/// A row's count of what waits on the person, as the window words it (`waitCount`, `questionCount` and
/// `formatCount` in packages/core/inbox-format.ts). Not yet in the contract's generated words.
public enum CountWords {
  /// The comments that wait for a Send: "1 comment", "3 comments" (packages/inbox/components/AnnotationsChip.tsx, `plural(count, 'comment')`).
  public static func comments(_ n: Int) -> String { "\(count(n)) comment\(n == 1 ? "" : "s")" }

  static func count(_ n: Int) -> String {
    let formatter = NumberFormatter()
    formatter.locale = Locale(identifier: "en_US")
    formatter.numberStyle = .decimal
    return formatter.string(from: NSNumber(value: n)) ?? String(n)
  }

  /// "2 questions" from two up; nothing for one or none.
  public static func questions(_ open: Int) -> String { open >= 2 ? "\(count(open)) questions" : "" }

  /// "2 questions", "1 action item", "1 question, 2 action items". `open` counts questions and action items together.
  public static func waiting(open: Int, actions: Int = 0) -> String {
    let todos = min(max(actions, 0), open)
    let questions = open - todos
    if todos == 0 { return self.questions(questions) }
    let todoWords = "\(count(todos)) action item\(todos == 1 ? "" : "s")"
    if questions == 0 { return todoWords }
    return "\(count(questions)) question\(questions == 1 ? "" : "s"), \(todoWords)"
  }
}
