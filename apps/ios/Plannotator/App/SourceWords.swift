import Foundation
import PlannotatorKit

/// What the screens say about the shown source, in its own terms: a computer
/// is paired and reached over the tailnet; Workspaces is signed in to.
extension SourceSession {
    var removedTitle: String { isWorkspaces ? "You were signed out" : "This phone was removed" }
    var removedSymbol: String { isWorkspaces ? "person.crop.circle.badge.xmark" : "iphone.slash" }
    var removedHelp: String {
        isWorkspaces ? "Your Workspaces session ended. Sign in again to keep answering." : "It was removed from the Inbox on \(name). Pair it again to keep answering."
    }
    var removedAction: String { isWorkspaces ? "Sign In Again" : "Pair Again" }

    var emptyHelp: String {
        isWorkspaces ? "When an agent asks you something in Workspaces, it shows up here." : "When an agent writes to the Inbox on \(name), it shows up here."
    }

    var unreachableHelp: String {
        isWorkspaces ? "Check your connection, then try again." : "Check that the Inbox is running on your computer and that Tailscale is on."
    }

    var unreadThreadHelp: String { "This thread has not been read on this phone yet. \(unreachableHelp)" }

    var goneHelp: String { isWorkspaces ? "It was deleted in Workspaces." : "It was deleted in the Inbox on \(name)." }

    var changedElsewhere: String {
        isWorkspaces ? "That question changed in Workspaces. Pick again." : "That question changed on your computer. Pick again."
    }

    var sendUnconfirmed: String {
        isWorkspaces
            ? "Workspaces can't be reached, so it is not certain this was sent. Tap Send again; it is sent once either way."
            : InboxError.sendUnconfirmed.message
    }

    /// A Workspaces comment is the team's, so the phone resolves it but never deletes it.
    var canDelete: Bool { !isWorkspaces }
}
