import MessageUI
import SafariServices
import SwiftUI

/// Where a tapped content link opens (row 5120): `https` in Safari View
/// Controller, `mailto` in the mail sheet. Never the system's URL handler.
struct ContentLinkView: View {
    let link: ContentLink

    var body: some View {
        switch link {
        case .web(let url):
            SafariView(url: url).ignoresSafeArea()
        case .mail(let url):
            if MFMailComposeViewController.canSendMail() {
                MailView(url: url).ignoresSafeArea()
            } else {
                NoMailView(address: Self.address(url))
            }
        }
    }

    static func address(_ url: URL) -> String {
        String(url.absoluteString.dropFirst("mailto:".count).prefix { $0 != "?" }).removingPercentEncoding ?? ""
    }
}

struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.dismissButtonStyle = .close
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

/// The mail sheet for a `mailto` link: its address, subject and body.
struct MailView: UIViewControllerRepresentable {
    let url: URL
    @Environment(\.dismiss) private var dismiss

    func makeCoordinator() -> Coordinator { Coordinator(dismiss: dismiss) }

    func makeUIViewController(context: Context) -> MFMailComposeViewController {
        let controller = MFMailComposeViewController()
        controller.mailComposeDelegate = context.coordinator
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let address = ContentLinkView.address(url)
        controller.setToRecipients(address.isEmpty ? [] : address.components(separatedBy: ","))
        if let subject = items.first(where: { $0.name.lowercased() == "subject" })?.value { controller.setSubject(subject) }
        if let body = items.first(where: { $0.name.lowercased() == "body" })?.value { controller.setMessageBody(body, isHTML: false) }
        return controller
    }

    func updateUIViewController(_ controller: MFMailComposeViewController, context: Context) {}

    final class Coordinator: NSObject, MFMailComposeViewControllerDelegate {
        let dismiss: DismissAction
        init(dismiss: DismissAction) { self.dismiss = dismiss }
        func mailComposeController(_ controller: MFMailComposeViewController, didFinishWith result: MFMailComposeResult, error: Error?) {
            dismiss()
        }
    }
}

/// No mail account on this iPhone: the address, to copy.
struct NoMailView: View {
    let address: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("No mail account", systemImage: "envelope")
            } description: {
                Text("Add a mail account in Settings to write to \(address).")
            } actions: {
                Button("Copy Address") {
                    UIPasteboard.general.string = address
                    dismiss()
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close", systemImage: "xmark") { dismiss() } }
            }
        }
        .presentationDetents([.medium])
    }
}
