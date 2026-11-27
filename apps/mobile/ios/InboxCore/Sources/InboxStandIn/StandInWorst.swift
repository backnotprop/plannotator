import Foundation
import InboxCore
import InboxWire

/// Rows that try to break the list: the longest names, no words at all, emoji, right-to-left names, a count past a
/// thousand, and a thousand rows. Invented, for the screenshots and the break pass; never in the demo a person sees.
extension StandInData {
  static func worstID(_ n: Int) -> ThreadID { ThreadID(String(format: "msg_WORST%017d", n)) }

  public static func worstThreads(now: Date) -> [InboxThread] {
    func thread(_ n: Int, _ name: String, project: String, author: InboxAuthor, minutesAgo: Double, body: String, questions: [InboxQuestion] = []) -> InboxThread {
      let id = worstID(n)
      let message = InboxMessageWire(
        questions: questions.isEmpty ? nil : questions, seq: Int64(5000 + n), id: MessageID(id.rawValue), projectId: ProjectID("prj_\(project)"), threadId: id, author: author, body: body,
        createdAt: iso(now.addingTimeInterval(-minutesAgo * 60)))
      return InboxThread(threadId: id, project: self.project(project), threadName: name, messages: [message])
    }
    func named(_ name: String) -> InboxAuthor { InboxAuthor(kind: .agent, host: "claude-code", session: "ses_worst", name: name) }
    let long = "Migrate every billing table, every invoice export and every nightly reconciliation job to the new ledger schema without taking the storefront, the back office or the reporting warehouse offline for longer than a minute"
    let many = MessageID(worstID(5).rawValue)
    return [
      thread(1, long, project: "a-project-with-a-very-long-name-that-goes-on-and-on-and-on", author: named("Claude Code (worktree agent-a0316994da8440ab5 on a long branch name)"), minutesAgo: 3, body: long + ". " + long),
      thread(2, "No words yet", project: "api-server", author: agent("codex", "ses_w2"), minutesAgo: 4, body: ""),
      thread(3, "🚀🧑‍🚀👨‍👩‍👧‍👦🇯🇵 Launch checklist 🎉🎉🎉 ✅ 🧪 🔥 👩🏽‍💻 ship it 🚢", project: "🛰️ orbit", author: named("🤖 Robo 🧑‍🚀"), minutesAgo: 5, body: "🎉 All green ✅ — 12 of 12 🧪 passed 🚀"),
      thread(4, "ترحيل جداول الفواتير إلى المخطط الجديد قبل نهاية الأسبوع", project: "واجهة-المتجر", author: named("مساعد البرمجة"), minutesAgo: 6, body: "انتهى الترحيل ونجحت كل الاختبارات. هل أبدأ بالنشر على بيئة التجربة؟"),
      thread(
        5, "A thousand questions", project: "api-server", author: agent("claude-code", "ses_w5"), minutesAgo: 7, body: "I have a few questions before I go on.",
        questions: (0..<1284).map { question("q_many_\($0)", .single, "Question \($0 + 1)?", choices: [choice("Yes"), choice("No")], position: Int64($0), message: many) }),
      thread(6, "Supercalifragilisticexpialidocious_an_unbroken_identifier_that_never_ends_0123456789abcdef0123456789abcdef", project: "x", author: named("R"), minutesAgo: 8, body: "https://example.test/a/very/long/path/with/no/spaces/at/all/that/keeps/going/and/going/and/going/index.html"),
      thread(7, "עדכון תלויות: שדרוג הספריות לפני השחרור", project: "storefront", author: named("סוכן הקוד"), minutesAgo: 9, body: "הכול עבר. מוכן למיזוג."),
    ]
  }

  /// A long list: every row plain, a minute apart, in three projects.
  public static func manyThreads(now: Date, count: Int = 1000) -> [InboxThread] {
    let names = ["Bump the toolchain", "Flaky test in the relay suite", "Docs build is green", "Trim the Docker image", "Rename the retry flag", "Nightly report"]
    let projects = ["api-server", "storefront", "docs"]
    let hosts = ["claude-code", "codex", "pi", "gemini", "opencode"]
    return (0..<count).map { index in
      let id = ThreadID(String(format: "msg_MANY%018d", index))
      let message = InboxMessageWire(
        seq: Int64(10_000 + index), id: MessageID(id.rawValue), projectId: ProjectID("prj_\(projects[index % 3])"), threadId: id, author: agent(hosts[index % hosts.count], "ses_many_\(index % 7)"),
        body: "Done. Run \(index + 1) of \(count) finished with nothing to report.", createdAt: iso(now.addingTimeInterval(-Double(index + 30) * 60)))
      return InboxThread(threadId: id, project: project(projects[index % 3]), threadName: "\(names[index % names.count]) #\(index + 1)", messages: [message])
    }
  }
}
