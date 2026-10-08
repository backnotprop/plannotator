import CryptoKit
import Foundation
import Testing
@testable import PlannotatorKit

// The independent check of the relay's keys and envelope: Swift reads the
// same vectors file TypeScript checks (packages/core/fixtures/inbox-relay-vectors.json,
// packages/core/crypto.test.ts). If either side derives or opens differently,
// a phone cannot read a single push.
@Suite struct RelayVectorsTests {
    struct Vectors: Decodable {
        struct Derived: Decodable { var key: String; var upKey: String; var relaySecret: String; var relaySecretSha256: String }
        struct Envelope: Decodable { var plaintext: String; var envelope: String }
        var pairingSecret: String
        var deviceId: String
        var derived: Derived
        var envelopes: [Envelope]
        var upEnvelopes: [Envelope]
    }

    static let vectors: Vectors = {
        // This file sits at apps/ios/PlannotatorKit/Tests/PlannotatorKitTests/; the repo root is five folders up.
        let root = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../../../..").standardized
        let data = try! Data(contentsOf: root.appending(path: "packages/core/fixtures/inbox-relay-vectors.json"))
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try! decoder.decode(Vectors.self, from: data)
    }()

    @Test func derivesTheKeyAndTheRelaySecret() throws {
        let v = Self.vectors
        let keys = try #require(RelayKeys(secret: v.pairingSecret, device: v.deviceId))
        #expect(keys.key.withUnsafeBytes { Base64URL.encode(Data($0)) } == v.derived.key)
        #expect(keys.upKey.withUnsafeBytes { Base64URL.encode(Data($0)) } == v.derived.upKey)
        #expect(keys.relaySecret == v.derived.relaySecret)
        let hash = SHA256.hash(data: Data(keys.relaySecret.utf8)).map { String(format: "%02x", $0) }.joined()
        #expect(hash == v.derived.relaySecretSha256)
    }

    @Test func opensEveryEnvelope() throws {
        let v = Self.vectors
        let keys = try #require(RelayKeys(secret: v.pairingSecret, device: v.deviceId))
        #expect(v.envelopes.count == 4)
        for envelope in v.envelopes {
            let plaintext = try #require(keys.open(envelope.envelope))
            #expect(String(decoding: plaintext, as: UTF8.self) == envelope.plaintext)
        }
    }

    // A command goes up under the up key: the vector opens under it and not
    // under the down key, and what the phone seals opens the same way.
    @Test func commandsGoUpUnderTheUpKey() throws {
        let v = Self.vectors
        let keys = try #require(RelayKeys(secret: v.pairingSecret, device: v.deviceId))
        for envelope in v.upEnvelopes {
            #expect(String(decoding: try #require(keys.openUp(envelope.envelope)), as: UTF8.self) == envelope.plaintext)
            #expect(keys.open(envelope.envelope) == nil)
        }
        let sealed = try #require(keys.sealUp(Data("{\"v\":1}".utf8)))
        #expect(keys.openUp(sealed).map { String(decoding: $0, as: UTF8.self) } == "{\"v\":1}")
        #expect(keys.open(sealed) == nil)
    }

    // The typed push vector, sealed by TypeScript as the Inbox sends it, opens
    // as a push on the phone and reads as 7.1 and 7.2.
    @Test func theTypedPushVectorOpens() throws {
        let v = Self.vectors
        let push = try #require(v.envelopes.first { $0.plaintext.contains("\"type\":\"push\"") })
        let opened = try #require(PushSummary.open(push.envelope, devices: [("dev_00000000000000000000000001", v.pairingSecret), (v.deviceId, v.pairingSecret)]))
        #expect(opened.device == v.deviceId)
        #expect(opened.summary.title == "Run the retry tests against the test clock?")
        #expect(opened.summary.body == "Claude Code in billing-svc: They take about four minutes.")
        #expect(opened.summary.actions.map(\.label) == ["Yes", "No"])
    }

    @Test func anotherDevicesKeyOpensNothing() throws {
        let v = Self.vectors
        let other = try #require(RelayKeys(secret: v.pairingSecret, device: "dev_00000000000000000000000001"))
        #expect(v.envelopes.allSatisfy { other.open($0.envelope) == nil })
        var tampered = Array(v.envelopes[1].envelope)
        tampered[20] = tampered[20] == "A" ? "B" : "A"
        let keys = try #require(RelayKeys(secret: v.pairingSecret, device: v.deviceId))
        #expect(keys.open(String(tampered)) == nil)
    }

    // The first vector is a push summary from before R2 sealed `type: "push"`
    // inside it: it reads as render 7.1 draws it and its choices become the
    // lock screen's actions, recommended first (7.2), but a push opens only
    // with its type, so the vector itself is refused, as a down item would be.
    @Test func thePushVectorReadsAsTheLockScreen() throws {
        let v = Self.vectors
        let summary = try InboxClient.decoder.decode(PushSummary.self, from: Data(v.envelopes[0].plaintext.utf8))
        #expect(summary.title == "Run the retry tests against the test clock?")
        #expect(summary.body == "Claude Code in billing-svc: They take about four minutes.")
        #expect(summary.actions.map(\.label) == ["Yes", "No"])
        #expect(PushSummary.open(v.envelopes[0].envelope, devices: [(v.deviceId, v.pairingSecret)]) == nil)
        #expect(PushSummary.open(v.envelopes[1].envelope, devices: [(v.deviceId, v.pairingSecret)]) == nil)
    }
}
