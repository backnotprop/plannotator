import Foundation
import Testing
@testable import PlannotatorKit

/// A record crosses the app twice (door to surface, surface to door): the
/// annotation inside it must come back exactly as the viewer made it, or a
/// saved mark no longer finds its text.
@Test func annotationRecordRoundTripsUnchanged() throws {
    let json = #"{"id":"ann-1","project_id":"prj_1","thread_id":"msg_1","message_id":"msg_1","attachment_id":"att_1","path":"/p/plan.md","version":"current","annotation":{"id":"ann-1","blockId":"block-7","startOffset":46,"endOffset":88,"type":"COMMENT","text":"","originalText":"at most three times","createdA":1791460320000,"isQuickLabel":false,"htmlAnchor":null,"diagramAnchor":{"kind":"node","id":"E","sourceLine":3},"author_name":"x"},"created_at":"2026-10-08T10:52:00.000Z","updated_at":"2026-10-08T10:52:00.000Z","removed_at":null,"sent_reply_id":null}"#
    let record = try JSONDecoder().decode(InboxAnnotationRecord.self, from: Data(json.utf8))
    #expect(record.tag == "node E")
    let back = try JSONEncoder().encode(record)
    let a = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! NSDictionary
    let b = try JSONSerialization.jsonObject(with: back) as! NSDictionary
    #expect(a == b)
    // Numbers stay numbers and booleans stay booleans, written as the door wrote them.
    let text = String(decoding: back, as: UTF8.self)
    for piece in [#""startOffset":46"#, #""createdA":1791460320000"#, #""isQuickLabel":false"#, #""htmlAnchor":null"#, #""author_name":"x""#] {
        #expect(text.contains(piece), "\(piece) in \(text)")
    }
}
