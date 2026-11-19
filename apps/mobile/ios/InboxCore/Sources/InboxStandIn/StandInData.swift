import Foundation
import InboxCore
import InboxWire

/// The stand-in computer's threads. Invented: no real project, person or machine.
public enum StandInData {
  public static let retry = ThreadID("msg_STANDIN0000000000000003")
  public static let checkout = ThreadID("msg_STANDIN0000000000000002")
  public static let billing = ThreadID("msg_STANDIN0000000000000001")
  public static let docs = ThreadID("msg_STANDIN0000000000000004")
  public static let upload = ThreadID("msg_STANDIN0000000000000005")
  public static let bumps = ThreadID("msg_STANDIN0000000000000006")
  public static let onboarding = ThreadID("msg_STANDIN0000000000000007")
  public static let unread: Set<ThreadID> = [billing, checkout, docs]

  public static func iso(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }

  static func project(_ name: String) -> InboxThreadProject {
    InboxThreadProject(id: "prj_\(name)", key: name, name: name, root: "/work/\(name)", createdAt: "2026-10-01T09:00:00.000Z")
  }

  static func agent(_ host: String, _ session: String) -> InboxAuthor { InboxAuthor(kind: .agent, host: host, session: session) }

  static func choice(_ label: String, _ description: String? = nil, recommended: Bool = false) -> InboxQuestionChoice {
    InboxQuestionChoice(label: label, description: description, recommended: recommended, settled: false)
  }

  static func question(
    _ key: String, _ kind: InboxQuestionKind, _ prompt: String, context: String? = nil, choices: [InboxQuestionChoice] = [], position: Int64 = 0, suggested: String? = nil, stopped: String? = nil,
    holdsUp: [String] = [], message: MessageID, reversible: InboxQuestionReversible? = nil
  ) -> InboxQuestion {
    InboxQuestion(
      key: key, position: position, kind: kind, prompt: prompt, context: context, choices: choices, recommendation: choices.first(where: \.recommended)?.label, suggestedText: suggested, stopped: stopped,
      holdsUp: holdsUp, orphaned: false, state: .openValue, revision: 0, sentRevision: 0, messageId: message, reversible: reversible)
  }

