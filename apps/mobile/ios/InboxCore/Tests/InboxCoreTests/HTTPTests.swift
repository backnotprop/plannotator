import Foundation
import XCTest
@testable import InboxCore
import InboxStandIn
import InboxWire

/// Answers URLSession's requests from the stand-in door, so the bytes HTTPTransport really sends are what is read.
final class StandInProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var door: StandInDoor?
  nonisolated(unsafe) static var requests: [URLRequest] = []
  static let lock = NSLock()

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}

  override func startLoading() {
    let request = self.request
    Self.lock.withLock { Self.requests.append(request) }
    var body: Data?
    if let stream = request.httpBodyStream {
      stream.open()
      var data = Data()
      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let read = stream.read(&buffer, maxLength: buffer.count)
        if read <= 0 { break }
        data.append(buffer, count: read)
      }
      stream.close()
      body = data
    } else {
      body = request.httpBody
    }
    let url = request.url!
    let path = String(url.path(percentEncoded: true).dropFirst(Door.prefix.count))
    let call = DoorCall(
      method: DoorMethod(rawValue: request.httpMethod ?? "GET") ?? .get, path: path, query: URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [],
      headers: request.allHTTPHeaderFields ?? [:], body: body)
    let loading = Loading(client: self.client, me: self)
    let work = Work(loading: loading, door: StandInProtocol.lock.withLock { StandInProtocol.door }, call: call, url: url)
    Task.detached { await work.run() }
  }

  struct Loading: @unchecked Sendable {
    let client: URLProtocolClient?
    let me: URLProtocol
  }

  struct Work: Sendable {
    let loading: Loading
    let door: StandInDoor?
    let call: DoorCall
    let url: URL
    func run() async {
    do {
      guard url.path.hasPrefix(Door.prefix), let door else { throw URLError(.badURL) }
      let answer = try await door.handle(call)
      let response = HTTPURLResponse(url: url, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: answer.headers)!
      loading.client?.urlProtocol(loading.me, didReceive: response, cacheStoragePolicy: .notAllowed)
      loading.client?.urlProtocol(loading.me, didLoad: answer.body)
      loading.client?.urlProtocolDidFinishLoading(loading.me)
    } catch {
      loading.client?.urlProtocol(loading.me, didFailWithError: error)
    }
    }
  }
}

final class HTTPTests: XCTestCase {
  override func tearDown() {
    StandInProtocol.door = nil
    StandInProtocol.lock.withLock { StandInProtocol.requests = [] }
  }

  func testWhatGoesOnTheWireIsTheDoorsOwnForm() async throws {
    let door = StandInDoor()
    StandInProtocol.door = door
    let transport = try XCTUnwrap(HTTPTransport(address: .tailnet(hostPort: "work-mac.example.ts.net:8443"), protocols: [StandInProtocol.self]))
    let paired = try await DoorClient(transport: transport, token: nil, app: testApp).pair(secret: await door.options.secret, deviceName: "iPhone")
    let client = DoorClient(transport: transport, token: paired.token, app: testApp)
    let health = try await client.health()
    XCTAssertTrue(health.skew.offers(DoorRoutes.postMessageReply))
    XCTAssertEqual(health.health?.version, "0.29.3")
    let thread = try await client.thread(StandInData.retry)
    let asked = try XCTUnwrap(thread.thread.messages.last)
    let question = try XCTUnwrap(asked.questions?.first)
    let answer = try await client.picks(asked.id, body: QuestionAnswers.pickBody(key: question.key, revision: question.revision, answer: QuestionAnswers.choice(question, selected: ["Everyone at once"], note: ""), idempotencyKey: "key-http-1"))
    XCTAssertEqual(answer.questions.first?.state, .picked)

    let requests = StandInProtocol.lock.withLock { StandInProtocol.requests }
    XCTAssertEqual(requests.map { "\($0.httpMethod ?? "") \($0.url?.absoluteString ?? "")" }, [
      "POST https://work-mac.example.ts.net:8443/api/inbox/device/pair",
      "GET https://work-mac.example.ts.net:8443/api/inbox/device/health",
      "GET https://work-mac.example.ts.net:8443/api/inbox/device/threads/\(StandInData.retry.rawValue)",
      "POST https://work-mac.example.ts.net:8443/api/inbox/device/messages/\(asked.id.rawValue)/picks",
    ])
    for request in requests {
      XCTAssertEqual(request.value(forHTTPHeaderField: "X-Plannotator-App"), "ios 0.1.0 contract \(wireContract)")
      XCTAssertNil(request.value(forHTTPHeaderField: "Origin"), "any Origin is refused by the door")
      XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
    }
    XCTAssertNil(requests[0].value(forHTTPHeaderField: "Authorization"), "pairing takes no token")
    XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Authorization"), "Bearer \(paired.token)")
    let posted = await door.posts("/picks")
    XCTAssertEqual(body(posted[0])["idempotency_key"], .string("key-http-1"))
  }

  func testA426IsReadAsTheAppNeedingAnUpdateAndARepeatedKeyIsAReplay() async throws {
    let door = StandInDoor()
    StandInProtocol.door = door
    let transport = try XCTUnwrap(HTTPTransport(address: .tailnet(hostPort: "work-mac.example.ts.net:8443"), protocols: [StandInProtocol.self]))
    let issued = await door.issueToken()
    let client = DoorClient(transport: transport, token: issued.token, app: testApp)

    // The answer was lost on its way back: the same body under the same key is applied once and replayed.
    let read = try await client.thread(StandInData.retry)
    let question = try XCTUnwrap(read.thread.messages.last?.questions?.first)
    let body = try JSONEncoder().encode(QuestionAnswers.pickBody(key: question.key, revision: 0, answer: QuestionAnswers.choice(question, selected: ["Everyone at once"], note: ""), idempotencyKey: "key-http-2"))
    let path = Door.postMessagePicks(message: question.messageId).path
    let first = try await client.resend(method: .post, path: path, body: body)
    let second = try await client.resend(method: .post, path: path, body: body)
    XCTAssertNil(first.headers["idempotent-replayed"])
    XCTAssertEqual(second.headers["idempotent-replayed"], "true")
    XCTAssertEqual(second.body, first.body)
    let revision = await door.thread(StandInData.retry)?.messages.last?.questions?.first?.revision
    XCTAssertEqual(revision, 1)

    await door.setOptions { $0.minAppContract = wireContract + 1 }
    do {
      _ = try await client.threads()
      XCTFail("refused below the floor")
    } catch let failure as DoorFailure {
      guard case .appNeedsUpdate(let floor) = failure else { return XCTFail("\(failure)") }
      XCTAssertEqual(floor, wireContract + 1)
    }
    // health still answers, so the app can learn the floor.
    let health = try await client.health()
    XCTAssertEqual(health.skew, .appNeedsUpdate(contract: 1, minAppContract: wireContract + 1))
  }
}
