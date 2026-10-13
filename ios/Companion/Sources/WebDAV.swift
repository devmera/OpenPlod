import Foundation
import Security

/// Where recordings go: a WebDAV folder, e.g. a Synology shared folder at http://nas:5005/plaud.
struct Destination: Codable, Equatable {
    var url: String
    var username: String
    var password: String

    private static let service = "com.openplod.companion.destination"

    static func load() -> Destination? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(Destination.self, from: data)
    }

    func save() throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service]
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = try JSONEncoder().encode(self)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw CompanionFailure("Could not save the NAS settings.") }
    }
}

/// The few WebDAV calls the companion needs. Files are written under a `.part` name and moved into
/// place, so the Mac never imports a half-written recording.
struct WebDAV {
    let destination: Destination

    private var base: URL {
        get throws {
            guard var components = URLComponents(string: destination.url.trimmingCharacters(in: .whitespaces)), components.host != nil
            else { throw CompanionFailure("Enter the NAS folder address, e.g. http://192.168.1.40:5005/plaud") }
            if !components.path.hasSuffix("/") { components.path += "/" }
            return components.url!
        }
    }

    /// Reaches the folder with these credentials.
    func check() async throws {
        let (_, response) = try await send("PROPFIND", try base, headers: ["Depth": "0"])
        switch response.statusCode {
        case 207, 200: return
        case 401, 403: throw CompanionFailure("The NAS refused the user name or password (\(response.statusCode)).")
        case 404: throw CompanionFailure("The folder was not found on the NAS. Check the address and that the shared folder exists.")
        default: throw CompanionFailure("The NAS answered \(response.statusCode); is WebDAV enabled on this port?")
        }
    }

    /// Uploads a local file as `name` and confirms the NAS holds all of it.
    func upload(file: URL, as name: String) async throws {
        let size = try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int ?? -1
        let target = try base.appending(path: name), partial = try base.appending(path: "\(name).part")
        var request = try authorized(URLRequest(url: partial, timeoutInterval: 300))
        request.httpMethod = "PUT"
        let (_, put) = try await URLSession.shared.upload(for: request, fromFile: file)
        try expect(put, [200, 201, 204], "Uploading \(name)")
        let (_, moved) = try await send("MOVE", partial, headers: ["Destination": target.absoluteString, "Overwrite": "T"])
        try expect(moved, [201, 204], "Finishing \(name)")
        let (body, found) = try await send("PROPFIND", target, headers: ["Depth": "0"])
        try expect(found, [207], "Checking \(name)")
        let reported = String(decoding: body, as: UTF8.self).firstMatch(of: /getcontentlength>\s*(\d+)\s*</)?.1
        guard let reported, Int(reported) == size else { throw CompanionFailure("The NAS does not hold all of \(name) yet.") }
    }

    /// Downloads `name` from the folder to `file`.
    func download(_ name: String, to file: URL) async throws {
        let request = try authorized(URLRequest(url: try base.appending(path: name), timeoutInterval: 120))
        let (temporary, response) = try await URLSession.shared.download(for: request)
        try expect(response, [200], "Fetching \(name)")
        try? FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: temporary, to: file)
    }

    private func authorized(_ request: URLRequest) throws -> URLRequest {
        var request = request
        let credentials = Data("\(destination.username):\(destination.password)".utf8).base64EncodedString()
        request.setValue("Basic \(credentials)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func send(_ method: String, _ url: URL, headers: [String: String] = [:]) async throws -> (Data, HTTPURLResponse) {
        var request = try authorized(URLRequest(url: url, timeoutInterval: 30))
        request.httpMethod = method
        headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw CompanionFailure("The NAS sent no HTTP answer.") }
        return (data, http)
    }

    private func expect(_ response: URLResponse, _ codes: [Int], _ step: String) throws {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard codes.contains(status) else { throw CompanionFailure("\(step) failed: the NAS answered \(status).") }
    }
}