  public static func threads(now: Date) -> [InboxThread] {
    var seq: Int64 = 0
    func message(_ id: String, _ thread: ThreadID, _ project: String, _ author: InboxAuthor, minutesAgo: Double, _ body: String, questions: [InboxQuestion]? = nil, delivery: InboxDelivery? = nil) -> InboxMessageWire {
      seq += 1
      return InboxMessageWire(
        questions: questions, seq: seq, id: MessageID(id), projectId: ProjectID("prj_\(project)"), threadId: thread, author: author, body: body, createdAt: iso(now.addingTimeInterval(-minutesAgo * 60)),
        delivery: delivery)
    }
    let claude = agent("claude-code", "ses_api")
    let codex = agent("codex", "ses_store")
    let pi = agent("pi", "ses_docs")
    let person = InboxAuthor(kind: .person)

    let billingAsk = MessageID(billing.rawValue)
    let billingThread = InboxThread(
      threadId: billing, project: project("api-server"), threadName: "Migrate billing tables",
      messages: [
        message(
          billing.rawValue, billing, "api-server", claude, minutesAgo: 2,
          """
          The migration is written and passes on a copy of last night's data. It adds two columns to `invoices` and backfills them in batches of 5,000.

          I stopped before touching the staging database.

          :::question
          Run the migration on the staging database?

          - [ ] Run it now — about four minutes, staging stays up
          - [ ] Not yet — I will wait

          Recommended: Run it now
          :::
          """,
          questions: [
            question(
              "q_run", .single, "Run the migration on the staging database?",
              choices: [choice("Run it now", "about four minutes, staging stays up", recommended: true), choice("Not yet", "I will wait")], stopped: billing.rawValue, message: billingAsk)
          ])
      ])

    let checkoutAsk = MessageID(checkout.rawValue)
    let checkoutThread = InboxThread(
      threadId: checkout, project: project("storefront"), threadName: "Checkout redesign",
      messages: [
        message(
          checkout.rawValue, checkout, "storefront", codex, minutesAgo: 14,
          """
          I built three layouts for the checkout page. Two questions before I go further.

          :::question-multi
          Which layouts should I keep building?

          - [ ] One page
          - [ ] Steps on the side
          - [ ] Summary beside
          :::

          :::question-text
          What should the pay button say?

          Recommended: Pay now
          :::
          """,
          questions: [
            question("q_layouts", .multi, "Which layouts should I keep building?", choices: [choice("One page"), choice("Steps on the side"), choice("Summary beside")], message: checkoutAsk),
            question("q_button", .text, "What should the pay button say?", position: 1, suggested: "Pay now", message: checkoutAsk),
          ])
      ])

    let retryAsk = MessageID("msg_STANDIN0000000000000033")
    let retryThread = InboxThread(
      threadId: retry, project: project("api-server"), threadName: "Retry logic for the relay client",
      messages: [
        message(retry.rawValue, retry, "api-server", claude, minutesAgo: 95, "The relay client drops its socket when the laptop sleeps and never comes back. I am adding a retry with a growing wait."),
        message("msg_STANDIN0000000000000032", retry, "api-server", person, minutesAgo: 90, "Cap the wait at a minute, and add some jitter."),
        message(
          retryAsk.rawValue, retry, "api-server", claude, minutesAgo: 60,
          """
          The client now retries a dropped socket with a growing wait, capped at 60 seconds. Two things changed in `relay/client.ts`:

          ```ts
          const wait = Math.min(60_000, 1000 * 2 ** tries)
          await sleep(wait + jitter(250))
          ```

          All 48 tests pass. One choice is yours before I open the pull request.

          :::question
          How should this roll out?

          Hard to undo once phones have the new build.

          - [ ] Staged, 10% first — Slower by a day. A bad retry loop reaches few people.
          - [ ] Everyone at once — Done today. No way to stop it part way.

          Recommended: Staged, 10% first
          :::
          """,
          questions: [
            question(
              "q_rollout", .single, "How should this roll out?", context: "Hard to undo once phones have the new build.",
              choices: [choice("Staged, 10% first", "Slower by a day. A bad retry loop reaches few people.", recommended: true), choice("Everyone at once", "Done today. No way to stop it part way.")],
              holdsUp: ["the pull request"], message: retryAsk)
          ]),
      ])

    let docsThread = InboxThread(
      threadId: docs, project: project("docs-site"), threadName: "Docs search is slow",
      messages: [
        message(docs.rawValue, docs, "docs-site", pi, minutesAgo: 380, "Found it. The index is rebuilt on every request; a fix is on a branch.\n\n- Build the index once at start\n- Rebuild only when a page changes\n- Search drops from 900 ms to 40 ms\n\n```\n┌──────────────────┬──────────┬─────────┬──────────────────────┐\n│ route            │ before   │ after   │ what changed         │\n├──────────────────┼──────────┼─────────┼──────────────────────┤\n│ /search?q=hooks  │ 912 ms   │ 38 ms   │ index built at start │\n│ /search?q=inbox  │ 884 ms   │ 41 ms   │ index built at start │\n│ /search?q=pair   │ 931 ms   │ 44 ms   │ rebuilt on change    │\n└──────────────────┴──────────┴─────────┴──────────────────────┘\n```")
      ])

    let uploadThread = InboxThread(
      threadId: upload, project: project("storefront"), threadName: "Flaky upload test",
      messages: [
        message(upload.rawValue, upload, "storefront", codex, minutesAgo: 1500, "The upload test fails about one run in twenty. It waits on a fixed 200 ms sleep."),
        message(
          "msg_STANDIN0000000000000052", upload, "storefront", person, minutesAgo: 1490, "Wait for the progress event instead of sleeping.",
          delivery: InboxDelivery(state: "queued", host: "codex", session: "ses_store", at: iso(now.addingTimeInterval(-1490 * 60)))),
      ])

    let bumpsThread = InboxThread(
      threadId: bumps, project: project("api-server"), threadName: "Weekly dependency bumps",
      messages: [
        message(bumps.rawValue, bumps, "api-server", claude, minutesAgo: 4400, "Six packages bumped, all minor. Tests pass and the lockfile is committed.")
      ])

    let onboardingAsk = MessageID(onboarding.rawValue)
    var onboardingMessage = message(
      onboarding.rawValue, onboarding, "storefront", agent("gemini", "ses_copy"), minutesAgo: 75,
      """
      The onboarding screens are drafted. One thing only you can do, and one choice.

      :::action
      Add the production analytics key to the team vault
      :::

      :::question
      Which tone for the first screen?

      - [ ] Plain — says what the app does
      - [ ] Warm — greets the person first
      :::
      """,
      questions: [question("q_tone", .single, "Which tone for the first screen?", choices: [choice("Plain", "says what the app does"), choice("Warm", "greets the person first")], message: onboardingAsk)])
    var todo = question("a-0a1b2c3d", .action, "Add the production analytics key to the team vault", position: 0, message: onboardingAsk)
    todo.orphaned = false
    // The door lists an action item among the message's questions (kind "action").
    onboardingMessage.questions = (onboardingMessage.questions ?? []) + [todo]
    let onboardingThread = InboxThread(threadId: onboarding, project: project("storefront"), threadName: "Onboarding copy", messages: [onboardingMessage])

    return [billingThread, checkoutThread, retryThread, docsThread, uploadThread, bumpsThread, onboardingThread]
  }

