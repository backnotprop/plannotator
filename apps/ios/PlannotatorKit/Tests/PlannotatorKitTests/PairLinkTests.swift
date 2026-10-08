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

    @Test func aFormEncodedNameReadsWithItsSpaces() throws {
        let link = try PairLink.parse("plannotator://pair?v=1&name=Michael%E2%80%99s+MacBook+Pro+%282%29&secret=AAAA&code=482913").get()
        #expect(link.name == "Michael\u{2019}s MacBook Pro (2)")
    }

    // A link that shows one host and dials another must not parse to an address.
    @Test func userInfoInAnAddressIsRefused() {
        #expect(InboxAddress("macbook-pro.tail0000.ts.net:8443@evil.example") == nil)
        #expect(InboxAddress("user:pw@evil.example:443") == nil)
        let link = try? PairLink.parse("plannotator://pair?v=1&name=MacBook&tailnet=macbook-pro.tail0000.ts.net%3A8443%40evil.example&secret=AAAA&code=482913").get()
        #expect(link != nil && link?.tailnet == nil)
        #expect(InboxAddress("box.tail0000.ts.net:8443")?.host == "box.tail0000.ts.net")
    }

    // A percent-encoded @ (what the link's query decode leaves of %2540) must not
    // become a host that dials somewhere else once decoded.
    @Test func aPercentEncodedHostIsRefused() {
        #expect(InboxAddress("macbook-pro.tail0000.ts.net%40evil.example:443") == nil)
        #expect(InboxAddress("evil%2Eexample:443") == nil)
        let link = try? PairLink.parse("plannotator://pair?v=1&name=MacBook&tailnet=macbook-pro.tail0000.ts.net%2540evil.example%3A443&secret=AAAA&code=482913").get()
        #expect(link != nil && link?.tailnet == nil)
    }

    // What is shown and what is dialled are one value, IPv6 literals included.
    @Test func theShownAddressIsTheDialledOne() throws {
        let six = try #require(InboxAddress("[fd7a::1]:8443"))
        #expect(six.hostPort == "[fd7a::1]:8443")
        #expect(six.baseURL.absoluteString == "https://[fd7a::1]:8443")
        let tail = try #require(InboxAddress("box.tail0000.ts.net:8443"))
        #expect(tail.baseURL.host() == "box.tail0000.ts.net" && tail.baseURL.port == 8443)
        #expect(InboxAddress("[::1]:52817")?.baseURL.absoluteString == "http://[::1]:52817")
        #expect(InboxAddress("box.tail0000.ts.net:99999") == nil)
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
