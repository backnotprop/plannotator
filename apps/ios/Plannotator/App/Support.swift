import PlannotatorKit
import SwiftUI
import UIKit

// MARK: Colours (generated from packages/ui/themes/plannotator.css; see scripts/gen-colors.ts)

extension Color {
    static let tint = Color("Tint")
    static let onTint = Color("OnTint")
    static let ground = Color("Ground")
    static let card = Color("Card")
    static let ink = Color("Ink")
    static let inkSecondary = Color("InkSecondary")
    static let fill = Color("Fill")
    static let hairline = Color("Hairline")
    static let success = Color("Success")
    /// The changed line (4.1) and a changed file's tile (3.4A).
    static let warning = Color("Warning")
    /// Plannotator's annotation accent: a comment's mark and its quote rule (4.2, 4.3).
    static let accent = Color("Accent")
    static let destructive = Color("Destructive")
    static let questionCard = Color("QuestionCard")
    /// A plain screen: white in light, the theme's ground in dark.
    static let screen = Color("Screen")
    /// A row raised on a plain screen: grey in light, the card in dark.
    static let raised = Color("Raised")
}

// MARK: Haptics, named per action (BRIEF.md section 4), off when the person turns them off

enum Haptics {
    static var enabled: Bool { UserDefaults.standard.object(forKey: "haptics") as? Bool ?? true }

    /// A pick, Accept recommended, a segment.
    static func selection() {
        guard enabled else { return }
        UISelectionFeedbackGenerator().selectionChanged()
    }

    /// Send delivered, pairing done.
    static func success() {
        guard enabled else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    /// Send failed, a pairing code refused.
    static func error() {
        guard enabled else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.error)
    }
}

// MARK: Times, as the desktop Inbox writes them (packages/inbox/format.ts)

enum When {
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoPlain = ISO8601DateFormatter()

    static func date(_ text: String?) -> Date? {
        guard let text else { return nil }
        return iso.date(from: text) ?? isoPlain.date(from: text)
    }

    /// "10:42 AM".
    static func clock(_ text: String?) -> String {
        date(text)?.formatted(date: .omitted, time: .shortened) ?? ""
    }

    /// "10:42 AM" today, "Oct 3" before.
    static func short(_ text: String?) -> String {
        guard let date = date(text) else { return "" }
        return Calendar.current.isDateInToday(date)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.month(.abbreviated).day())
    }

    /// "Oct 7, 10:02 AM".
    static func dayAndTime(_ date: Date) -> String {
        "\(date.formatted(.dateTime.month(.abbreviated).day())), \(date.formatted(date: .omitted, time: .shortened))"
    }
}

func plural(_ n: Int, _ one: String, _ many: String? = nil) -> String {
    "\(n) \(n == 1 ? one : (many ?? one + "s"))"
}

// MARK: Agent marks (the record's assets/agents, from Plannotator's repo)

struct AgentMark: View {
    var author: InboxAuthor
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 20

    var body: some View {
        Group {
            if !author.isAgent {
                Image(systemName: "person.crop.circle.fill").resizable().foregroundStyle(Color.inkSecondary)
            } else if let asset = Self.asset(for: author.host) {
                Image(asset).resizable()
            } else {
                Image(systemName: "sparkle").resizable().foregroundStyle(Color.inkSecondary).padding(2)
            }
        }
        .scaledToFit()
        // Grows with the text, but no wider than a list row's mark can sit.
        .frame(width: min(size, 32), height: min(size, 32))
        .accessibilityHidden(true)
    }

    static func asset(for host: String?) -> String? {
        switch host {
        case "claude-code", "claude": "AgentClaude"
        case "codex": "AgentCodex"
        case "opencode": "AgentOpenCode"
        case "pi": "AgentPi"
        default: nil
        }
    }
}

/// The record's laptop tile (1.3, 9.1, 9.2).
struct ComputerTile: View {
    var size: CGFloat = 30
    var body: some View {
        Image(systemName: "laptopcomputer")
            .font(.system(size: size * 0.5, weight: .medium))
            .foregroundStyle(Color.inkSecondary)
            .frame(width: size, height: size)
            .background(Color.fill, in: .rect(cornerRadius: size * 0.27))
            .accessibilityHidden(true)
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// Inline markdown (emphasis, links, code) as an attributed string; plain text when it does not parse.
///
/// Agent text is content: only https and mailto links stay tappable. Any other
/// scheme, `plannotator://` above all, is drawn as plain text, so a message can
/// never reach the app's own URL handler (a pairing link in a message would
/// otherwise pair the phone with whatever host it names).
func inlineMarkdown(_ text: String) -> AttributedString {
    var string = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    for run in string.runs {
        guard let url = run.link else { continue }
        if !["https", "mailto"].contains(url.scheme?.lowercased() ?? "") { string[run.range].link = nil }
    }
    return string
}
