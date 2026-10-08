import PlannotatorKit
import SwiftUI

/// One markdown block of a message, drawn natively in the system face.
struct MarkdownBlockView: View {
    let block: MessageBlock

    var body: some View {
        switch block {
        case .heading(let level, let text):
            Text(inlineMarkdown(text))
                .font(level == 1 ? .title2.bold() : level == 2 ? .title3.weight(.semibold) : .headline)
                .foregroundStyle(Color.ink)
                .padding(.top, 4)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let text):
            Text(inlineMarkdown(text))
                .font(.body)
                .lineSpacing(3)
                .foregroundStyle(Color.ink)
        case .list(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(item.marker).foregroundStyle(Color.tint).monospacedDigit()
                        Text(inlineMarkdown(item.text)).foregroundStyle(Color.ink)
                    }
                    .padding(.leading, CGFloat(item.depth) * 18)
                }
            }
            .font(.body)
        case .quote(let text):
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 1.5).fill(Color.hairline).frame(width: 3)
                Text(inlineMarkdown(text)).font(.body).foregroundStyle(Color.inkSecondary)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .code(_, let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.callout.monospaced())
                    .foregroundStyle(Color.ink)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
            }
            .background(Color.fill, in: .rect(cornerRadius: 12))
        case .rule:
            Divider()
        case .rich(let kind):
            RichBlockRow(kind: kind)
        case .question:
            EmptyView()
        }
    }
}

/// A block the phone does not draw natively yet: a table, a diagram, math or
/// raw HTML. The surface (S1) will open it in place; until then this row says
/// what it is and where to read it.
struct RichBlockRow: View {
    let kind: MessageBlock.RichKind

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.body.weight(.medium))
                .foregroundStyle(Color.inkSecondary)
                .frame(width: 42, height: 42)
                .background(Color.fill, in: .rect(cornerRadius: 11))
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.callout.weight(.semibold)).foregroundStyle(Color.ink)
                Text("Read it in the Inbox on your computer.").font(.footnote).foregroundStyle(Color.inkSecondary)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Color.questionCard, in: .rect(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.hairline))
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        switch kind {
        case .table: "Table"
        case .diagram: "Diagram"
        case .math: "Math"
        case .html: "HTML"
        }
    }

    private var symbol: String {
        switch kind {
        case .table: "tablecells"
        case .diagram: "point.3.connected.trianglepath.dotted"
        case .math: "function"
        case .html: "chevron.left.forwardslash.chevron.right"
        }
    }
}
