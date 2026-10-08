import PlannotatorKit
import SwiftUI

/// 3.6: the person's annotations waiting for the next Send, by file. Tap one
/// to edit it, swipe left to remove it; a file name opens the file there.
struct AnnotationsSheet: View {
    let session: SourceSession
    let threadId: String
    /// The file on screen when opened from an attachment, else nil.
    let current: String?
    /// An edit saved here, for a file on screen to draw.
    var onEdited: (InboxAnnotationRecord) -> Void = { _ in }
    let open: (OpenFile) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var editing: InboxAnnotationRecord?
    @State private var problem: String?

    private var records: [InboxAnnotationRecord] { session.pendingAnnotations(thread: threadId) }
    private var attachments: [InboxAttachmentState] { session.files[threadId]?.attachments ?? [] }

    /// Files in thread order, each with its annotations in the order they were made.
    private var groups: [(attachment: InboxAttachmentState, records: [InboxAnnotationRecord])] {
        attachments.compactMap { attachment in
            let mine = records.filter { $0.attachmentId == attachment.id }.sorted { $0.createdAt < $1.createdAt }
            return mine.isEmpty ? nil : (attachment, mine)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(groups, id: \.attachment.id) { group in
                    Section {
                        ForEach(group.records) { record in
                            Button { editing = record } label: { row(record) }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("annotation-row-\(record.id)")
                                .listRowBackground(Color.card)
                                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                    Button("Remove", systemImage: "trash", role: .destructive) { remove(record) }
                                }
                        }
                    } header: {
                        Button {
                            open(OpenFile(attachmentId: group.attachment.id, sent: group.records.first?.version != "current", focus: group.records.first?.id))
                        } label: {
                            HStack(spacing: 7) {
                                Image(systemName: AttachmentTiles.symbol(group.attachment))
                                Text(group.attachment.name)
                                Image(systemName: "chevron.right").font(.footnote.weight(.semibold))
                            }
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Color.tint)
                            .textCase(nil)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Open \(group.attachment.name) at its first annotation")
                        .accessibilityIdentifier("annotations-file-\(group.attachment.name)")
                    }
                }
                Section {} footer: {
                    Text("Tap one to edit it. Swipe left to remove it. A file name opens the file at that place.")
                        .font(.subheadline)
                        .foregroundStyle(Color.inkSecondary)
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Color.ground)
            .overlay {
                if records.isEmpty {
                    ContentUnavailableView("No annotations", systemImage: "text.bubble", description: Text("Comment on a file and it waits here for your next Send."))
                }
            }
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text(plural(records.count, "annotation")).font(.headline)
                        Text("Ride your next Send").font(.footnote).foregroundStyle(Color.inkSecondary)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("annotations-title")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", systemImage: "checkmark") { dismiss() }
                        .buttonStyle(.glassProminent)
                        .accessibilityIdentifier("annotations-done")
                }
            }
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .sheet(item: $editing) { record in
            EditAnnotationSheet(record: record, save: { text throws(InboxError) in
                try await session.saveAnnotation(thread: threadId, attachment: record.attachmentId, version: record.version, annotation: record.annotation.setting("text", to: .string(text)))
            }, onSaved: onEdited)
        }
        .alert("Something went wrong", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(problem ?? "")
        }
        .accessibilityIdentifier("annotations-sheet")
    }

    private func row(_ record: InboxAnnotationRecord) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(record.tag.map { "\($0) · \"\(record.quote)\"" } ?? "\"\(record.quote)\"")
                .font(.system(.subheadline, design: .monospaced))
                .foregroundStyle(Color.inkSecondary)
                .lineLimit(3)
            Text(record.text).font(.body).foregroundStyle(Color.ink)
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Edits it. Swipe left to remove it.")
    }

    private func remove(_ record: InboxAnnotationRecord) {
        Task {
            do throws(InboxError) {
                try await session.removeAnnotation(thread: threadId, annotation: record.id)
                Haptics.selection()
            } catch { problem = "It was not removed. \(error.message)" }
        }
    }
}

/// Edit a saved comment's words (3.6's tap, 4.3's Edit): same annotation, new words.
struct EditAnnotationSheet: View {
    let record: InboxAnnotationRecord
    let save: (String) async throws(InboxError) -> InboxAnnotationRecord
    var onSaved: (InboxAnnotationRecord) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var saving = false
    @State private var problem: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                QuoteRule(text: record.tag.map { "\($0) · \"\(record.quote)\"" } ?? "\"\(record.quote)\"")
                TextField("Your comment", text: $text, axis: .vertical)
                    .font(.body)
                    .lineLimit(2...10)
                    .focused($focused)
                    .accessibilityIdentifier("edit-comment-text")
                if let problem {
                    Text(problem).font(.footnote).foregroundStyle(Color.destructive)
                }
                Spacer()
            }
            .padding(20)
            .navigationTitle("Edit Comment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { submit() }
                        .buttonStyle(.glassProminent)
                        .disabled(text.trimmed.isEmpty || saving)
                        .accessibilityIdentifier("edit-comment-save")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear {
            text = record.text
            focused = true
        }
    }

    private func submit() {
        saving = true
        Task {
            defer { saving = false }
            do throws(InboxError) {
                onSaved(try await save(text.trimmed))
                dismiss()
            } catch { problem = "Not saved. \(error.message)" }
        }
    }
}

/// A quote as the comment sheets draw it (4.2): monospaced, under an accent rule.
struct QuoteRule: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(.subheadline, design: .monospaced))
            .foregroundStyle(Color.inkSecondary)
            .lineLimit(4)
            .padding(.leading, 12)
            .overlay(alignment: .leading) {
                Rectangle().fill(Color.accent).frame(width: 3)
            }
            .accessibilityLabel("On \(text)")
    }
}