  public static let permission = ThreadID("msg_STANDIN0000000000000008")

  /// A started agent's permission prompt, as the Inbox writes one (its own `perm:` session).
  public static func permissionThread(now: Date) -> InboxThread {
    let ask = MessageID(permission.rawValue)
    // The body and the choices exactly as the Inbox writes them (`inboxPermissionQuestion`, packages/core/inbox-permission.ts).
    let labels = [PermissionPrompt.allowOnce, "Allow `bun run db:migrate` for this session", PermissionPrompt.deny, PermissionPrompt.auto, PermissionPrompt.full]
    let body = "```\nbun run db:migrate --env staging\n```\n\nPurpose: Apply the billing migration to staging.\n\nin `~/work/api-server`\n\n:::question\nClaude Code wants to run a command\n\n" + labels.map { "- [ ] \($0)" }.joined(separator: "\n") + "\n:::"
    let message = InboxMessageWire(
      questions: [question("q_perm", .single, "Claude Code wants to run a command", choices: labels.map { choice($0) }, stopped: permission.rawValue, message: ask)],
      seq: 900, id: ask, projectId: ProjectID("prj_api-server"), threadId: permission, author: agent("claude-code", "perm:ses_api"), body: body,
      createdAt: iso(now.addingTimeInterval(-200)))
    return InboxThread(threadId: permission, project: project("api-server"), threadName: "Migrate billing tables: permission", messages: [message])
  }

  public static let long = ThreadID("msg_STANDIN0000000000000009")

