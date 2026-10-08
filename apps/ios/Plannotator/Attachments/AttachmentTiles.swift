import PlannotatorKit
import SwiftUI

/// Where an attachment opens: the file, which version, and an annotation to scroll to.
struct OpenFile: Identifiable, Hashable {
    var attachmentId: String
    var sent = false
    var focus: String?
    var id: String { "\(attachmentId)|\(sent)|\(focus ?? "")" }
}

/// The files at the foot of a message (3.4A): a tile per file with its kind and
/// annotation count, or the changed line when the file on disk is no longer what
/// was sent; and the guided review the message carries (8.1). A tap opens it
/// full screen.
struct AttachmentTiles: View {
    let attachments: [InboxAttachmentState]
    var guide: InboxGuideRef?
    let annotations: [InboxAnnotationRecord]
    let open: (OpenFile) -> Void
    var openGuide: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(plural(attachments.count + (guide == nil ? 0 : 1), "attachment"), systemImage: "paperclip")
                .font(.callout)
                .foregroundStyle(Color.inkSecondary)
            if let guide {
                Button(action: openGuide) {
                    row(symbol: "book", tinted: true, name: "Guided review: \(guide.title)", detail: Self.detail(guide), warn: false)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("guide-tile")
                .accessibilityHint("Opens the guided review")
            }
            ForEach(attachments) { attachment in
                Button { open(OpenFile(attachmentId: attachment.id)) } label: { tile(attachment) }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("attachment-\(attachment.name)")
            }
        }
        .padding(.top, 4)
        // The surface (20 MB) starts loading while the person reads, so a file opens at once.
        .task { SurfaceHost.shared.warm() }
    }

    private func tile(_ attachment: InboxAttachmentState) -> some View {
        let count = annotations.filter { $0.attachmentId == attachment.id }.count
        let detail = Self.detail(attachment, count: count)
        return row(symbol: Self.symbol(attachment), tinted: false, name: attachment.name, detail: detail.text, warn: detail.changed)
            .accessibilityHint("Opens the file")
    }

    /// One tile: the mark, the name, the second line, the chevron. A guide's mark is tinted (8.1).
    private func row(symbol: String, tinted: Bool, name: String, detail: String, warn: Bool) -> some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(tinted ? Color.tint : Color.inkSecondary)
                .frame(width: 48, height: 48)
                .background(tinted ? Color.tint.opacity(0.13) : Color.fill, in: .rect(cornerRadius: 12))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.body.weight(.semibold)).foregroundStyle(Color.ink)
                Text(detail).font(.subheadline).foregroundStyle(warn ? Color.warning : Color.inkSecondary)
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color.inkSecondary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.questionCard, in: .rect(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Color.hairline))
        .contentShape(.rect(cornerRadius: 20))
        .accessibilityElement(children: .combine)
    }

    /// A guide's second line, as 8.1 draws it: "4 sections, 6 files, +212 −38".
    static func detail(_ guide: InboxGuideRef) -> String {
        "\(plural(guide.sections, "section")), \(plural(guide.files, "file")), +\(guide.additions) −\(guide.deletions)"
    }

    /// The tile's second line, as the record draws it (3.4A).
    static func detail(_ attachment: InboxAttachmentState, count: Int) -> (text: String, changed: Bool) {
        let annotations = count > 0 ? " · \(plural(count, "annotation"))" : ""
        if let unavailable = attachment.unavailable {
            return (unavailable.code == "attachment_missing" ? "No longer on disk; the sent version opens" : "Changed type; the sent version opens", true)
        }
        if attachment.changedSinceSent { return ("Changed since it was sent\(annotations)", true) }
        return ("\(attachment.kindLabel)\(annotations)", false)
    }

    static func symbol(_ attachment: InboxAttachmentState) -> String {
        if attachment.isHTML { return "chevron.left.forwardslash.chevron.right" }
        if attachment.isDiagram { return "flowchart" }
        return "doc.text"
    }
}
