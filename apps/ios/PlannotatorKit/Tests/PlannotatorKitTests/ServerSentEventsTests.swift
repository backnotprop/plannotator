import Testing
@testable import PlannotatorKit

// The stream is how the list stays live; a record held back until the next
// one arrives is a question that shows up late.
@Suite struct ServerSentEventsTests {
    @Test func aRecordIsDeliveredAtItsBlankLine() {
        var parser = ServerSentEvents()
        let lines = ["retry: 2000", "event: hello", #"data: {"serverSession":"s","cursor":1288}"#, "",
                     "id: 1289", "event: record", #"data: {"seq":1289,"kind":"question","id":"m/q"}"#, "", ": ping"]
        let events = lines.compactMap { parser.feed($0) }
        #expect(events == [.hello(cursor: 1288), .record(seq: 1289, kind: "question")])
    }
}