  /// A long working session, `count` messages: an agent and the person taking turns, paragraphs, lists and code.
  /// One question is still open far up, and the last message asks for an action item and a choice. For measuring
  /// how a long thread opens and scrolls, and for what a lazily built thread must keep (a jump to a card far away, a
  /// reason being typed when the agent writes again).
  public static func longThread(now: Date, count: Int = 300) -> InboxThread {
    let claude = agent("claude-code", "ses_long")
    let bodies = [
      "I read the relay client and the retry tests. The socket closes when the laptop sleeps, and nothing opens it again until the app restarts.",
      "Two things changed in `relay/client.ts`:\n\n- the wait doubles after each failed try, capped at a minute\n- a little jitter keeps phones from all coming back at once",
      "```ts\nconst wait = Math.min(60_000, 1000 * 2 ** tries)\nawait sleep(wait + jitter(250))\n```\n\nThe tests for the cap pass. The jitter test is flaky on CI; I am looking at why.",
      "Found it: the test used the real clock. It uses the fake one now and passed fifty runs in a row.",
    ]
    var messages: [InboxMessageWire] = []
    for index in 0..<max(count - 1, 0) {
      let agentTurn = index % 2 == 0
      let id = MessageID(String(format: "msg_LONG%018d", index))
      var message = InboxMessageWire(
        seq: Int64(1000 + index), id: id, projectId: ProjectID("prj_api-server"), threadId: long, author: agentTurn ? claude : InboxAuthor(kind: .person),
        body: agentTurn ? bodies[(index / 2) % bodies.count] : "Thanks. Keep going, and tell me when the next part is done.",
        createdAt: iso(now.addingTimeInterval(Double(index - count) * 120)))
      // Far up, a question nobody answered yet, under more than a screen of words.
      if index == 2 {
        let notes = (1...6).map { "Place \($0): the flag is read when the socket closes, before the wait is chosen, and the value it holds decides whether the phone tries again at once or waits for the next full minute." }
        message.body = "Before I go on: the old retry flag is still read in a few places.\n\n" + notes.joined(separator: "\n\n") + "\n\n:::question\nKeep the old retry flag?\n\n- [ ] Keep it\n- [ ] Drop it\n:::"
        message.questions = [question("q_flag", .single, "Keep the old retry flag?", choices: [choice("Keep it"), choice("Drop it")], message: id)]
      }
      messages.append(message)
    }
    let ask = MessageID(String(format: "msg_LONG%018d", count))
    var todo = question("a-long0001", .action, "Rotate the relay key on the staging box", position: 0, message: ask)
    todo.orphaned = false
    messages.append(InboxMessageWire(
      questions: [question("q_long", .single, "Ship it today?", choices: [choice("Yes", recommended: true), choice("Tomorrow")], stopped: nil, message: ask), todo],
      seq: Int64(1000 + count), id: ask, projectId: ProjectID("prj_api-server"), threadId: long, author: claude,
      body: "All of it is done and the tests pass.\n\n:::action\nRotate the relay key on the staging box\n:::\n\n:::question\nShip it today?\n\n- [ ] Yes\n- [ ] Tomorrow\n:::", createdAt: iso(now.addingTimeInterval(-60))))
    return InboxThread(threadId: long, project: project("api-server"), threadName: "A long session", messages: messages)
  }

  public static let longPermission = ThreadID("msg_STANDIN0000000000000010")

  /// A started agent's permission session after a long day: `count` prompts already answered, one line each, and
  /// one waiting at the end. For what a lazily built thread must keep (a Deny reason being typed when a second
  /// prompt arrives).
  public static func longPermissionThread(now: Date, count: Int = 200) -> InboxThread {
    let author = agent("claude-code", "perm:ses_day")
    let labels = [PermissionPrompt.allowOnce, PermissionPrompt.deny]
    func prompt(_ index: Int, answered: Bool) -> InboxMessageWire {
      let id = MessageID(String(format: "msg_PERM%018d", index))
      var asked = question("q_day_\(index)", .single, "Claude Code wants to run a command", choices: labels.map { choice($0) }, stopped: answered ? nil : longPermission.rawValue, message: id)
      if answered {
        asked.state = .sent
        asked.answer = QuestionAnswer(v: 1, key: asked.key, kind: .single, prompt: asked.prompt, selected: [PermissionPrompt.allowOnce])
      }
      return InboxMessageWire(
        questions: [asked], seq: Int64(5000 + index), id: id, projectId: ProjectID("prj_api-server"), threadId: longPermission, author: author,
        body: "```\nbun test --filter step-\(index)\n```\n\nPurpose: Run one step's tests.\n\nin `~/work/api-server`\n\n:::question\nClaude Code wants to run a command\n\n" + labels.map { "- [ ] \($0)" }.joined(separator: "\n") + "\n:::",
        createdAt: iso(now.addingTimeInterval(Double(index - count) * 90)))
    }
    let messages = (0..<count).map { prompt($0, answered: true) } + [prompt(count, answered: false)]
    return InboxThread(threadId: longPermission, project: project("api-server"), threadName: "A long day: permission", messages: messages)
  }

