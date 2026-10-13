import CryptoKit
import Foundation
import Security
import UIKit

/// The pairing QR shown in OpenPlod (Settings → Android): the Mac's address and pairing token.
struct Pairing: Decodable {
    let type: String
    let origin: String
    let token: String

    static func parse(_ text: String) throws -> Pairing {
        guard let data = text.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
              let pairing = try? JSONDecoder().decode(Pairing.self, from: data), pairing.type == "openplod-pairing",
              URL(string: pairing.origin)?.host != nil, !pairing.token.isEmpty
        else { throw CompanionFailure("That is not an OpenPlod pairing code.") }
        return pairing
    }
}

/// OpenPlod's phone authorization: this phone sends a fresh RSA public key, you approve its
/// 6-character code on the Mac, and the Mac returns the recorder key encrypted to that key
/// (AES-256-GCM, the AES key wrapped with RSA-OAEP-SHA1). Nothing readable crosses the network.
final class Enrollment {
    struct Request: Decodable { let id: String; let code: String; let expiresAt: Double; let state: String }
    private struct Envelope: Decodable { let iv: String; let wrappedKey: String; let ciphertext: String }
    private struct Pending: Decodable { let state: String; let envelope: Envelope? }
    private struct Delivered: Decodable { let serial, bindingToken, signature, privateKey: String }
    private struct Reply<T: Decodable>: Decodable { let success: Bool; let data: T?; let error: String? }
    private struct Ignored: Decodable { init(from decoder: Decoder) throws {} }

    private let pairing: Pairing
    private let privateKey: SecKey

    init(pairing: Pairing) throws {
        self.pairing = pairing
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey([kSecAttrKeyType as String: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits as String: 2048] as CFDictionary, &error)
        else { throw CompanionFailure("Could not create a phone key: \(error!.takeRetainedValue().localizedDescription)") }
        privateKey = key
    }

    /// Starts the request; show `code` and approve it on the Mac.
    func start() async throws -> Request {
        let name = await UIDevice.current.name
        return try await call("POST", "", body: ["publicKey": try subjectPublicKeyInfo().base64EncodedString(), "name": name])
    }

    /// Waits for approval, then decrypts the recorder key.
    func waitForKey(_ request: Request) async throws -> RecorderKey {
        while true {
            try Task.checkCancellation()
            let pending: Pending = try await call("GET", "/\(request.id)")
            if let envelope = pending.envelope {
                let key = try open(envelope, requestId: request.id)
                _ = try? await call("POST", "/\(request.id)/acknowledge") as Ignored
                return key
            }
            try await Task.sleep(for: .seconds(2))
        }
    }

    private func open(_ envelope: Envelope, requestId: String) throws -> RecorderKey {
        guard let wrapped = Data(base64Encoded: envelope.wrappedKey), let iv = Data(base64Encoded: envelope.iv),
              let sealed = Data(base64Encoded: envelope.ciphertext), sealed.count > 16 else { throw CompanionFailure("The Mac sent an unreadable key.") }
        var error: Unmanaged<CFError>?
        guard let aesKey = SecKeyCreateDecryptedData(privateKey, .rsaEncryptionOAEPSHA1, wrapped as CFData, &error) as Data?
        else { throw CompanionFailure("This phone could not unwrap the key.") }
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: sealed.dropLast(16), tag: sealed.suffix(16))
        let plain = try AES.GCM.open(box, using: SymmetricKey(data: aesKey), authenticating: Data(requestId.utf8))
        let delivered = try JSONDecoder().decode(Delivered.self, from: plain)
        return RecorderKey(serial: delivered.serial, bindingToken: delivered.bindingToken, signature: delivered.signature, privateKey: delivered.privateKey)
    }

    /// The public key as DER SubjectPublicKeyInfo, which OpenPlod expects; iOS exports bare PKCS#1.
    private func subjectPublicKeyInfo() throws -> Data {
        guard let publicKey = SecKeyCopyPublicKey(privateKey), let pkcs1 = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?
        else { throw CompanionFailure("Could not export the phone key.") }
        let rsa2048Header: [UInt8] = [0x30, 0x82, 0x01, 0x22, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d,
                                      0x01, 0x01, 0x01, 0x05, 0x00, 0x03, 0x82, 0x01, 0x0f, 0x00]
        return Data(rsa2048Header) + pkcs1
    }

    private func call<T: Decodable>(_ method: String, _ path: String, body: [String: String]? = nil) async throws -> T {
        guard let url = URL(string: "\(pairing.origin)/api/plaud/authorizations\(path)") else { throw CompanionFailure("Invalid OpenPlod address.") }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = method
        request.setValue(pairing.token, forHTTPHeaderField: "X-OpenPlod-Token")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, _) = try await URLSession.shared.data(for: request)
        let reply = try JSONDecoder().decode(Reply<T>.self, from: data)
        guard reply.success, let value = reply.data else { throw CompanionFailure(reply.error ?? "OpenPlod refused the request.") }
        return value
    }
}
