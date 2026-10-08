import PlannotatorKit
import SwiftUI

struct ThreadRoute: Hashable {
    var id: String
}

/// The Inbox tab: the list (2.1B) under the large title with the source
/// under it, or the first run (1.1) when nothing is paired.
struct InboxTab: View {
    @Environment(AppModel.self) private var model
    @State private var path: [ThreadRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let session = model.session {
                    InboxList(session: session, path: $path)
                } else {
                    FirstRun()
                }
            }
            .navigationTitle("Inbox")
            .navigationSubtitle(subtitle)
            .toolbarTitleMenu { SourceMenu() }
            .navigationDestination(for: ThreadRoute.self) { route in
                if let session = model.session { ThreadScreen(session: session, threadId: route.id) }
            }
        }
        .onChange(of: model.session?.source.id) { path = [] }
    }

    private var subtitle: Text {
        guard let session = model.session else { return Text("No source yet") }
        switch session.status {
        case .unreachable: return Text("\(session.source.name) · Not reachable")
        case .removed: return Text("\(session.source.name) · Removed")
        default: return Text(session.source.name)
        }
    }
}

/// The title's menu (1.5A): each paired computer, and Add a source.
struct SourceMenu: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ForEach(model.sources) { source in
            Button {
                model.show(source)
            } label: {
                if model.active?.id == source.id {
                    Label(source.name, systemImage: "checkmark")
                } else {
                    Text(source.name)
                }
            }
        }
        Button("Add a source", systemImage: "plus") { model.pairing = true }
    }
}

/// 1.1: nothing connected yet.
struct FirstRun: View {
    @Environment(AppModel.self) private var model
    @ScaledMetric(relativeTo: .largeTitle) private var mark: CGFloat = 84

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Image("Tater")
                    .resizable()
                    .scaledToFit()
                    .frame(height: mark)
                    .padding(.top, 40)
                    .padding(.bottom, 14)
                    .accessibilityHidden(true)
                Text("Nothing connected yet")
                    .font(.title2.bold())
                    .multilineTextAlignment(.center)
                Text("Connect the Inbox on your computer.")
                    .font(.body)
                    .foregroundStyle(Color.inkSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 36)
                    .padding(.top, 6)
                    .padding(.bottom, 22)
                Button {
                    model.pairing = true
                } label: {
                    HStack(spacing: 13) {
                        Image("Tater")
                            .resizable()
                            .scaledToFit()
                            .padding(.top, 6)
                            .frame(width: 44, height: 44, alignment: .bottom)
                            .background(Color.fill, in: .rect(cornerRadius: 12))
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Your computer's Inbox").font(.body.weight(.semibold)).foregroundStyle(Color.ink)
                            Text("Scan the code it shows, or find it nearby").font(.footnote).foregroundStyle(Color.inkSecondary)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                    }
                    .multilineTextAlignment(.leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 15)
                    .background(Color.raised, in: .rect(cornerRadius: 24))
                    .contentShape(.rect(cornerRadius: 24))
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 16)
                .accessibilityIdentifier("connect-computer")
            }
            .frame(maxWidth: .infinity)
        }
        .background(Color.screen)
    }
}
