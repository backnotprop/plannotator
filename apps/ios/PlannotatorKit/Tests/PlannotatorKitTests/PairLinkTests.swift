import Testing
@testable import PlannotatorKit

// The QR link is how a phone first reaches a computer: a misread address or
// secret is a pairing that cannot work, and a newer link must say "update".
@Suite struct PairLinkTests {
    @Test func readsTheContractLink() throws {
        let link = try PairLink.parse("plannotator://pair?v=1&name=MacBook%20Pro&tailnet=macbook-pro.tail0000.ts.net%3A8443&secret=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&code=482913").get()
        #expect(link.name == "MacBook Pro")
        #expect(link.tailnet?.baseURL.absoluteString == "https://macbook-pro.tail0000.ts.net:8443")
        #expect(link.lan == nil)
        #expect(link.code == "482913")
    }

    @Test func anUnknownVersionAsksForAnUpdate() {
        #expect(PairLink.parse("plannotator://pair?v=2&secret=x&code=123456") == .failure(.newerVersion))
        #expect(PairLink.parse("https://example.com") == .failure(.notALink))
    }

    @Test func loopbackSpeaksPlainHTTP() {
        #expect(InboxAddress("127.0.0.1:52817")?.baseURL.absoluteString == "http://127.0.0.1:52817")
        #expect(InboxAddress("https://box.tail0000.ts.net:8443/")?.hostPort == "box.tail0000.ts.net:8443")
        #expect(InboxAddress("not an address") == nil)
    }
}