  // MARK: The stand-in's own, simple reading of a thread as a row

  static func words(of answer: QuestionAnswer) -> String {
    if answer.skipped == true { return "Skipped" }
    let said = answer.selected + [answer.other, answer.text].compactMap { $0 }
    return said.joined(separator: ", ")
  }

  static func firstLine(_ body: String) -> String {
    var inDirective = false
    for line in body.split(separator: "\n", omittingEmptySubsequences: false) {
      let text = line.trimmingCharacters(in: .whitespaces)
      if text.hasPrefix(":::") {
        inDirective.toggle()
        continue
      }
      if inDirective || text.isEmpty || text.hasPrefix("```") { continue }
      return text.replacingOccurrences(of: "`", with: "")
    }
    return ""
  }

  public static func row(of thread: InboxThread, unread: Bool) -> InboxListRow {
    let messages = thread.messages
    let last = messages.last
    let lastAgent = messages.last { $0.author.kind == .agent }
    let asked: [InboxQuestion] = messages.flatMap { $0.questions ?? [] }.filter { $0.kind != .action }
    let live: [InboxQuestion] = asked.filter { $0.state == .openValue || $0.state == .picked }
    let open: [InboxQuestion] = live.filter { $0.state == .openValue }
    let picked: [InboxQuestion] = live.filter { $0.state == .picked }
    let holdsUp: [String] = live.flatMap { $0.holdsUp }
    let todos: Int = messages.flatMap { ActionMarks.items(of: $0) }.filter { $0.state == .openValue }.count
    let lastIsPerson = last?.author.kind == .person
    let section: InboxSectionId
    if live.contains(where: { $0.stopped != nil }) { section = .stopped }
    else if live.contains(where: { !$0.holdsUp.isEmpty }) { section = .holding }
    else if !live.isEmpty { section = .waiting }
    else if lastIsPerson { section = .sent }
    else if unread { section = .new }
    else { section = .quiet }
    var preview: String?
    if let last {
      if lastIsPerson { preview = "You: \(last.body)" }
      else if let asking = (last.questions ?? []).first(where: { $0.state == .openValue || $0.state == .picked }) { preview = "Asked: \(asking.prompt)" }
      else { preview = firstLine(last.body) }
    }
    return InboxListRow(
      project: InboxListRowProject(id: thread.project.id, name: thread.project.name), threadName: thread.threadName, latestPreview: preview, section: section, unread: unread,
      answeredNotSent: !picked.isEmpty, unsent: picked.isEmpty ? nil : InboxRowUnsent(picks: Double(picked.count), comments: 0), unseen: unread ? 1 : 0, guide: false, threadId: thread.threadId,
      projectId: ProjectID(thread.project.id), subject: thread.subject, author: lastAgent?.author ?? InboxAuthor(kind: .person), createdAt: messages.first?.createdAt ?? "", lastAt: last?.createdAt ?? "",
      lastAuthor: lastIsPerson ? .person : .agent, messageCount: Int64(messages.count),
      questions: InboxQuestionSummary(
        openValue: Double(open.count + todos), picked: Double(picked.count), stopped: live.contains { $0.stopped != nil }, holdsUp: holdsUp, prompt: live.first?.prompt, actions: todos == 0 ? nil : Double(todos)),
      waitingOnPerson: !live.isEmpty)
  }

  public static func list(threads: [InboxThread], unread: Set<ThreadID>, session: String, cursor: Int64, version: String) -> ListModel {
    let rows = threads.map { row(of: $0, unread: unread.contains($0.threadId)) }
    let order: [(InboxListGroupId, InboxSectionId)] = [(.stopped, .stopped), (.holding, .holding), (.waiting, .waiting), (.new, .new), (.sent, .sent), (.quiet, .quiet)]
    let sections = order.map { group, section in
      InboxListSection(id: group, label: Words.sections[section.rawValue] ?? section.rawValue, threads: rows.filter { $0.section == section }.sorted { $0.lastAt > $1.lastAt })
    }
    return ListModel(serverSession: session, version: version, cursor: cursor, projects: [], sections: sections)
  }
}
