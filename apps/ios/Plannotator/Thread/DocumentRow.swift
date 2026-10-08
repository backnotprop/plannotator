import PlannotatorKit
import SwiftUI

/// A Workspaces thread's document: the workspace, the file and the passage the
/// comment is pinned to. A tap opens the document's text, drawn natively.
struct DocumentRow: View {
    let document: InboxThreadDocument
    let client: WorkspacesClient

    var body: some View {
        NavigationLink {
            DocumentScreen(document: document, client: client)
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    Image(systemName: "doc.text")
                        .font(.body.weight(.medium))
                        .foregroundStyle(Color.inkSecondary)
                        .frame(width: 34, height: 34)
                        .background(Color.fill, in: .rect(cornerRadius: 9))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(document.path ?? "Document").font(.callout.weight(.semibold)).foregroundStyle(Color.ink)
                        if let name = document.workspaceName {
                            Text(name).font(.footnote).foregroundStyle(Color.inkSecondary)
                        }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
                if let quote = document.quote, !quote.trimmed.isEmpty {
                    HStack(spacing: 10) {
                        RoundedRectangle(cornerRadius: 1.5).fill(Color.tint.opacity(0.6)).frame(width: 3)
                        Text(quote).font(.subheadline).foregroundStyle(Color.inkSecondary).lineLimit(3)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(12)
            .background(Color.questionCard, in: .rect(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.hairline))
            .contentShape(.rect(cornerRadius: 18))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the document")
        .accessibilityIdentifier("document-row")
    }
}

/// The document's text as it is now. Markdown is drawn with the thread's own
/// blocks; any other kind says where to read it.
struct DocumentScreen: View {
    let document: InboxThreadDocument
    let client: WorkspacesClient
    @State private var text: String?
    @State private var problem: String?

    private var isMarkdown: Bool { (document.path ?? "").lowercased().hasSuffix(".md") }

    var body: some View {
        Group {
            if !isMarkdown {
                ContentUnavailableView("Read it in Workspaces", systemImage: "doc", description: Text("This phone draws Markdown documents. Open \(document.path ?? "this document") in Workspaces on your computer."))
            } else if let text {
                ScrollView {
                    VStack(alignment: .leading, spacing: 13) {
                        ForEach(Array(MessageBlock.parse(text).enumerated()), id: \.offset) { _, block in
                            MarkdownBlockView(block: block)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .refreshable { await load() }
            } else if let problem {
                ContentUnavailableView {
                    Label("Can't open the document", systemImage: "wifi.slash")
                } description: {
                    Text(problem)
                } actions: {
                    Button("Try Again") { Task { await load() } }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color.screen)
        .navigationTitle(document.path ?? "Document")
        .navigationBarTitleDisplayMode(.inline)
        .task { if isMarkdown { await load() } }
    }

    private func load() async {
        do throws(InboxError) {
            text = try await client.documentText(workspace: document.workspaceId, document: document.documentId)
            problem = nil
        } catch {
            problem = error.message
        }
    }
}
